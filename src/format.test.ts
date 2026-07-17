import { describe, expect, it } from "bun:test";
import { formatBatchEdit, formatCodeActions, formatContext, formatReplaceSymbol, formatSelection, formatSource } from "./format.ts";

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

  it("normalizes selection ranges", () => {
    const output = JSON.parse(formatSelection({
      file: "/ws/src/a.ts",
      ranges: [{ start: { line: 0, character: 1 }, end: { line: 2, character: 3 } }],
    }, opts));
    expect(output).toEqual({
      file: "src/a.ts",
      supported: true,
      ranges: [{ index: 1, start: { line: 1, column: 2 }, end: { line: 3, column: 4 } }],
    });
  });

  it("summarizes code actions without exposing raw workspace edits", () => {
    const output = JSON.parse(formatCodeActions({
      file: "/ws/src/a.ts",
      actions: [{ title: "Fix it", kind: "quickfix", isPreferred: true, edit: { changes: {} } }],
    }, opts, false));
    expect(output.actions).toEqual([{
      index: 1, title: "Fix it", kind: "quickfix", preferred: true,
      disabled: null, hasEdit: true, resolvable: false, hasCommand: false,
    }]);
  });

  it("normalizes bounded context symbols and budget metadata", () => {
    const output = JSON.parse(formatContext({
      target: {
        name: "f", kind: 12, path: "/ws/src/a.ts", source: "fn f() {}",
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 9 } },
      },
      included: {
        containers: [],
        calls: [{ relation: "caller", name: "g", kind: 12, path: "/ws/src/b.ts", line: 2, character: 4, signature: "g()" }],
        types: [], diagnostics: [],
      },
      omitted: { containers: 0, calls: 0, types: 0, diagnostics: 0, total: 0 },
      budget: { limit: 1000, used: 20, remaining: 980, unit: "content-characters" },
      depth: 1,
    }, opts));
    expect(output.target).toMatchObject({ kind: "function", path: "src/a.ts", range: { start: { line: 1, column: 1 } } });
    expect(output.included.calls[0]).toMatchObject({ path: "src/b.ts", line: 3, column: 5 });
  });
});
