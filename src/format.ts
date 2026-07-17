// Compact, agent-friendly formatting of LSP results.
//
// Design principles (copied from agent-browser's output philosophy):
//  - Human mode: terse, scannable, one finding per line, colorized.
//  - JSON mode (--json): the raw LSP result, lightly normalized (URIs ->
//    filesystem paths) so agents don't have to parse file:// URIs.
//  - Snippets ON by default: every location carries the source code at its
//    span, so an agent never round-trips a read_file just to see what's
//    there. Disable with --no-snippet (e.g. for huge ref lists).
// Positions are rendered 1-indexed (line:col), matching editors.

import * as lsp from "vscode-languageserver-protocol";
import { URI } from "vscode-uri";
import { relative } from "node:path";
import { c } from "./color.ts";
import { symbolKindLabel, severityLabel } from "./lsp/types.ts";
import { readSnippet, type Snippet } from "./snippet.ts";

export interface FormatOpts {
  workspaceRoot: string;
  json: boolean;
  /** Include source snippets at each location. Default: true. */
  snippet?: boolean;
}

function wantSnippet(o: FormatOpts): boolean {
  return o.snippet !== false;
}

// ---- Locations (defs / decl / typedef / impl / refs) ----

/** Normalize any location-ish LSP result to a flat list of {file,line:col}. */
export interface FlatLoc {
  file: string;
  line: number; // 1-indexed
  col: number; // 1-indexed
  endLine: number;
  endCol: number;
  /** For LocationLink: the origin range, if present. */
  origin?: { line: number; col: number };
  /** Exact matched text for a single-line span (the symbol token). */
  match?: string;
  /** Source lines covering [line, endLine]; null if unreadable. */
  snippet?: { lines: { n: number; t: string }[]; truncated: boolean };
}

type LocResult = lsp.Location | lsp.LocationLink[] | lsp.Location[] | null;

function uriToAbs(uri: string): string {
  return URI.parse(uri).fsPath;
}
function toRel(abs: string, ws: string): string {
  const r = relative(ws, abs);
  return r && !r.startsWith("..") ? r : abs;
}

function toFlat(v: LocResult, o: FormatOpts): FlatLoc[] {
  if (!v) return [];
  const arr = Array.isArray(v) ? v : [v];
  const ws = o.workspaceRoot;
  const withSnip = wantSnippet(o);
  const out: FlatLoc[] = [];
  for (const item of arr) {
    const loc = item as lsp.Location | lsp.LocationLink;
    const uri = (loc as lsp.Location).uri ?? (loc as lsp.LocationLink).targetUri;
    const range = (loc as lsp.Location).range ?? (loc as lsp.LocationLink).targetSelectionRange;
    const targetRange = (loc as lsp.LocationLink).targetRange ?? range;
    const origin = (loc as lsp.LocationLink).originSelectionRange;
    const line = range.start.line + 1;
    const col = range.start.character + 1;
    const endLine = targetRange.end.line + 1;
    const endCol = targetRange.end.character + 1;
    const abs = uriToAbs(uri);
    const f: FlatLoc = {
      file: toRel(abs, ws),
      line,
      col,
      endLine,
      endCol,
      origin: origin
        ? { line: origin.start.line + 1, col: origin.start.character + 1 }
        : undefined,
    };
    if (withSnip) {
      const snip: Snippet | null = readSnippet(abs, line, endLine);
      if (snip) {
        f.snippet = snip;
        if (line === endLine) {
          const t = snip.lines[0]?.t ?? "";
          f.match = t.slice(col - 1, endCol - 1) || undefined;
        }
      }
    }
    out.push(f);
  }
  return out;
}

export function formatLocations(v: LocResult, o: FormatOpts): string {
  const flat = toFlat(v, o);
  if (o.json) return JSON.stringify(flat, null, 2);
  if (flat.length === 0) return c.dim("(no results)");
  return flat
    .map((f) => {
      const loc = `${c.cyan(f.file)}:${c.bold(String(f.line))}:${f.col}`;
      const span =
        f.endLine !== f.line || f.endCol !== f.col
          ? c.dim(`→ ${f.endLine}:${f.endCol}`)
          : "";
      const head = `${loc} ${span}`.trimEnd();
      const body = f.snippet
        ? "\n" + renderSnippetHuman(f.snippet, f.col, f.endCol, f.line === f.endLine)
        : "";
      return head + body;
    })
    .join("\n");
}

/** Render a snippet with a line-number gutter. For single-line spans, add a
 *  `^` underline marking the exact matched token. */
function renderSnippetHuman(
  snip: Snippet,
  col: number,
  endCol: number,
  single: boolean,
): string {
  const maxN = Math.max(...snip.lines.map((l) => l.n));
  const w = String(maxN).length;
  const prefix = (n: number) => `  ${String(n).padStart(w)} │ `;
  const blank = " ".repeat(2 + w + 3);
  const out: string[] = [];
  for (const { n, t } of snip.lines) out.push(`${c.dim(prefix(n))}${t}`);
  if (single && snip.lines.length > 0) {
    const n = Math.max(0, endCol - col);
    out.push(
      `${c.dim(blank)}${" ".repeat(Math.max(0, col - 1))}${c.yellow("^".repeat(n))}`,
    );
  }
  if (snip.truncated) out.push(`${c.dim(blank)}… (truncated)`);
  return out.join("\n");
}

// ---- Call hierarchy (callers / callees) ----

/** Each call result: the enclosing function (caller for incoming, callee
 *  for outgoing) plus the call sites where the call happens. */
export interface FlatCall {
  /** Direction of this query. */
  direction: "incoming" | "outgoing";
  /** The enclosing function name. */
  name: string;
  kind: string;
  detail?: string;
  file: string;
  line: number;
  col: number;
  endLine: number;
  endCol: number;
  match?: string;
  snippet?: { lines: { n: number; t: string }[]; truncated: boolean };
  /** Where the call happens (one per fromRange). */
  sites: FlatLoc[];
}

interface CallHierarchyResult {
  queriedFile: string;
  calls: lsp.CallHierarchyIncomingCall[] | lsp.CallHierarchyOutgoingCall[] | null;
}

function toFlatCalls(
  v: CallHierarchyResult,
  direction: "incoming" | "outgoing",
  o: FormatOpts,
): FlatCall[] {
  if (!v.calls) return [];
  const ws = o.workspaceRoot;
  const withSnip = wantSnippet(o);
  const out: FlatCall[] = [];
  for (const call of v.calls) {
    const item =
      direction === "incoming"
        ? (call as lsp.CallHierarchyIncomingCall).from
        : (call as lsp.CallHierarchyOutgoingCall).to;
    const abs = uriToAbs(item.uri);
    // Call sites live in the caller's document (incoming) or the queried
    // document (outgoing).
    const siteAbs = direction === "incoming" ? abs : v.queriedFile;
    const sel = item.selectionRange;
    const line = sel.start.line + 1;
    const col = sel.start.character + 1;
    const endLine = sel.end.line + 1;
    const endCol = sel.end.character + 1;
    const fc: FlatCall = {
      direction,
      name: item.name,
      kind: symbolKindLabel(item.kind),
      detail: item.detail,
      file: toRel(abs, ws),
      line,
      col,
      endLine,
      endCol,
      sites: [],
    };
    if (withSnip) {
      const snip = readSnippet(abs, line, endLine);
      if (snip) {
        fc.snippet = snip;
        if (line === endLine) {
          const t = snip.lines[0]?.t ?? "";
          fc.match = t.slice(col - 1, endCol - 1) || undefined;
        }
      }
    }
    for (const r of call.fromRanges) {
      const sl = r.start.line + 1;
      const sc = r.start.character + 1;
      const sel2 = r.end.line + 1;
      const sec = r.end.character + 1;
      const site: FlatLoc = {
        file: toRel(siteAbs, ws),
        line: sl,
        col: sc,
        endLine: sel2,
        endCol: sec,
      };
      if (withSnip) {
        const snip = readSnippet(siteAbs, sl, sel2);
        if (snip) {
          site.snippet = snip;
          if (sl === sel2) {
            const t = snip.lines[0]?.t ?? "";
            site.match = t.slice(sc - 1, sec - 1) || undefined;
          }
        }
      }
      fc.sites.push(site);
    }
    out.push(fc);
  }
  return out;
}

export function formatCallHierarchy(
  v: unknown,
  direction: "incoming" | "outgoing",
  o: FormatOpts,
): string {
  const flat = toFlatCalls(v as CallHierarchyResult, direction, o);
  if (o.json) return JSON.stringify(flat, null, 2);
  if (flat.length === 0) return c.dim("(no results)");
  return flat.map((call) => renderCall(call)).join("\n");
}

/** Render one call: the enclosing function (with its decl snippet) followed
 *  by each call site (location + underline). Direction shows as ←/→. */
function renderCall(call: FlatCall): string {
  const head =
    `${c.gray(call.kind)} ${c.bold(call.name)} ` +
    c.dim(`${call.file}:${call.line}:${call.col}`);
  const decl = call.snippet
    ? "\n" + renderSnippetHuman(call.snippet, call.col, call.endCol, call.line === call.endLine)
    : "";
  const arrow = call.direction === "incoming" ? "←" : "→";
  const label = call.direction === "incoming" ? "called from" : "calls";
  const sites = call.sites.length > 0
    ? `\n  ${c.dim(`${arrow} ${label}:`)}\n` +
      call.sites
        .map((s) => {
          const loc = `    ${c.cyan(s.file)}:${c.bold(String(s.line))}:${s.col}`;
          const span =
            s.endLine !== s.line || s.endCol !== s.col
              ? " " + c.dim(`→ ${s.endLine}:${s.endCol}`)
              : "";
          const body = s.snippet
            ? "\n" + indentSnippet(renderSnippetHuman(s.snippet, s.col, s.endCol, s.line === s.endLine), 4)
            : "";
          return `${loc}${span}`.trimEnd() + body;
        })
        .join("\n")
    : "";
  return head + decl + sites;
}

/** Indent every line of a rendered snippet block by `n` spaces. */
function indentSnippet(block: string, n: number): string {
  const pad = " ".repeat(n);
  return block
    .split("\n")
    .map((l) => (l.length ? pad + l : l))
    .join("\n");
}

// ---- Type hierarchy (supertypes / subtypes) ----

export interface FlatTypeItem {
  /** Direction of this query. */
  direction: "super" | "sub";
  name: string;
  kind: string;
  detail?: string;
  file: string;
  line: number;
  col: number;
  endLine: number;
  endCol: number;
  match?: string;
  snippet?: { lines: { n: number; t: string }[]; truncated: boolean };
}

export function formatTypeHierarchy(
  v: unknown,
  direction: "super" | "sub",
  o: FormatOpts,
): string {
  const items = (v as lsp.TypeHierarchyItem[] | null) ?? [];
  const ws = o.workspaceRoot;
  const withSnip = wantSnippet(o);
  const flat: FlatTypeItem[] = items.map((item) => {
    const abs = uriToAbs(item.uri);
    const sel = item.selectionRange;
    const line = sel.start.line + 1;
    const col = sel.start.character + 1;
    const endLine = sel.end.line + 1;
    const endCol = sel.end.character + 1;
    const f: FlatTypeItem = {
      direction,
      name: item.name,
      kind: symbolKindLabel(item.kind),
      detail: item.detail,
      file: toRel(abs, ws),
      line,
      col,
      endLine,
      endCol,
    };
    if (withSnip) {
      const snip = readSnippet(abs, line, endLine);
      if (snip) {
        f.snippet = snip;
        if (line === endLine) {
          const t = snip.lines[0]?.t ?? "";
          f.match = t.slice(col - 1, endCol - 1) || undefined;
        }
      }
    }
    return f;
  });
  if (o.json) return JSON.stringify(flat, null, 2);
  if (flat.length === 0) return c.dim("(no results)");
  const arrow = direction === "super" ? "↑" : "↓";
  const label = direction === "super" ? "inherits from" : "inherited by";
  return flat
    .map((f) => {
      const head = `${c.gray(f.kind)} ${c.bold(f.name)} ${c.dim(`${f.file}:${f.line}:${f.col}`)}`;
      const body = f.snippet
        ? "\n" + renderSnippetHuman(f.snippet, f.col, f.endCol, f.line === f.endLine)
        : "";
      return `${c.dim(`${arrow} ${label}:`)}\n${head}${body}`;
    })
    .join("\n");
}

// ---- Diagnostics ----

export interface FlatDiagnostic {
  file: string;
  line: number;
  col: number;
  endLine: number;
  endCol: number;
  severity: string;
  message: string;
  code?: number | string;
  source?: string;
  match?: string;
  snippet?: { lines: { n: number; t: string }[]; truncated: boolean };
}

interface DiagnosticsResult {
  file: string;
  diagnostics: lsp.Diagnostic[] | null;
}

export function formatDiagnostics(v: unknown, o: FormatOpts): string {
  const res = v as DiagnosticsResult;
  const diags = res.diagnostics ?? [];
  const ws = o.workspaceRoot;
  const withSnip = wantSnippet(o);
  const abs = res.file;
  const file = toRel(abs, ws);
  const flat: FlatDiagnostic[] = diags.map((d) => {
    const line = d.range.start.line + 1;
    const col = d.range.start.character + 1;
    const endLine = d.range.end.line + 1;
    const endCol = d.range.end.character + 1;
    const f: FlatDiagnostic = {
      file,
      line,
      col,
      endLine,
      endCol,
      severity: severityLabel(d.severity),
      message: typeof d.message === "string" ? d.message : (d.message?.value ?? ""),
      code: d.code as number | string | undefined,
      source: d.source,
    };
    if (withSnip) {
      const snip = readSnippet(abs, line, endLine);
      if (snip) {
        f.snippet = snip;
        if (line === endLine) {
          const t = snip.lines[0]?.t ?? "";
          f.match = t.slice(col - 1, endCol - 1) || undefined;
        }
      }
    }
    return f;
  });
  if (o.json) return JSON.stringify(flat, null, 2);
  if (flat.length === 0) return c.green("✓ no diagnostics");
  // Group by severity for scannability: errors first, then warnings, etc.
  const order = ["error", "warn", "info", "hint", "diag"];
  const sorted = [...flat].sort(
    (a, b) => order.indexOf(a.severity) - order.indexOf(b.severity),
  );
  const counts: Record<string, number> = {};
  for (const d of sorted) counts[d.severity] = (counts[d.severity] ?? 0) + 1;
  const summary = Object.entries(counts)
    .map(([k, n]) => `${severityColor(k)(`${n} ${k}${n === 1 ? "" : "s"}`)}`)
    .join(c.dim(", "));
  return (
    `${c.dim(`${file}:`)} ${summary}\n` +
    sorted
      .map((d) => {
        const sev = severityColor(d.severity)(d.severity.padEnd(5));
        const loc = `${c.cyan(d.file)}:${c.bold(String(d.line))}:${d.col}`;
        const src = d.source ? c.dim(` [${d.source}]`) : "";
        const head = `  ${sev} ${loc}${src} ${d.message}`;
        const body = d.snippet
          ? "\n" + renderSnippetHuman(d.snippet, d.col, d.endCol, d.line === d.endLine)
          : "";
        return head + body;
      })
      .join("\n")
  );
}

/** Pick a color for a severity label (used in human diagnostics output). */
function severityColor(sev: string): (s: string) => string {
  switch (sev) {
    case "error": return c.red;
    case "warn": return c.yellow;
    case "info": return c.blue;
    case "hint": return c.gray;
    default: return c.dim;
  }
}

// ---- Multi-hop call hierarchy (callers/callees --depth) ----

interface RawTreeNode {
  item: lsp.CallHierarchyItem;
  sites: lsp.Range[];
  siteUri: string;
  children: RawTreeNode[];
  cyclic: boolean;
}

export interface FlatCallTree {
  name: string;
  kind: string;
  detail?: string;
  file: string;
  line: number;
  col: number;
  endLine: number;
  endCol: number;
  match?: string;
  snippet?: { lines: { n: number; t: string }[]; truncated: boolean };
  sites: FlatLoc[];
  children: FlatCallTree[];
  cyclic?: boolean;
}

function normalizeTreeNode(
  node: RawTreeNode,
  o: FormatOpts,
): FlatCallTree {
  const ws = o.workspaceRoot;
  const withSnip = wantSnippet(o);
  const item = node.item;
  const abs = uriToAbs(item.uri);
  const sel = item.selectionRange;
  const line = sel.start.line + 1;
  const col = sel.start.character + 1;
  const endLine = sel.end.line + 1;
  const endCol = sel.end.character + 1;
  const flat: FlatCallTree = {
    name: item.name,
    kind: symbolKindLabel(item.kind),
    detail: item.detail,
    file: toRel(abs, ws),
    line,
    col,
    endLine,
    endCol,
    sites: [],
    children: [],
    cyclic: node.cyclic || undefined,
  };
  if (withSnip) {
    const snip = readSnippet(abs, line, endLine);
    if (snip) {
      flat.snippet = snip;
      if (line === endLine) {
        const t = snip.lines[0]?.t ?? "";
        flat.match = t.slice(col - 1, endCol - 1) || undefined;
      }
    }
  }
  // Sites (edge to parent) — live in node.siteUri's document.
  if (node.sites.length > 0 && node.siteUri) {
    const siteAbs = uriToAbs(node.siteUri);
    for (const r of node.sites) {
      const sl = r.start.line + 1;
      const sc = r.start.character + 1;
      const sel2 = r.end.line + 1;
      const sec = r.end.character + 1;
      const site: FlatLoc = {
        file: toRel(siteAbs, ws),
        line: sl,
        col: sc,
        endLine: sel2,
        endCol: sec,
      };
      if (withSnip) {
        const snip = readSnippet(siteAbs, sl, sel2);
        if (snip) {
          site.snippet = snip;
          if (sl === sel2) {
            const t = snip.lines[0]?.t ?? "";
            site.match = t.slice(sc - 1, sec - 1) || undefined;
          }
        }
      }
      flat.sites.push(site);
    }
  }
  for (const child of node.children) {
    flat.children.push(normalizeTreeNode(child, o));
  }
  return flat;
}

export function formatCallHierarchyTree(
  v: unknown,
  direction: "incoming" | "outgoing",
  o: FormatOpts,
): string {
  const res = v as { queriedFile: string; roots: RawTreeNode[] };
  const flat = (res.roots ?? []).map((r) => normalizeTreeNode(r, o));
  if (o.json) return JSON.stringify(flat, null, 2);
  if (flat.length === 0) return c.dim("(no results)");
  return flat.map((root, i) => renderTreeRoot(root, direction, o, i > 0)).join("\n");
}

/** Render the call-hierarchy tree with box-drawing branches. Root gets its
 *  full decl snippet; each child shows its decl line + the call-site location
 *  (the edge to its parent). ↻ marks a node already expanded elsewhere
 *  (dedup bounds the output on cyclic call graphs). */
function renderTreeRoot(
  root: FlatCallTree,
  direction: "incoming" | "outgoing",
  o: FormatOpts,
  withSeparator: boolean,
): string {
  const arrow = direction === "incoming" ? "←" : "→";
  const sep = withSeparator ? "\n" : "";
  return sep + renderTreeNode(root, "", true, true, arrow, o);
}

function renderTreeNode(
  node: FlatCallTree,
  prefix: string,
  isLast: boolean,
  isRoot: boolean,
  arrow: string,
  o: FormatOpts,
): string {
  const branch = isRoot ? "" : isLast ? "└── " : "├── ";
  const cont = isRoot ? "" : isLast ? "    " : "│   ";
  const arrowPfx = isRoot ? "" : `${arrow} `;
  const cyclic = node.cyclic ? ` ${c.magenta("↻ (already shown)")}` : "";
  const head =
    `${prefix}${branch}${arrowPfx}` +
    `${c.gray(node.kind)} ${c.bold(node.name)} ` +
    c.dim(`${node.file}:${node.line}:${node.col}`) + cyclic;
  const lines: string[] = [head];
  if (node.snippet) {
    if (isRoot) {
      // Root: full decl snippet with underline.
      lines.push(prefix + renderSnippetHuman(node.snippet, node.col, node.endCol, node.line === node.endLine));
    } else {
      // Child: just the decl source line (compact).
      const w = String(Math.max(...node.snippet.lines.map((l) => l.n))).length;
      const l0 = node.snippet.lines[0];
      if (l0) lines.push(`${prefix}${cont}${c.dim(`  ${String(l0.n).padStart(w)} │ `)}${l0.t}`);
    }
  }
  // Edge to parent: show the call-site location (first site; +N if more).
  if (!isRoot && node.sites.length > 0) {
    const s = node.sites[0];
    const more = node.sites.length > 1 ? c.dim(` (+${node.sites.length - 1})`) : "";
    lines.push(`${prefix}${cont}${c.dim(`${arrow} @ ${s.file}:${s.line}:${s.col}`)}${more}`);
  }
  const childPrefix = prefix + cont;
  node.children.forEach((child, i) => {
    lines.push(renderTreeNode(child, childPrefix, i === node.children.length - 1, false, arrow, o));
  });
  return lines.join("\n");
}

// ---- Rename (workspace edits) ----

export interface FlatRenameEdit {
  file: string;
  line: number;
  col: number;
  endLine: number;
  endCol: number;
  newText: string;
  match?: string;
  snippet?: { lines: { n: number; t: string }[]; truncated: boolean };
}

export interface FlatRenameResult {
  file: string;
  newName: string;
  placeholder?: string;
  /** Edits grouped by file. */
  edits: { file: string; edits: FlatRenameEdit[] }[];
  /** File ops (create/rename/delete) the server requested — rare for rename.
   *  Surfaced so the agent knows lspx did NOT apply these (write support is
   *  text-only); --apply only touches existing files' contents. */
  fileOps?: { kind: "create" | "rename" | "delete"; uri?: string; newUri?: string }[];
}

interface RenameResult {
  file: string;
  newName: string;
  placeholder?: string;
  edit: lsp.WorkspaceEdit | null;
}

/** Normalize a WorkspaceEdit into per-file edit lists (1-indexed, relative
 *  paths, with snippets). Handles both `changes` (legacy {uri: TextEdit[]})
 *  and `documentChanges` (LSP 3.x TextDocumentEdit + file ops). */
export function normalizeRename(v: unknown, o: FormatOpts): FlatRenameResult {
  const res = v as RenameResult;
  const ws = o.workspaceRoot;
  const withSnip = wantSnippet(o);
  const byAbs = new Map<string, FlatRenameEdit[]>();
  const fileOps: FlatRenameResult["fileOps"] = [];
  const edit = res.edit;
  const addEdit = (uri: string, te: lsp.TextEdit) => {
    const abs = uriToAbs(uri);
    const line = te.range.start.line + 1;
    const col = te.range.start.character + 1;
    const endLine = te.range.end.line + 1;
    const endCol = te.range.end.character + 1;
    const e: FlatRenameEdit = {
      file: toRel(abs, ws),
      line,
      col,
      endLine,
      endCol,
      newText: te.newText,
    };
    if (withSnip) {
      const snip = readSnippet(abs, line, endLine);
      if (snip) {
        e.snippet = snip;
        if (line === endLine) {
          const t = snip.lines[0]?.t ?? "";
          e.match = t.slice(col - 1, endCol - 1) || undefined;
        }
      }
    }
    const arr = byAbs.get(abs) ?? [];
    arr.push(e);
    byAbs.set(abs, arr);
  };
  if (edit?.changes) {
    for (const [uri, edits] of Object.entries(edit.changes)) {
      for (const te of edits) addEdit(uri, te);
    }
  }
  if (edit?.documentChanges) {
    for (const ch of edit.documentChanges) {
      if (ch && typeof ch === "object" && "textDocument" in ch && "edits" in ch) {
        const tde = ch as lsp.TextDocumentEdit;
        for (const te of tde.edits) addEdit(tde.textDocument.uri, te as lsp.TextEdit);
      } else if (ch && typeof ch === "object" && "kind" in ch) {
        const op = ch as lsp.CreateFile | lsp.RenameFile | lsp.DeleteFile;
        const kind = op.kind as "create" | "rename" | "delete";
        if (kind === "rename") {
          fileOps.push({ kind, uri: (op as lsp.RenameFile).oldUri, newUri: (op as lsp.RenameFile).newUri });
        } else {
          fileOps.push({ kind, uri: (op as lsp.CreateFile | lsp.DeleteFile).uri });
        }
      }
    }
  }
  const grouped = Array.from(byAbs.entries()).map(([abs, edits]) => ({
    file: toRel(abs, ws),
    edits: edits.sort((a, b) => a.line - b.line || a.col - b.col),
  }));
  return {
    file: toRel(res.file, ws),
    newName: res.newName,
    placeholder: res.placeholder,
    edits: grouped,
    fileOps: fileOps.length > 0 ? fileOps : undefined,
  };
}

export function formatRename(v: unknown, o: FormatOpts): string {
  const r = normalizeRename(v, o);
  if (o.json) return JSON.stringify(r, null, 2);
  if (r.edits.length === 0) {
    return c.dim("(no edits)") + (r.fileOps?.length ? c.yellow(` (${r.fileOps.length} file op(s) — not applied)`) : "");
  }
  const totalEdits = r.edits.reduce((n, g) => n + g.edits.length, 0);
  const from = r.placeholder ? c.bold(r.placeholder) : c.dim("(symbol)");
  const head =
    `${c.bold("rename")}: ${from} ${c.dim("→")} ${c.green(c.bold(r.newName))}  ` +
    c.dim(`${totalEdits} edit${totalEdits === 1 ? "" : "s"} across ${r.edits.length} file${r.edits.length === 1 ? "" : "s"}`);
  const body = r.edits
    .map((g) => {
      const header = `\n${c.cyan(g.file)} ${c.dim(`(${g.edits.length})`)}`;
      const edits = g.edits
        .map((e) => {
          const loc = `  ${c.bold(String(e.line))}:${e.col}` +
            (e.endLine !== e.line || e.endCol !== e.col ? c.dim(`→${e.endLine}:${e.endCol}`) : "");
          const repl = e.newText ? c.green(` → ${e.newText}`) : c.red(" (delete)");
          const snip = e.snippet
            ? "\n" + renderSnippetHuman(e.snippet, e.col, e.endCol, e.line === e.endLine)
            : "";
          return `${loc}${repl}${snip}`;
        })
        .join("\n");
      return header + "\n" + edits;
    })
    .join("\n");
  const ops = r.fileOps?.length
    ? "\n" + c.yellow(`⚠ ${r.fileOps.length} file op(s) requested (create/rename/delete) — not applied by lspx`)
    : "";
  return head + body + ops;
}

// ---- Hover ----

export function formatHover(h: lsp.Hover | null, o: FormatOpts): string {
  if (!h) return o.json ? "null" : c.dim("(no hover)");
  const text = extractHoverText(h);
  if (o.json) return JSON.stringify({ text }, null, 2);
  return text;
}

function extractHoverText(h: lsp.Hover): string {
  const content = h.contents;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c2) =>
        typeof c2 === "string" ? c2 : "```" + (c2.language ?? "") + "\n" + c2.value + "\n```",
      )
      .join("\n\n");
  }
  if (typeof content === "object" && content !== null && "value" in content) {
    const mc = content as lsp.MarkupContent;
    return mc.kind === "markdown" ? mc.value : mc.value;
  }
  return "";
}

// ---- Symbols ----

type SymbolResult = lsp.DocumentSymbol[] | lsp.SymbolInformation[] | null;

export function formatSymbols(v: SymbolResult, o: FormatOpts): string {
  if (o.json) return JSON.stringify(normalizeSymbols(v, o), null, 2);
  if (!v || v.length === 0) return c.dim("(no symbols)");
  return renderSymbolTree(v, o, 0);
}

interface FlatSymbol {
  name: string;
  kind: string;
  detail?: string;
  file?: string;
  line?: number;
  col?: number;
  endLine?: number;
  endCol?: number;
  match?: string;
  snippet?: { lines: { n: number; t: string }[]; truncated: boolean };
  children?: FlatSymbol[];
}

function normalizeSymbols(v: SymbolResult, o: FormatOpts): FlatSymbol[] {
  if (!v) return [];
  const ws = o.workspaceRoot;
  const withSnip = wantSnippet(o);
  // DocumentSymbol (hierarchical) vs SymbolInformation (flat).
  if (v.length > 0 && "range" in v[0] && "selectionRange" in v[0]) {
    return (v as lsp.DocumentSymbol[]).map((s) => flatDocSymbol(s));
  }
  return (v as lsp.SymbolInformation[]).map((s) => {
    const abs = uriToAbs(s.location.uri);
    const line = s.location.range.start.line + 1;
    const col = s.location.range.start.character + 1;
    const endLine = s.location.range.end.line + 1;
    const endCol = s.location.range.end.character + 1;
    const fs: FlatSymbol = {
      name: s.name,
      kind: symbolKindLabel(s.kind),
      detail: s.containerName,
      file: toRel(abs, ws),
      line,
      col,
      endLine,
      endCol,
    };
    if (withSnip) {
      const snip = readSnippet(abs, line, endLine);
      if (snip) {
        fs.snippet = snip;
        if (line === endLine) {
          const t = snip.lines[0]?.t ?? "";
          fs.match = t.slice(col - 1, endCol - 1) || undefined;
        }
      }
    }
    return fs;
  });
}

function flatDocSymbol(s: lsp.DocumentSymbol): FlatSymbol {
  return {
    name: s.name,
    kind: symbolKindLabel(s.kind),
    detail: s.detail,
    children: s.children?.map(flatDocSymbol),
  };
}

function renderSymbolTree(v: SymbolResult, o: FormatOpts, depth: number): string {
  const arr = (v ?? []) as (lsp.DocumentSymbol | lsp.SymbolInformation)[];
  if (arr.length > 0 && "selectionRange" in arr[0]) {
    return (arr as lsp.DocumentSymbol[])
      .map((s) => renderDocSymbol(s, depth))
      .join("\n");
  }
  return (arr as lsp.SymbolInformation[])
    .map((s) => {
      const file = toRel(uriToAbs(s.location.uri), o.workspaceRoot);
      const pos = `${s.location.range.start.line + 1}:${s.location.range.start.character + 1}`;
      const head = `${indent(depth)}${c.gray(symbolKindLabel(s.kind))} ${c.bold(s.name)} ${c.dim(`${file}:${pos}`)}`;
      const body = renderSymbolSnippet(s, o);
      return body ? `${head}\n${body}` : head;
    })
    .join("\n");
}

/** For flat workspace symbols: show the source line under the symbol head. */
function renderSymbolSnippet(s: lsp.SymbolInformation, o: FormatOpts): string {
  if (!wantSnippet(o)) return "";
  const abs = uriToAbs(s.location.uri);
  const line = s.location.range.start.line + 1;
  const endLine = s.location.range.end.line + 1;
  const snip = readSnippet(abs, line, endLine);
  if (!snip) return "";
  const w = String(Math.max(...snip.lines.map((l) => l.n))).length;
  return snip.lines
    .map(({ n, t }) => `${c.dim(`  ${String(n).padStart(w)} │ `)}${t}`)
    .join("\n");
}

function renderDocSymbol(s: lsp.DocumentSymbol, depth: number): string {
  const head = `${indent(depth)}${c.gray(symbolKindLabel(s.kind))} ${c.bold(s.name)}`;
  const detail = s.detail ? c.dim(` ${s.detail}`) : "";
  const childText = s.children?.length
    ? "\n" + s.children.map((c2) => renderDocSymbol(c2, depth + 1)).join("\n")
    : "";
  return head + detail + childText;
}

function indent(depth: number): string {
  return "  ".repeat(depth);
}

// ---- Status ----

export function formatStatus(status: Record<string, unknown>, o: FormatOpts): string {
  if (o.json) return JSON.stringify(status, null, 2);
  const lines: string[] = [];
  lines.push(`${c.bold("workspace")}  ${String(status.workspace ?? "")}`);
  lines.push(`${c.bold("socket")}     ${String(status.socket ?? "")}`);
  lines.push(`${c.bold("pid")}         ${String(status.pid ?? "")}`);
  lines.push(`${c.bold("server")}      ${String(status.serverId ?? "")}`);
  if (status.primary) lines.push(`${c.bold("primary")}     ${String(status.primary)}`);
  lines.push(`${c.bold("ready")}       ${status.ready ? c.green("yes") : c.dim("no")}`);
  const clients = (status.clients ?? []) as Array<Record<string, unknown>>;
  if (clients.length === 0) {
    lines.push(`${c.dim("(no clients booted)")}`);
  } else {
    for (const cl of clients) {
      const state = String(cl.state ?? "?");
      const mark = state === "ready" ? c.green("✓") : state === "error" ? c.red("✗") : c.yellow("…");
      const langs = (cl.languages as string[] | undefined)?.join(", ") ?? "";
      lines.push(`${mark} ${c.bold(String(cl.serverId))}  ${c.dim(langs)}  open=${String(cl.openDocs ?? 0)}`);
      const caps = (cl.capabilities ?? {}) as Record<string, boolean>;
      const on = Object.entries(caps).filter(([, v]) => v).map(([k]) => k);
      if (on.length) lines.push(`    ${c.dim(on.join(" · "))}`);
    }
  }
  return lines.join("\n");
}

// ---- Codemap (full codebase symbol tree + call edges) ----

/** Raw codemap structure from the daemon (kind = numeric SymbolKind). */
interface RawCodemapFile {
  file: string;
  symbols: RawCodemapSymbol[];
}
interface RawCodemapSymbol {
  name: string;
  kind: number;
  detail?: string;
  line: number;
  col: number;
  children?: RawCodemapSymbol[];
  callees?: RawCodemapEdge[];
  callers?: RawCodemapEdge[];
}
interface RawCodemapEdge {
  name: string;
  kind: number;
  detail?: string;
  file: string;
  line: number;
  col: number;
}

/** Flat codemap structure (kind = label string, file = relative path). */
export interface FlatCodemapFile {
  file: string;
  symbols: FlatCodemapSymbol[];
}
export interface FlatCodemapSymbol {
  name: string;
  kind: string;
  detail?: string;
  container?: string;
  line: number;
  col: number;
  children?: FlatCodemapSymbol[];
  callees?: FlatCodemapEdge[];
  callers?: FlatCodemapEdge[];
}
export interface FlatCodemapEdge {
  name: string;
  kind: string;
  detail?: string;
  file: string;
  line: number;
  col: number;
}

export function formatCodemap(v: unknown, o: FormatOpts): string {
  const map = normalizeCodemap(v, o);
  if (o.json) return JSON.stringify(map, null, 2);
  if (map.files.length === 0) return c.dim("(no symbols found)");
  const lines: string[] = [];
  for (const file of map.files) {
    lines.push(c.bold(c.cyan(file.file)));
    if (file.symbols.length === 0) {
      lines.push(c.dim("  (no symbols)"));
    } else {
      for (const sym of file.symbols) {
        lines.push(renderCodemapSymbol(sym, 1));
      }
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

function normalizeCodemap(v: unknown, o: FormatOpts): { files: FlatCodemapFile[] } {
  const raw = v as { files: RawCodemapFile[] } | null;
  if (!raw || !raw.files) return { files: [] };
  const ws = o.workspaceRoot;
  return { files: raw.files.map((f) => ({ file: toRel(f.file, ws), symbols: (f.symbols ?? []).map((s) => normSymbol(s, ws)) })) };
}

function normSymbol(s: RawCodemapSymbol, ws: string): FlatCodemapSymbol {
  const sym: FlatCodemapSymbol = {
    name: s.name,
    kind: symbolKindLabel(s.kind),
    line: s.line,
    col: s.col,
  };
  if (s.detail) sym.detail = s.detail;
  if (s.children?.length) sym.children = s.children.map((c) => normSymbol(c, ws));
  if (s.callees?.length) sym.callees = s.callees.map((e) => normEdge(e, ws));
  if (s.callers?.length) sym.callers = s.callers.map((e) => normEdge(e, ws));
  return sym;
}

function normEdge(e: RawCodemapEdge, ws: string): FlatCodemapEdge {
  const edge: FlatCodemapEdge = {
    name: e.name,
    kind: symbolKindLabel(e.kind),
    line: e.line,
    col: e.col,
    file: shortPath(e.file, ws),
  };
  if (e.detail) edge.detail = e.detail;
  return edge;
}

/** Relative for workspace files; basename for external (deps, stdlib). */
function shortPath(abs: string, ws: string): string {
  const r = relative(ws, abs);
  if (r && !r.startsWith("..")) return r;
  return abs.split("/").pop() ?? abs;
}

function renderCodemapSymbol(sym: FlatCodemapSymbol, depth: number): string {
  const ind = "  ".repeat(depth);
  const head = `${ind}${c.gray(sym.kind)} ${c.bold(sym.name)}` +
    (sym.detail ? c.dim(`  ${sym.detail}`) : "") +
    (sym.container && !sym.detail ? c.dim(` in ${sym.container}`) : "");
  const parts = [head];
  if (sym.children) {
    for (const child of sym.children) {
      parts.push(renderCodemapSymbol(child, depth + 1));
    }
  }
  // Callees go one level deeper under the function; callers go in a
  // "called by" block at the same indent.
  if (sym.callees?.length) {
    for (const call of sym.callees) {
      parts.push(renderCodemapEdge(call, "→", depth + 1));
    }
  }
  if (sym.callers?.length) {
    parts.push(`${"  ".repeat(depth + 1)}${c.dim("called by:")}`);
    for (const call of sym.callers) {
      parts.push(renderCodemapEdge(call, "←", depth + 2));
    }
  }
  return parts.join("\n");
}

function renderCodemapEdge(edge: FlatCodemapEdge, arrow: string, depth: number): string {
  const ind = "  ".repeat(depth);
  return `${ind}${c.cyan(arrow)} ${edge.name}` +
    (edge.detail ? c.dim(`  ${edge.detail}`) : "") +
    c.dim(`  ${edge.file}:${edge.line}`);
}
