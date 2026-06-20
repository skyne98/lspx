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
import { symbolKindLabel } from "./lsp/types.ts";
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
  const caps = (status.capabilities ?? {}) as Record<string, boolean>;
  lines.push(`${c.bold("capabilities")}`);
  for (const [k, v] of Object.entries(caps)) {
    const mark = v ? c.green("✓") : c.dim("✘");
    lines.push(`  ${mark} ${k}`);
  }
  return lines.join("\n");
}
