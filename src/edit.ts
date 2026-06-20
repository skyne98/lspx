// WorkspaceEdit application — the ONE path in lspx that mutates files on disk.
//
// Extracted from cli.ts so it can be unit-tested in isolation: the offset
// math and end-of-document-first ordering are exactly the kind of thing a
// silent regression would corrupt a user's codebase with, so they deserve
// direct coverage rather than being buried inside a CLI command handler.
//
// The IO layer (read/write) is injected, so tests run against an in-memory
// map without touching the real filesystem.

import { readFileSync, writeFileSync } from "node:fs";
import { uriToPath } from "./lsp/client.ts";

export interface LspPosition {
  line: number;
  character: number;
}

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

export interface TextEdit {
  range: LspRange;
  newText: string;
}

/** Filesystem surface the apply logic needs. Inject a fake in tests. */
export interface EditIO {
  read(path: string): string;
  write(path: string, text: string): void;
}

/** Real-filesystem IO (the default for the CLI). */
export const defaultIO: EditIO = {
  read: (p) => readFileSync(p, "utf-8"),
  write: (p, t) => writeFileSync(p, t),
};

export interface ApplyResult {
  files: number;
  edits: number;
  fileOps: number;
  /** Absolute paths of files whose text was written (for server re-sync). */
  paths: string[];
}

/** 0-indexed LSP position → string offset in `text`. LSP positions count
 *  UTF-16 code units; for the common ASCII identifier case this matches
 *  string indexing exactly. Lines are counted by scanning for '\n'; a
 *  position past the end of the document clamps to the end, and a character
 *  past end-of-line clamps to the line's length. */
export function posToOffset(text: string, pos: LspPosition): number {
  let offset = 0;
  for (let i = 0; i < pos.line; i++) {
    const nl = text.indexOf("\n", offset);
    if (nl === -1) return text.length;
    offset = nl + 1;
  }
  return Math.min(offset + pos.character, text.length);
}

/** Apply a `WorkspaceEdit` (either `changes` or `documentChanges` form, or
 *  both) to disk via `io`. Text edits within a file are applied
 *  end-of-document-first (sort ascending by start, then reverse) so earlier
 *  edits' offsets are not shifted by later ones — this lets us apply in place
 *  without re-deriving ranges. File operations (create/rename/delete) are
 *  counted but NOT performed (lspx edits text, it is not a file manager).
 *  Returns counts for a summary line + the list of touched paths so the
 *  caller can re-sync the language server's in-memory text afterward. */
export function applyWorkspaceEdit(edit: unknown, io: EditIO = defaultIO): ApplyResult {
  const e = edit as {
    changes?: Record<string, TextEdit[]>;
    documentChanges?: unknown[];
  } | null;
  if (!e) return { files: 0, edits: 0, fileOps: 0, paths: [] };

  const byPath = new Map<string, TextEdit[]>();
  let fileOps = 0;
  const collect = (uri: string, edits: TextEdit[]) => {
    const path = uriToPath(uri);
    const arr = byPath.get(path) ?? [];
    arr.push(...edits);
    byPath.set(path, arr);
  };
  if (e.changes) {
    for (const [uri, edits] of Object.entries(e.changes)) collect(uri, edits);
  }
  if (e.documentChanges) {
    for (const ch of e.documentChanges) {
      if (ch && typeof ch === "object" && "textDocument" in ch && "edits" in ch) {
        const tde = ch as { textDocument: { uri: string }; edits: TextEdit[] };
        collect(tde.textDocument.uri, tde.edits);
      } else if (ch && typeof ch === "object" && "kind" in ch) {
        // CreateFile / RenameFile / DeleteFile — counted, not performed.
        fileOps++;
      }
    }
  }

  let files = 0;
  let edits = 0;
  const paths: string[] = [];
  for (const [path, edits_] of byPath) {
    const orig = io.read(path);
    // Sort ascending by start position, then reverse → apply from end of
    // document backward so earlier ranges stay valid.
    const sorted = [...edits_].sort(
      (a, b) =>
        a.range.start.line - b.range.start.line ||
        a.range.start.character - b.range.start.character,
    ).reverse();
    let text = orig;
    for (const te of sorted) {
      const start = posToOffset(text, te.range.start);
      const end = posToOffset(text, te.range.end);
      text = text.slice(0, start) + te.newText + text.slice(end);
    }
    io.write(path, text);
    paths.push(path);
    files++;
    edits += edits_.length;
  }
  return { files, edits, fileOps, paths };
}
