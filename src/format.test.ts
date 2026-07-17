import { describe, expect, it } from "bun:test";
import { formatBatchEdit, formatReplaceSymbol, formatSource } from "./format.ts";

const opts = { workspaceRoot: "/ws", json: true, snippet: false };

describe("semantic JSON formatting", () => {
  it("normalizes source paths, symbol kinds, positions, and digest", () => {
    const output = JSON.parse(formatSource({
      path: "/ws/src/a.ts",
      name: "f",
      kind: 12,
      range: { start: { line: 1, character: 2 }, end: { line: 3, character: 4 } },
      selectionRange: { start: { line: 1, character: 2 }, end: { line: 1, character: 3 } },
      expectedText: "function f() {}",
      contentHash: "abc123",
    }, opts));
    expect(output).toMatchObject({
      path: "src/a.ts",
      name: "f",
      kind: "function",
      range: { start: { line: 2, column: 3 }, end: { line: 4, column: 5 } },
      contentHash: "abc123",
    });
  });

  it("normalizes replacement symbol positions to the public 1-indexed contract", () => {
    const output = JSON.parse(formatReplaceSymbol({
      dryRun: true,
      symbol: {
        path: "/ws/src/a.ts",
        name: "f",
        kind: 12,
        range: { start: { line: 0, character: 0 }, end: { line: 1, character: 1 } },
      },
      plan: [{ path: "/ws/src/a.ts", edits: 1 }],
    }, opts, false));
    expect(output.symbol).toMatchObject({
      path: "src/a.ts",
      kind: "function",
      range: { start: { line: 1, column: 1 }, end: { line: 2, column: 2 } },
    });
    expect(output.plan[0].path).toBe("src/a.ts");
  });

  it("normalizes batch verification paths", () => {
    const output = JSON.parse(formatBatchEdit({
      applied: true,
      verification: { files: [{ path: "/ws/src/a.ts", freshness: "fresh" }] },
    }, opts, true));
    expect(output.verification.files[0].path).toBe("src/a.ts");
  });
});
