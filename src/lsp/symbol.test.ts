import { describe, expect, test } from "bun:test";
import * as lsp from "vscode-languageserver-protocol";
import type { SymbolKind } from "vscode-languageserver-protocol";
import {
  deepestEnclosing,
  deepestFlatEnclosing,
  filterCandidates,
  hashContent,
  resolveSymbolAt,
  sliceRange,
} from "./symbol.ts";

const SRC = [
  "import foo",
  "",
  "class Config {",
  "  constructor(x) {",
  "    this.x = x",
  "  }",
  "  load() {",
  "    return this.x",
  "  }",
  "}",
  "",
].join("\n");

function docSym(
  name: string,
  kind: SymbolKind,
  start: [number, number],
  end: [number, number],
  children: lsp.DocumentSymbol[] = [],
): lsp.DocumentSymbol {
  return {
    name,
    kind,
    range: { start: { line: start[0], character: start[1] }, end: { line: end[0], character: end[1] } },
    selectionRange: { start: { line: start[0], character: start[1] }, end: { line: start[0], character: start[1] + name.length } },
    children,
  };
}

const TREE: lsp.DocumentSymbol[] = [
  docSym("Config", lsp.SymbolKind.Class, [2, 0], [10, 1], [
    docSym("constructor", lsp.SymbolKind.Constructor, [3, 2], [5, 3]),
    docSym("load", lsp.SymbolKind.Method, [6, 2], [8, 3]),
  ]),
];

describe("deepestEnclosing", () => {
  test("returns the class for a position outside any member", () => {
    const d = deepestEnclosing(TREE, { line: 0, character: 0 });
    expect(d).toBeNull();
  });
  test("returns the class for a position on the class line", () => {
    const d = deepestEnclosing(TREE, { line: 2, character: 4 });
    expect(d?.name).toBe("Config");
  });
  test("returns the deepest member for a position inside a method body", () => {
    const d = deepestEnclosing(TREE, { line: 7, character: 5 });
    expect(d?.name).toBe("load");
  });
  test("returns constructor inside its body", () => {
    const d = deepestEnclosing(TREE, { line: 4, character: 4 });
    expect(d?.name).toBe("constructor");
  });
});

describe("deepestFlatEnclosing", () => {
  const flat: lsp.SymbolInformation[] = [
    {
      name: "Config",
      kind: lsp.SymbolKind.Class,
      location: { uri: "file:///a.ts", range: { start: { line: 2, character: 0 }, end: { line: 10, character: 1 } } },
    },
    {
      name: "load",
      kind: lsp.SymbolKind.Method,
      location: { uri: "file:///a.ts", range: { start: { line: 6, character: 2 }, end: { line: 8, character: 3 } } },
    },
  ];
  test("picks the smallest containing range", () => {
    const d = deepestFlatEnclosing(flat, { line: 7, character: 5 });
    expect(d?.name).toBe("load");
  });
  test("falls back to the wider range outside the member", () => {
    const d = deepestFlatEnclosing(flat, { line: 3, character: 2 });
    expect(d?.name).toBe("Config");
  });
});

describe("sliceRange + hashContent", () => {
  test("sliceRange extracts exactly the covered lines", () => {
    const slice = sliceRange(SRC, { start: { line: 6, character: 0 }, end: { line: 9, character: 0 } });
    expect(slice).toBe("  load() {\n    return this.x\n  }\n");
  });
  test("hashContent is stable for identical input and differs for changed input", () => {
    const a = hashContent("def f(): pass\n");
    const b = hashContent("def f(): pass\n");
    const c = hashContent("def f(): pass");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toHaveLength(16);
  });
});

describe("resolveSymbolAt", () => {
  test("resolves the deepest hierarchical symbol with expected text + digest", () => {
    const r = resolveSymbolAt(TREE, "/a.ts", { line: 7, character: 5 }, SRC);
    expect(r).not.toBeNull();
    expect(r!.name).toBe("load");
    expect(r!.kind).toBe(lsp.SymbolKind.Method);
    expect(r!.expectedText).toBe("load() {\n    return this.x\n  }");
    expect(r!.contentHash).toBe(hashContent(r!.expectedText));
    expect(r!.metadataIncluded).toBe("server-dependent");
  });
  test("returns null when nothing contains the position", () => {
    expect(resolveSymbolAt(TREE, "/a.ts", { line: 0, character: 0 }, SRC)).toBeNull();
  });
  test("returns null when symbols is empty", () => {
    expect(resolveSymbolAt([], "/a.ts", { line: 5, character: 0 }, SRC)).toBeNull();
  });
  test("handles flat SymbolInformation", () => {
    const flat: lsp.SymbolInformation[] = [
      {
        name: "load",
        kind: lsp.SymbolKind.Method,
        containerName: "Config",
        location: { uri: "file:///a.ts", range: { start: { line: 6, character: 2 }, end: { line: 8, character: 3 } } },
      },
    ];
    const r = resolveSymbolAt(flat, "/a.ts", { line: 7, character: 5 }, SRC);
    expect(r?.name).toBe("load");
    expect(r?.container).toBe("Config");
  });
});

describe("filterCandidates", () => {
  const cands: (lsp.SymbolInformation | lsp.WorkspaceSymbol)[] = [
    { name: "load", kind: lsp.SymbolKind.Method, location: { uri: "file:///proj/src/a.ts", range: { start: { line: 6, character: 2 }, end: { line: 8, character: 3 } } } },
    { name: "load", kind: lsp.SymbolKind.Function, location: { uri: "file:///proj/src/b.ts", range: { start: { line: 1, character: 0 }, end: { line: 1, character: 4 } } } },
    { name: "load", kind: lsp.SymbolKind.Function, location: { uri: "file:///other/c.ts", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } } } },
  ];
  test("within filters to a directory subtree", () => {
    const out = filterCandidates(cands, { within: "/proj/src" });
    expect(out.map((c) => c.path)).toEqual(["/proj/src/a.ts", "/proj/src/b.ts"]);
  });
  test("kind filters to a specific SymbolKind", () => {
    const out = filterCandidates(cands, { within: "/proj/src", kind: lsp.SymbolKind.Method });
    expect(out.map((c) => c.path)).toEqual(["/proj/src/a.ts"]);
  });
  test("returns 1-indexed line/column", () => {
    const out = filterCandidates(cands, { within: "/proj/src" });
    const a = out.find((c) => c.path === "/proj/src/a.ts")!;
    expect(a.line).toBe(7);
    expect(a.column).toBe(3);
  });
});
