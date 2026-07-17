import { describe, expect, it } from "bun:test";
import { locateUniqueExact } from "./exact.ts";

describe("locateUniqueExact", () => {
  it("returns an LSP range for one multiline match", () => {
    expect(locateUniqueExact("aa\nhello\nworld\nzz", "hello\nworld")).toEqual({
      kind: "found",
      range: {
        start: { line: 1, character: 0 },
        end: { line: 2, character: 5 },
      },
    });
  });

  it("rejects a missing match", () => {
    expect(locateUniqueExact("abc", "x")).toEqual({ kind: "not-found" });
  });

  it("rejects repeated text instead of silently editing the first match", () => {
    expect(locateUniqueExact("same x same x same", "same")).toEqual({
      kind: "ambiguous",
      occurrences: 3,
    });
  });

  it("rejects empty oldText", () => {
    expect(locateUniqueExact("abc", "")).toEqual({
      kind: "invalid",
      message: "oldText must not be empty",
    });
  });
});
