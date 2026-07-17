// Symbol resolution — the shared primitive behind `source`, `replace-symbol`,
// and any future semantic command.
//
// A "resolved symbol" is the most specific DocumentSymbol (or, for flat
// SymbolInformation servers, the smallest containing range) at a position or
// matched by name, plus the source text it covers and a content digest so a
// later edit can reject a stale target rather than corrupt a shifted range.
//
// Positions are 0-indexed LSP positions internally (this is the wire layer;
// the CLI converts to 1-indexed for human/JSON output). Ranges are
// half-open [start, end), matching LSP semantics.

import { createHash } from "node:crypto";
import type * as lsp from "vscode-languageserver-protocol";

export interface PublicRange {
  start: { line: number; character: number };
  end: { line: number; character: number };
}

export interface ResolvedSymbol {
  /** Absolute filesystem path. */
  path: string;
  name: string;
  container?: string;
  /** Numeric LSP SymbolKind (kept internal; mapped to a string at the
   *  public output boundary so callers never see raw enums). */
  kind: number;
  /** Full declaration range (may include signature + body + metadata). */
  range: PublicRange;
  /** Tight name range inside `range`. */
  selectionRange: PublicRange;
  /** The source text covered by `range`, verbatim. */
  expectedText: string;
  /** sha256 digest of `expectedText` (hex, truncated). Used as a stale-target
   *  precondition: if disk text at apply time no longer matches, the edit is
   *  rejected rather than applied to a shifted location. */
  contentHash: string;
  /** Whether the server's symbol range is known to include preceding doc
   *  comments / decorators / attributes. This is server-dependent and not
   *  expanded heuristically — surfaced honestly to the caller. */
  metadataIncluded: "server-dependent";
}

/** Candidate returned for an ambiguous name lookup. Compact: enough to let
 *  the caller disambiguate (container + 1-indexed location). */
export interface SymbolCandidate {
  name: string;
  kind: number;
  path: string;
  line: number;
  column: number;
  container?: string;
}

export interface NameFilter {
  /** Restrict to symbols declared under this file or directory (absolute). */
  within?: string;
  /** Restrict to symbols whose container matches (exact, case-sensitive). */
  container?: string;
  /** Restrict to a specific LSP SymbolKind. */
  kind?: number;
}

/** Read + stat surface the resolver needs. Inject a fake in tests. */
export interface SymbolIO {
  read(path: string): string;
}

export const defaultSymbolIO: SymbolIO = {
  read: (p) => {
    // Deferred import keeps this module importable from tests that stub fs.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    return readFileSync(p, "utf-8");
  },
};

export function hashContent(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex").slice(0, 16);
}

function posLe(a: lsp.Position, b: lsp.Position): boolean {
  return a.line < b.line || (a.line === b.line && a.character <= b.character);
}

function posLt(a: lsp.Position, b: lsp.Position): boolean {
  return a.line < b.line || (a.line === b.line && a.character < b.character);
}

function rangeContains(range: lsp.Range, pos: lsp.Position): boolean {
  return posLe(range.start, pos) && posLt(pos, range.end);
}

function toRange(r: lsp.Range): PublicRange {
  return {
    start: { line: r.start.line, character: r.start.character },
    end: { line: r.end.line, character: r.end.character },
  };
}

function isDocumentSymbol(
  s: lsp.DocumentSymbol | lsp.SymbolInformation,
): s is lsp.DocumentSymbol {
  return typeof s === "object" && s !== null && "selectionRange" in s && "range" in s;
}

/** Find the deepest DocumentSymbol whose range contains `pos`.
 *  Returns null if the server returned flat SymbolInformation (caller should
 *  use `deepestFlatEnclosing` instead) or nothing contains the position. */
export function deepestEnclosing(
  symbols: lsp.DocumentSymbol[],
  pos: lsp.Position,
): lsp.DocumentSymbol | null {
  let best: lsp.DocumentSymbol | null = null;
  const walk = (syms: lsp.DocumentSymbol[]) => {
    for (const d of syms) {
      if (rangeContains(d.range, pos)) {
        // Prefer the deepest match: recurse, and only keep this one if no
        // child contains the position.
        if (d.children?.length) {
          const child = deepestEnclosing(d.children, pos);
          if (child) {
            best = child;
            return;
          }
        }
        best = d;
        return;
      }
    }
  };
  walk(symbols);
  return best;
}

/** For flat SymbolInformation servers: the smallest range containing `pos`.
 *  Smallest-by-area is the most specific symbol. Ties broken by start position. */
export function deepestFlatEnclosing(
  symbols: lsp.SymbolInformation[],
  pos: lsp.Position,
): lsp.SymbolInformation | null {
  let best: lsp.SymbolInformation | null = null;
  let bestArea = Number.POSITIVE_INFINITY;
  for (const s of symbols) {
    if (!rangeContains(s.location.range, pos)) continue;
    const area =
      (s.location.range.end.line - s.location.range.start.line) * 1000 +
      (s.location.range.end.character - s.location.range.start.character);
    if (area < bestArea) {
      bestArea = area;
      best = s;
    }
  }
  return best;
}

/** Build a ResolvedSymbol from a hierarchical DocumentSymbol + disk text. */
export function resolvedFromDocumentSymbol(
  d: lsp.DocumentSymbol,
  path: string,
  text: string,
): ResolvedSymbol {
  const expected = sliceRange(text, d.range);
  return {
    path,
    name: d.name,
    kind: d.kind,
    range: toRange(d.range),
    selectionRange: toRange(d.selectionRange),
    expectedText: expected,
    contentHash: hashContent(expected),
    metadataIncluded: "server-dependent",
  };
}

/** Build a ResolvedSymbol from a flat SymbolInformation + disk text.
 *  (selectionRange == range for flat symbols.) */
export function resolvedFromSymbolInformation(
  s: lsp.SymbolInformation,
  path: string,
  text: string,
): ResolvedSymbol {
  const expected = sliceRange(text, s.location.range);
  return {
    path,
    name: s.name,
    kind: s.kind,
    container: s.containerName,
    range: toRange(s.location.range),
    selectionRange: toRange(s.location.range),
    expectedText: expected,
    contentHash: hashContent(expected),
    metadataIncluded: "server-dependent",
  };
}

/** Resolve the symbol at a 0-indexed position.
 *
 *  1. documentSymbol the file.
 *  2. If hierarchical → deepest enclosing DocumentSymbol.
 *     If flat → smallest containing SymbolInformation.
 *  3. Read disk text, build the ResolvedSymbol (with expected text + digest).
 *
 *  Returns `symbol-not-found` if the server has no documentSymbol capability
 *  or nothing contains the position. The caller surfaces this as an error. */
export function resolveSymbolAt(
  symbols: lsp.DocumentSymbol[] | lsp.SymbolInformation[] | null,
  path: string,
  pos: lsp.Position,
  text: string,
): ResolvedSymbol | null {
  if (!symbols || symbols.length === 0) return null;
  if (isDocumentSymbol(symbols[0])) {
    const d = deepestEnclosing(symbols as lsp.DocumentSymbol[], pos);
    return d ? resolvedFromDocumentSymbol(d, path, text) : null;
  }
  const f = deepestFlatEnclosing(symbols as lsp.SymbolInformation[], pos);
  return f ? resolvedFromSymbolInformation(f, path, text) : null;
}

/** Filter workspace-symbol candidates by name constraints.
 *  - `within`: candidate path is equal to, or nested under, `within`.
 *  - `container`: candidate.containerName equals `container`.
 *  - `kind`: candidate.kind equals `kind`.
 *  Location may be `{ uri }` only (unresolved WorkspaceSymbol); such entries
 *  are kept but have no range — they are reported as candidates, not resolved. */
export function filterCandidates(
  candidates: (lsp.SymbolInformation | lsp.WorkspaceSymbol)[],
  filter: NameFilter,
): SymbolCandidate[] {
  const out: SymbolCandidate[] = [];
  for (const c of candidates) {
    const loc = (c as lsp.SymbolInformation).location ??
      (c as lsp.WorkspaceSymbol).location;
    if (!loc || typeof loc !== "object" || !("uri" in loc)) continue;
    const p = uriToPathLocal(loc.uri);
    if (filter.within && !isWithin(p, filter.within)) continue;
    const container = (c as lsp.SymbolInformation).containerName ??
      (c as lsp.WorkspaceSymbol).containerName;
    if (filter.container && container !== filter.container) continue;
    if (filter.kind !== undefined && c.kind !== filter.kind) continue;
    const start = loc.range?.start;
    out.push({
      name: c.name,
      kind: c.kind,
      path: p,
      line: start ? start.line + 1 : 0,
      column: start ? start.character + 1 : 0,
      container,
    });
  }
  return out;
}

/** Slice the text covered by an LSP range (0-indexed). Mirrors edit.ts
 *  posToOffset semantics: UTF-16 code units for the common ASCII case,
 *  clamping past-end positions to the document end. */
export function sliceRange(text: string, range: lsp.Range): string {
  const start = posToOffsetLocal(text, range.start);
  const end = posToOffsetLocal(text, range.end);
  return text.slice(start, end);
}

function posToOffsetLocal(text: string, pos: lsp.Position): number {
  let offset = 0;
  for (let i = 0; i < pos.line; i++) {
    const nl = text.indexOf("\n", offset);
    if (nl === -1) return text.length;
    offset = nl + 1;
  }
  return Math.min(offset + pos.character, text.length);
}

function isWithin(path: string, base: string): boolean {
  if (path === base) return true;
  return path.startsWith(base.endsWith("/") ? base : base + "/");
}

// Local URI->path to avoid a hard dependency on vscode-uri in this pure module.
// The daemon path is already absolute, so this is only used for workspace
// symbol results (which carry file:// URIs).
function uriToPathLocal(uri: string): string {
  if (!uri.startsWith("file:")) return uri;
  try {
    const u = new URL(uri);
    return decodeURIComponent(u.pathname);
  } catch {
    return uri.slice("file://".length);
  }
}
