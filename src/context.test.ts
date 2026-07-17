import { describe, expect, it } from "bun:test";
import { packContext, type ContextCandidate } from "./context.ts";

const candidate = (key: string, section: ContextCandidate["section"], priority: number, content: string) => ({
  key, section, priority, content, value: { key, text: content },
});

describe("packContext", () => {
  it("ranks deterministically, deduplicates, and accounts omissions", () => {
    const packed = packContext(
      { name: "target", source: "12345" },
      [
        candidate("b", "calls", 2, "bbbb"),
        candidate("a", "containers", 1, "aaaa"),
        candidate("a", "containers", 1, "duplicate"),
        candidate("c", "types", 3, "cccc"),
      ],
      256,
    );
    expect(packed.included.containers).toEqual([{ key: "a", text: "aaaa" }]);
    expect(packed.included.calls).toEqual([{ key: "b", text: "bbbb" }]);
    expect(packed.included.types).toEqual([{ key: "c", text: "cccc" }]);
    expect(packed.omitted.total).toBe(0);
  });

  it("explicitly truncates an oversized target", () => {
    const packed = packContext({ source: "x".repeat(300) }, [], 256);
    expect(packed.target.source.length).toBe(256);
    expect(packed.target).toMatchObject({ truncated: true, omittedCharacters: 44 });
    expect(packed.budget).toMatchObject({ limit: 256, used: 256, remaining: 0 });
  });

  it("omits whole lower-priority entries when the budget is exhausted", () => {
    const packed = packContext(
      { source: "x".repeat(250) },
      [candidate("a", "calls", 1, "123456"), candidate("b", "types", 2, "z")],
      256,
    );
    expect(packed.included.calls).toHaveLength(1);
    expect(packed.included.types).toHaveLength(0);
    expect(packed.omitted).toMatchObject({ types: 1, total: 1 });
  });
});
