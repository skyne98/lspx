// WorkspaceEditTransaction — the validated, rollback-safe mutation path.
//
// `applyWorkspaceEdit` (in edit.ts) is retained as a small compatibility
// primitive and for isolated offset tests. Production semantic mutations,
// including rename, use this transaction engine, which:
//   1. validates every edit's staleness precondition (expected text / digest),
//   2. rejects overlapping edits within a file,
//   3. stages all resulting file contents in memory before any write,
//   4. applies with rollback (restores originals if any write fails),
//   5. reports before/after digests so callers can re-sync + verify.
//
// A stale or overlapping edit aborts the ENTIRE transaction — lspx never
// applies a partial batch. This is the engine behind `replace-symbol` and the
// pi `batch_edit` / `replace_symbols` tools.

import { posToOffset, type EditIO, type LspRange, type TextEdit } from "./edit.ts";
import { hashContent } from "./lsp/symbol.ts";

export interface PlannedEdit {
  /** Absolute filesystem path. */
  path: string;
  /** 0-indexed LSP range to replace. */
  range: LspRange;
  /** Replacement text. */
  newText: string;
  /** Optional staleness guard: text currently expected at `range`. If the
   *  disk text no longer matches, the edit is rejected (stale-target). */
  expectedText?: string;
  /** Optional sha256 digest of `expectedText`. Either or both may be set. */
  expectedHash?: string;
  /** Optional human label (e.g. the symbol name) for the plan/diff. */
  label?: string;
}

export interface RejectedEdit {
  path: string;
  label?: string;
  reason: string;
  code: "stale-target" | "overlapping-edits";
}

export interface StagedFile {
  path: string;
  original: string;
  staged: string;
  edits: number;
}

export interface TransactionResult {
  files: number;
  edits: number;
  paths: string[];
  beforeHashes: Record<string, string>;
  afterHashes: Record<string, string>;
  rolledBack: boolean;
}

export interface TransactionPlan {
  staged: StagedFile[];
  rejected: RejectedEdit[];
  /** True if any precondition failed — the transaction must not be applied. */
  aborted: boolean;
}

export class WorkspaceEditTransaction {
  private byPath = new Map<string, PlannedEdit[]>();
  private plan: TransactionPlan | null = null;

  constructor(private edits: PlannedEdit[], private io: EditIO) {}

  /** Group edits by path (deterministic order: path asc, then start asc). */
  private normalize(): Map<string, PlannedEdit[]> {
    const byPath = new Map<string, PlannedEdit[]>();
    for (const e of this.edits) {
      const arr = byPath.get(e.path) ?? [];
      arr.push(e);
      byPath.set(e.path, arr);
    }
    for (const arr of byPath.values()) {
      arr.sort(
        (a, b) =>
          a.range.start.line - b.range.start.line ||
          a.range.start.character - b.range.start.character,
      );
    }
    return byPath;
  }

  /** Validate staleness + overlaps. Builds the plan but does NOT touch disk
   *  beyond reading current text. Returns the plan; sets `aborted` if any
   *  edit is stale or overlapping. */
  validate(): TransactionPlan {
    const byPath = this.normalize();
    const staged: StagedFile[] = [];
    const rejected: RejectedEdit[] = [];

    for (const [path, edits] of byPath) {
      let original: string;
      try {
        original = this.io.read(path);
      } catch {
        rejected.push({ path, reason: `cannot read ${path}`, code: "stale-target" });
        continue;
      }

      // Overlap check: sorted ascending by start; ranges overlap if the
      // next start is strictly before the previous end.
      for (let i = 1; i < edits.length; i++) {
        const prev = edits[i - 1].range;
        const cur = edits[i].range;
        if (
          cur.start.line < prev.end.line ||
          (cur.start.line === prev.end.line && cur.start.character < prev.end.character)
        ) {
          rejected.push({
            path,
            label: edits[i].label,
            reason: `edit at ${cur.start.line}:${cur.start.character} overlaps a preceding edit at ${prev.start.line}:${prev.start.character}`,
            code: "overlapping-edits",
          });
        }
      }

      // Staleness check: the text currently at each edit's range must match
      // the expected text/digest recorded when the edit was planned.
      for (const e of edits) {
        if (e.expectedText === undefined && e.expectedHash === undefined) continue;
        const current = sliceRange(original, e.range);
        if (e.expectedHash !== undefined && hashContent(current) !== e.expectedHash) {
          rejected.push({
            path: e.path,
            label: e.label,
            reason: `expected hash ${e.expectedHash} but found ${hashContent(current)} at ${e.range.start.line}:${e.range.start.character}`,
            code: "stale-target",
          });
          continue;
        }
        if (e.expectedText !== undefined && current !== e.expectedText) {
          rejected.push({
            path: e.path,
            label: e.label,
            reason: `expected text no longer matches at ${e.range.start.line}:${e.range.start.character}`,
            code: "stale-target",
          });
        }
      }

      // Stage all edits for a valid transaction. Rejected plans are never
      // exposed as dry-runs or applied, so attempting to infer edit identity
      // from non-unique human labels would only make this staging misleading.
      const text = applyEditsToEndFirst(original, edits);
      staged.push({ path, original, staged: text, edits: edits.length });
    }

    const aborted = rejected.length > 0;
    this.plan = { staged, rejected, aborted };
    return this.plan;
  }

  /** Apply the staged edits to disk with rollback. Refuses if `validate()`
   *  found any precondition failure. Returns counts + digests. */
  apply(): TransactionResult {
    const plan = this.plan ?? this.validate();
    const result: TransactionResult = {
      files: 0,
      edits: 0,
      paths: [],
      beforeHashes: {},
      afterHashes: {},
      rolledBack: false,
    };
    if (plan.aborted) return result;

    const written: { path: string; original: string }[] = [];
    try {
      for (const f of plan.staged) {
        result.beforeHashes[f.path] = hashContent(f.original);
        // Re-read immediately before each write. If an editor changed a file
        // after validate(), abort and roll back files already written instead
        // of overwriting the newer content with a stale staged snapshot.
        if (this.io.read(f.path) !== f.original) {
          throw new Error(`stale-target: ${f.path} changed after validation`);
        }
        if (f.staged !== f.original) {
          // Record before writing so a write that partially modifies a file
          // and then throws is itself included in rollback.
          written.push({ path: f.path, original: f.original });
          this.io.write(f.path, f.staged);
        }
        result.afterHashes[f.path] = hashContent(f.staged);
        result.paths.push(f.path);
        result.files++;
        result.edits += f.edits;
      }
    } catch (err) {
      // Roll back every file written so far.
      result.rolledBack = true;
      for (const w of written) {
        try {
          this.io.write(w.path, w.original);
        } catch {
          /* best-effort rollback — the original is preserved in `beforeHashes` */
        }
      }
      throw err;
    }
    return result;
  }
}

/** Slice the text covered by an LSP range (mirrors edit.ts / symbol.ts). */
function sliceRange(text: string, range: LspRange): string {
  const start = posToOffset(text, range.start);
  const end = posToOffset(text, range.end);
  return text.slice(start, end);
}

/** Apply edits end-of-document-first so earlier ranges stay valid.
 *  Pure: returns the new text without touching IO. */
function applyEditsToEndFirst(text: string, edits: PlannedEdit[]): string {
  const sorted = [...edits].sort(
    (a, b) =>
      a.range.start.line - b.range.start.line ||
      a.range.start.character - b.range.start.character,
  ).reverse();
  let out = text;
  for (const e of sorted) {
    const start = posToOffset(out, e.range.start);
    const end = posToOffset(out, e.range.end);
    out = out.slice(0, start) + e.newText + out.slice(end);
  }
  return out;
}

/** Build PlannedEdit[] from a raw LSP WorkspaceEdit (changes + documentChanges),
 *  for transactions that validate a server-computed edit before applying. */
export function plannedEditsFromWorkspaceEdit(
  edit: unknown,
  io: EditIO,
): PlannedEdit[] {
  const e = edit as {
    changes?: Record<string, TextEdit[]>;
    documentChanges?: unknown[];
  } | null;
  if (!e) return [];
  const out: PlannedEdit[] = [];
  const collect = (uri: string, edits: TextEdit[]) => {
    const path = uriToPathLocal(uri);
    for (const te of edits) {
      let expectedText: string | undefined;
      try {
        expectedText = sliceRange(io.read(path), te.range);
      } catch {
        expectedText = undefined;
      }
      out.push({
        path,
        range: te.range,
        newText: te.newText,
        expectedText,
        expectedHash: expectedText !== undefined ? hashContent(expectedText) : undefined,
      });
    }
  };
  if (e.changes) {
    for (const [uri, edits] of Object.entries(e.changes)) collect(uri, edits);
  }
  if (e.documentChanges) {
    for (const ch of e.documentChanges) {
      if (ch && typeof ch === "object" && "textDocument" in ch && "edits" in ch) {
        const tde = ch as { textDocument: { uri: string }; edits: TextEdit[] };
        collect(tde.textDocument.uri, tde.edits);
      }
      // Create/Rename/Delete file ops are not text edits — not planned here.
    }
  }
  return out;
}

function uriToPathLocal(uri: string): string {
  if (!uri.startsWith("file:")) return uri;
  try {
    const u = new URL(uri);
    return decodeURIComponent(u.pathname);
  } catch {
    return uri.slice("file://".length);
  }
}
