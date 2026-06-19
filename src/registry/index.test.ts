import { describe, it, expect } from "bun:test";
import { loadRegistry, languageServerStatus, getLanguage } from "./index.ts";

describe("registry", () => {
  it("loads the TOML without throwing", () => {
    const r = loadRegistry();
    expect(Object.keys(r["language-server"]).length).toBeGreaterThan(20);
    expect(r.language.length).toBeGreaterThan(20);
  });

  it("rust-analyzer server has a command", () => {
    const r = loadRegistry();
    expect(r["language-server"]["rust-analyzer"]?.command).toBe("rust-analyzer");
  });

  it("typescript uses typescript-language-server", () => {
    const ts = getLanguage("typescript");
    expect(ts?.["language-servers"]).toContain("typescript-language-server");
  });

  it("every language's servers resolve to a server def", () => {
    const r = loadRegistry();
    const serverIds = new Set(Object.keys(r["language-server"]));
    for (const lang of r.language) {
      for (const id of lang["language-servers"] ?? []) {
        expect(serverIds.has(id)).toBe(true);
      }
    }
  });

  it("rust-analyzer is found on PATH (this machine has it)", () => {
    const rust = getLanguage("rust")!;
    const status = languageServerStatus(rust);
    const ra = status.find((s) => s.id === "rust-analyzer")!;
    expect(ra.path).toBeTruthy();
  });
});
