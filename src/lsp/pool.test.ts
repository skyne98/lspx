import { describe, expect, it } from "bun:test";
import { LspClientPool, matchesFileType } from "./pool.ts";

describe("LspClientPool routing", () => {
  const pool = new LspClientPool({ workspaceRoot: process.cwd() });

  it("uses the LSP csharp id without losing the c-sharp registry route", () => {
    expect(pool.languageIdForFile("Program.cs")).toBe("csharp");
    expect(pool.languageIdsForServer("csharp-ls")).toContain("c-sharp");
  });

  it("routes extensionless glob filenames", () => {
    expect(pool.languageIdForFile("services/api/Dockerfile")).toBe("dockerfile");
  });

  it("prefers a specific basename glob over a generic extension", () => {
    expect(pool.languageIdForFile("deploy/docker-compose.yml")).toBe("docker-compose");
  });

  it("records every language served by a shared server", () => {
    expect(pool.languageIdsForServer("typescript-language-server")).toEqual(
      expect.arrayContaining(["typescript", "javascript", "jsx", "tsx"]),
    );
  });

  it("matches case-insensitive extension entries", () => {
    expect(matchesFileType("analysis.R", ["R"])).toBe(true);
  });
});
