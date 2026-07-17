import { describe, expect, test } from "bun:test";
import { WorkspaceEditTransaction, plannedEditsFromWorkspaceEdit, type PlannedEdit } from "./transaction.ts";
import type { EditIO } from "./edit.ts";

function memIO(files: Record<string, string>): EditIO {
  const state = { ...files };
  return {
    read: (p) => state[p],
    write: (p, t) => { state[p] = t; },
  };
}

function range(sl: number, sc: number, el: number, ec: number) {
  return { start: { line: sl, character: sc }, end: { line: el, character: ec } };
}

const SRC = "line0\nline1\nline2\nline3\n";

describe("WorkspaceEditTransaction.validate", () => {
  test("aborts on a stale-target (expected text no longer matches)", () => {
    const edits: PlannedEdit[] = [{
      path: "/a",
      range: range(1, 0, 1, 5),
      newText: "REPLACED",
      expectedText: "WRONG", // disk has "line1", not "WRONG"
      expectedHash: undefined,
    }];
    const t = new WorkspaceEditTransaction(edits, memIO({ "/a": SRC }));
    const plan = t.validate();
    expect(plan.aborted).toBe(true);
    expect(plan.rejected[0].code).toBe("stale-target");
  });

  test("aborts on a stale-target (hash mismatch)", () => {
    const edits: PlannedEdit[] = [{
      path: "/a",
      range: range(1, 0, 1, 5),
      newText: "REPLACED",
      expectedHash: "deadbeefdeadbeef", // wrong digest
    }];
    const t = new WorkspaceEditTransaction(edits, memIO({ "/a": SRC }));
    expect(t.validate().aborted).toBe(true);
  });

  test("accepts when expected text matches disk", () => {
    const edits: PlannedEdit[] = [{
      path: "/a",
      range: range(1, 0, 1, 5),
      newText: "REPLACED",
      expectedText: "line1",
    }];
    const t = new WorkspaceEditTransaction(edits, memIO({ "/a": SRC }));
    const plan = t.validate();
    expect(plan.aborted).toBe(false);
    expect(plan.staged[0].staged).toBe("line0\nREPLACED\nline2\nline3\n");
  });

  test("aborts on overlapping edits in the same file", () => {
    const edits: PlannedEdit[] = [
      { path: "/a", range: range(1, 0, 2, 3), newText: "A" },
      { path: "/a", range: range(1, 4, 1, 6), newText: "B" }, // starts inside the first
    ];
    const t = new WorkspaceEditTransaction(edits, memIO({ "/a": SRC }));
    const plan = t.validate();
    expect(plan.aborted).toBe(true);
    expect(plan.rejected.some((r) => r.code === "overlapping-edits")).toBe(true);
  });

  test("accepts adjacent (non-overlapping) edits", () => {
    const edits: PlannedEdit[] = [
      { path: "/a", range: range(0, 0, 0, 5), newText: "L0" },
      { path: "/a", range: range(1, 0, 1, 5), newText: "L1" },
    ];
    const t = new WorkspaceEditTransaction(edits, memIO({ "/a": SRC }));
    expect(t.validate().aborted).toBe(false);
  });
});

describe("WorkspaceEditTransaction.apply", () => {
  test("writes staged text and reports before/after hashes", () => {
    const io = memIO({ "/a": SRC });
    const edits: PlannedEdit[] = [
      { path: "/a", range: range(1, 0, 1, 5), newText: "REPLACED", expectedText: "line1" },
    ];
    const res = new WorkspaceEditTransaction(edits, io).validate() && new WorkspaceEditTransaction(edits, io).apply();
    expect(res.files).toBe(1);
    expect(res.edits).toBe(1);
    expect(res.rolledBack).toBe(false);
    expect(io.read("/a")).toBe("line0\nREPLACED\nline2\nline3\n");
    expect(res.beforeHashes["/a"]).not.toBe(res.afterHashes["/a"]);
  });

  test("multi-file staging applies all files atomically", () => {
    const io = memIO({ "/a": "aaa\n", "/b": "bbb\n" });
    const edits: PlannedEdit[] = [
      { path: "/a", range: range(0, 0, 0, 3), newText: "AAA" },
      { path: "/b", range: range(0, 0, 0, 3), newText: "BBB" },
    ];
    const res = new WorkspaceEditTransaction(edits, io).apply();
    expect(res.files).toBe(2);
    expect(io.read("/a")).toBe("AAA\n");
    expect(io.read("/b")).toBe("BBB\n");
  });

  test("refuses to apply when aborted (precondition failed)", () => {
    const io = memIO({ "/a": SRC });
    const edits: PlannedEdit[] = [{
      path: "/a",
      range: range(1, 0, 1, 5),
      newText: "REPLACED",
      expectedText: "WRONG",
    }];
    const res = new WorkspaceEditTransaction(edits, io).apply();
    expect(res.files).toBe(0);
    expect(io.read("/a")).toBe(SRC); // unchanged
  });

  test("rolls back if a write fails mid-transaction", () => {
    const state: Record<string, string> = { "/a": "aaa\n", "/b": "bbb\n" };
    let writeCount = 0;
    const io: EditIO = {
      read: (p) => state[p],
      write: (p, t) => {
        writeCount++;
        if (p === "/b") throw new Error("disk full");
        state[p] = t;
      },
    };
    const edits: PlannedEdit[] = [
      { path: "/a", range: range(0, 0, 0, 3), newText: "AAA" },
      { path: "/b", range: range(0, 0, 0, 3), newText: "BBB" },
    ];
    expect(() => new WorkspaceEditTransaction(edits, io).apply()).toThrow("disk full");
    expect(state["/a"]).toBe("aaa\n"); // rolled back to original
  });
});

describe("plannedEditsFromWorkspaceEdit", () => {
  test("builds planned edits with expected-text preconditions from a changes-form WorkspaceEdit", () => {
    const io = memIO({ "/a": SRC });
    const wsEdit = {
      changes: {
        "file:///a": [{ range: range(1, 0, 1, 5), newText: "REPLACED" }],
      },
    };
    const planned = plannedEditsFromWorkspaceEdit(wsEdit, io);
    expect(planned).toHaveLength(1);
    expect(planned[0].path).toBe("/a");
    expect(planned[0].expectedText).toBe("line1");
    expect(planned[0].expectedHash).toBeTruthy();
  });

  test("handles documentChanges TextDocumentEdit form", () => {
    const io = memIO({ "/a": SRC });
    const wsEdit = {
      documentChanges: [
        { textDocument: { uri: "file:///a", version: 1 }, edits: [{ range: range(0, 0, 0, 5), newText: "LINE0" }] },
      ],
    };
    const planned = plannedEditsFromWorkspaceEdit(wsEdit, io);
    expect(planned[0].expectedText).toBe("line0");
  });
});
