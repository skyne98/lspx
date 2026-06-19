// Code-snippet extraction for nav results.
//
// Goal: every location lspx returns carries the code at that span, so an
// agent never has to round-trip a read_file just to see what's there.
//
// Snippets are read from disk (the workspace is on the LSP server's root).
// File contents are cached per-process: the CLI is one-shot (one command,
// then exit), so a module-level cache is correct and avoids re-reading a
// file once per result in a multi-hit refs list.

import { readFileSync, statSync } from "node:fs";

export interface SnippetLine {
  /** 1-indexed source line number. */
  n: number;
  /** The line text (no trailing newline). */
  t: string;
}

export interface Snippet {
  lines: SnippetLine[];
  /** True when the source span was longer than MAX_LINES (we truncated). */
  truncated: boolean;
}

/** Max lines in a single snippet. A whole function body is fine; a whole
 *  file is not (blows up tokens). Truncate with an explicit marker. */
export const MAX_SNIPPET_LINES = 30;

/** mtime-keyed cache so a file edited mid-command is re-read once. */
const cache = new Map<string, { mtimeMs: number; lines: string[] }>();

function readLines(absPath: string): string[] | null {
  let st: { mtimeMs: number };
  try {
    st = statSync(absPath);
  } catch {
    return null;
  }
  const hit = cache.get(absPath);
  if (hit && hit.mtimeMs === st.mtimeMs) return hit.lines;
  let content: string;
  try {
    content = readFileSync(absPath, "utf-8");
  } catch {
    return null;
  }
  // split('\n') leaves a trailing "" if the file ends with a newline; drop it
  // so line numbers line up with what an editor shows.
  const lines = content.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  cache.set(absPath, { mtimeMs: st.mtimeMs, lines });
  return lines;
}

/**
 * Read the source lines for a 1-indexed inclusive span [startLine, endLine].
 * Returns null if the file can't be read. Truncates spans longer than
 * MAX_SNIPPET_LINES (sets `truncated: true`).
 */
export function readSnippet(
  absPath: string,
  startLine: number,
  endLine: number,
): Snippet | null {
  const all = readLines(absPath);
  if (!all) return null;
  const from = Math.max(1, startLine);
  const to = Math.min(all.length, endLine);
  if (to < from) return null;
  const span = to - from + 1;
  const truncated = span > MAX_SNIPPET_LINES;
  const limit = truncated ? from + MAX_SNIPPET_LINES - 1 : to;
  const lines: SnippetLine[] = [];
  for (let n = from; n <= limit; n++) lines.push({ n, t: all[n - 1] ?? "" });
  return { lines, truncated };
}
