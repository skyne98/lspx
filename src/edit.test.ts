// Tests for the disk-writing path — the one place lspx mutates user files.
// In-memory IO so no temp files; focuses on offset math + ordering, where a
// regression would silently corrupt a codebase.

import { describe, it, expect } from "bun:test";
import { posToOffset, applyWorkspaceEdit, type EditIO } from "./edit.ts";

/** Build an in-memory IO seeded with the given files. */
function memIO(files: Record<string, string>): EditIO {
  const store = new Map(Object.entries(files));
  return {
    read: (p) => store.get(p) ?? "",
    write: (p, t) => {
      store.set(p, t);
    },
  };
}

describe("posToOffset", () => {
  const text = "abc\ndefg\nhi";

  it("line 0, character 0 → 0", () => {
    expect(posToOffset(text, { line: 0, character: 0 })).toBe(0);
  });

  it("line 0 mid-line → character offset", () => {
    expect(posToOffset(text, { line: 0, character: 2 })).toBe(2);
  });

  it("line 1 start → after first newline", () => {
    // "abc\n" = 4 chars, line 1 col 0 → offset 4 ('d')
    expect(posToOffset(text, { line: 1, character: 0 })).toBe(4);
  });

  it("line 1 mid-line", () => {
    expect(posToOffset(text, { line: 1, character: 2 })).toBe(6); // 'g'
  });

  it("line 2 start", () => {
    // "abc\ndefg\n" = 9 chars, line 2 col 0 → offset 9 ('h')
    expect(posToOffset(text, { line: 2, character: 0 })).toBe(9);
  });

  it("line past end of document clamps to end", () => {
    expect(posToOffset(text, { line: 99, character: 0 })).toBe(text.length);
  });

  it("character past end of line clamps to line length", () => {
    // Check both an interior line and the final line; an interior position
    // must never spill through the newline into a later line.
    expect(posToOffset(text, { line: 0, character: 50 })).toBe(3);
    expect(posToOffset(text, { line: 2, character: 50 })).toBe(11);
  });

  it("empty text → 0 always", () => {
    expect(posToOffset("", { line: 0, character: 0 })).toBe(0);
    expect(posToOffset("", { line: 5, character: 5 })).toBe(0);
  });

  it("no trailing newline: last line offsets correctly", () => {
    const t = "x\ny";
    expect(posToOffset(t, { line: 1, character: 0 })).toBe(2);
    expect(posToOffset(t, { line: 1, character: 1 })).toBe(3);
  });
});

describe("applyWorkspaceEdit", () => {
  it("null / undefined edit → empty result, no writes", () => {
    const io = memIO({ "/a.ts": "x" });
    const r = applyWorkspaceEdit(null, io);
    expect(r).toEqual({ files: 0, edits: 0, fileOps: 0, paths: [] });
    expect(io.read("/a.ts")).toBe("x");
  });

  it("single edit in changes form", () => {
    const io = memIO({ "/a.ts": "foo(bar)" });
    const r = applyWorkspaceEdit(
      { changes: { "file:///a.ts": [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, newText: "baz" }] } },
      io,
    );
    expect(io.read("/a.ts")).toBe("baz(bar)");
    expect(r.files).toBe(1);
    expect(r.edits).toBe(1);
    expect(r.paths).toEqual(["/a.ts"]);
  });

  it("multiple edits in the same file applied end-first (no offset shift)", () => {
    // Replace first and last identifier on one line.
    const io = memIO({ "/a.ts": "aaa bbb ccc" });
    applyWorkspaceEdit(
      {
        changes: {
          "file:///a.ts": [
            { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, newText: "XXX" },
            { range: { start: { line: 0, character: 8 }, end: { line: 0, character: 11 } }, newText: "ZZZ" },
          ],
        },
      },
      io,
    );
    expect(io.read("/a.ts")).toBe("XXX bbb ZZZ");
  });

  it("edits across multiple files", () => {
    const io = memIO({ "/a.ts": "one", "/b.ts": "two" });
    const r = applyWorkspaceEdit(
      {
        changes: {
          "file:///a.ts": [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, newText: "ONE" }],
          "file:///b.ts": [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, newText: "TWO" }],
        },
      },
      io,
    );
    expect(io.read("/a.ts")).toBe("ONE");
    expect(io.read("/b.ts")).toBe("TWO");
    expect(r.files).toBe(2);
    expect(r.edits).toBe(2);
    expect(r.paths.sort()).toEqual(["/a.ts", "/b.ts"]);
  });

  it("multi-line edit spans across newlines", () => {
    const io = memIO({ "/a.ts": "line1\nline2\nline3" });
    // Replace "line2\nline3" with "REPLACED"
    applyWorkspaceEdit(
      {
        changes: {
          "file:///a.ts": [{
            range: { start: { line: 1, character: 0 }, end: { line: 2, character: 5 } },
            newText: "REPLACED",
          }],
        },
      },
      io,
    );
    expect(io.read("/a.ts")).toBe("line1\nREPLACED");
  });

  it("insertion (zero-length range) inserts without deleting", () => {
    const io = memIO({ "/a.ts": "ac" });
    applyWorkspaceEdit(
      {
        changes: {
          "file:///a.ts": [{ range: { start: { line: 0, character: 1 }, end: { line: 0, character: 1 } }, newText: "b" }],
        },
      },
      io,
    );
    expect(io.read("/a.ts")).toBe("abc");
  });

  it("documentChanges form: TextDocumentEdit applies edits", () => {
    const io = memIO({ "/a.ts": "hello" });
    const r = applyWorkspaceEdit(
      {
        documentChanges: [
          {
            textDocument: { uri: "file:///a.ts", version: 1 },
            edits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, newText: "WORLD" }],
          },
        ],
      },
      io,
    );
    expect(io.read("/a.ts")).toBe("WORLD");
    expect(r.files).toBe(1);
    expect(r.edits).toBe(1);
    expect(r.fileOps).toBe(0);
  });

  it("documentChanges: file ops counted but NOT performed", () => {
    const io = memIO({ "/a.ts": "x" });
    const r = applyWorkspaceEdit(
      {
        documentChanges: [
          {
            textDocument: { uri: "file:///a.ts", version: 1 },
            edits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: "y" }],
          },
          { kind: "create", uri: "file:///new.ts" },
          { kind: "rename", oldUri: "file:///old.ts", newUri: "file:///new2.ts" },
          { kind: "delete", uri: "file:///gone.ts" },
        ],
      },
      io,
    );
    expect(io.read("/a.ts")).toBe("y");
    expect(r.files).toBe(1);
    expect(r.edits).toBe(1);
    expect(r.fileOps).toBe(3);
  });

  it("both changes and documentChanges apply (union)", () => {
    const io = memIO({ "/a.ts": "11", "/b.ts": "22" });
    const r = applyWorkspaceEdit(
      {
        changes: {
          "file:///a.ts": [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 2 } }, newText: "AA" }],
        },
        documentChanges: [
          {
            textDocument: { uri: "file:///b.ts", version: 1 },
            edits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 2 } }, newText: "BB" }],
          },
        ],
      },
      io,
    );
    expect(io.read("/a.ts")).toBe("AA");
    expect(io.read("/b.ts")).toBe("BB");
    expect(r.files).toBe(2);
    expect(r.edits).toBe(2);
  });

  it("out-of-order edits (descending input) still apply correctly", () => {
    // Caller passes edits in descending position order; the sort must fix it.
    const io = memIO({ "/a.ts": "aaa bbb ccc" });
    applyWorkspaceEdit(
      {
        changes: {
          "file:///a.ts": [
            { range: { start: { line: 0, character: 8 }, end: { line: 0, character: 11 } }, newText: "ZZZ" },
            { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, newText: "XXX" },
          ],
        },
      },
      io,
    );
    expect(io.read("/a.ts")).toBe("XXX bbb ZZZ");
  });

  it("edits at same start position apply deterministically", () => {
    // Two zero-length insertions at the same point — both survive.
    const io = memIO({ "/a.ts": "x" });
    applyWorkspaceEdit(
      {
        changes: {
          "file:///a.ts": [
            { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: "A" },
            { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: "B" },
          ],
        },
      },
      io,
    );
    // Reverse-sort puts the second-insert first; both chars survive, x intact.
    expect(io.read("/a.ts")).toBe("ABx");
  });
});
