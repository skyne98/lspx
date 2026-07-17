import type * as lsp from "vscode-languageserver-protocol";

export type ExactMatchResult =
  | { kind: "found"; range: lsp.Range }
  | { kind: "not-found" }
  | { kind: "ambiguous"; occurrences: number }
  | { kind: "invalid"; message: string };

/** Locate one exact, non-empty occurrence and convert its string offsets to
 *  a 0-indexed LSP range. JavaScript string offsets are UTF-16 code units,
 *  matching LSP's default position encoding. */
export function locateUniqueExact(src: string, oldText: string): ExactMatchResult {
  if (oldText.length === 0) {
    return { kind: "invalid", message: "oldText must not be empty" };
  }
  const first = src.indexOf(oldText);
  if (first === -1) return { kind: "not-found" };
  const second = src.indexOf(oldText, first + 1);
  if (second !== -1) {
    let occurrences = 2;
    let at = second;
    while ((at = src.indexOf(oldText, at + 1)) !== -1) occurrences++;
    return { kind: "ambiguous", occurrences };
  }
  return {
    kind: "found",
    range: { start: offsetToPosition(src, first), end: offsetToPosition(src, first + oldText.length) },
  };
}

function offsetToPosition(text: string, target: number): lsp.Position {
  let line = 0;
  let lineStart = 0;
  for (let i = 0; i < target; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, character: target - lineStart };
}
