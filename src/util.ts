// Small shared utilities. URI <-> path conversion lives in lsp/client.ts
// (via the canonical `vscode-uri` package); this file holds presentation +
// parsing helpers shared across the CLI.

import { relative } from "node:path";

/** Normalize an absolute path to a workspace-relative display string. */
export function relPath(abs: string, ws: string): string {
  if (!abs) return abs;
  let r = relative(ws, abs);
  if (r.startsWith("..")) {
    // Outside the workspace: show absolute.
    r = abs;
  }
  return r ? r : ".";
}

/** 1-indexed LSP Position -> human "line:col" (1-based, like editors). */
export function fmtPos(line: number, character: number): string {
  return `${line + 1}:${character + 1}`;
}

/** Debounce-ish: wait ms. */
export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Clamp a number. */
export function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/** Is this a "word-ish" char (identifier characters)? */
export function isIdentChar(ch: string): boolean {
  return /[A-Za-z0-9_$]/.test(ch);
}

/** Split a command-line into tokens, honoring quotes. Minimal shell-like parse. */
export function tokenize(input: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q: string | null = null;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (q) {
      if (ch === q) {
        q = null;
      } else if (ch === "\\" && i + 1 < input.length) {
        cur += input[++i];
      } else {
        cur += ch;
      }
    } else if (ch === '"' || ch === "'") {
      q = ch;
    } else if (/\s/.test(ch)) {
      if (cur) out.push(cur);
      cur = "";
    } else if (ch === "\\" && i + 1 < input.length) {
      cur += input[++i];
    } else {
      cur += ch;
    }
  }
  if (cur) out.push(cur);
  return out;
}
