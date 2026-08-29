import { describe, expect, it, beforeEach } from "bun:test";
import { MANAGERS, planInstall, resetInstallAttempts, tryInstall } from "./install.ts";
import type { ServerDef } from "./registry/index.ts";
import { servers } from "./registry/index.ts";

const always = () => true;
const never = () => false;

beforeEach(resetInstallAttempts);

describe("install planning", () => {
  it("declines a server with no recipe, quoting the manual hint", () => {
    const def: ServerDef = { command: "hls", install: "ghcup install hls" };
    const plan = planInstall(def, always);
    expect(plan.kind).toBe("declined");
    expect(plan.kind === "declined" && plan.reason).toContain("ghcup install hls");
  });

  it("declines when the package manager is absent rather than guessing", () => {
    const def: ServerDef = {
      command: "csharp-ls",
      "auto-install": { manager: "dotnet", packages: ["csharp-ls"] },
    };
    expect(planInstall(def, never).kind).toBe("declined");
    expect(planInstall(def, always).kind).toBe("install");
  });

  it("declines an unknown manager", () => {
    const def: ServerDef = {
      command: "x",
      "auto-install": { manager: "brew", packages: ["x"] },
    };
    const plan = planInstall(def, always);
    expect(plan.kind === "declined" && plan.reason).toContain("brew");
  });

  // Registry values reach a child process, so they must never be a shell string.
  it("builds argv arrays, never a shell string", () => {
    const def: ServerDef = {
      command: "typescript-language-server",
      "auto-install": {
        manager: "npm",
        packages: ["typescript-language-server", "typescript"],
      },
    };
    const plan = planInstall(def, always);
    expect(plan).toMatchObject({
      kind: "install",
      bin: "npm",
      commands: [["install", "--global", "typescript-language-server", "typescript"]],
    });
  });

  // `dotnet tool install` takes one package id, unlike npm.
  it("splits managers that accept a single package per invocation", () => {
    expect(MANAGERS.dotnet.commands(["a", "b"])).toEqual([
      ["tool", "install", "--global", "a"],
      ["tool", "install", "--global", "b"],
    ]);
    expect(MANAGERS.npm.commands(["a", "b"])).toEqual([
      ["install", "--global", "a", "b"],
    ]);
  });
});

describe("install attempts", () => {
  it("reports failure when the binary is still missing afterwards", async () => {
    const def: ServerDef = {
      command: "definitely-not-a-real-binary",
      "auto-install": { manager: "npm", packages: [] },
    };
    const r = await tryInstall("fake", def, always);
    expect(r.installed).toBe(false);
  });

  // One broken recipe must not stall every later query in the process.
  it("does not retry a recipe that already failed", async () => {
    const def: ServerDef = { command: "nope", install: "see the docs" };
    const first = await tryInstall("nope", def, always);
    const second = await tryInstall("nope", def, always);
    expect(first.reason).toContain("see the docs");
    expect(second.reason).toContain("earlier install attempt failed");
  });
});

describe("registry recipes", () => {
  it("every auto-install names a known manager and at least one package", () => {
    for (const [id, def] of Object.entries(servers())) {
      const auto = def["auto-install"];
      if (!auto) continue;
      expect(MANAGERS[auto.manager], `${id} manager`).toBeDefined();
      expect(auto.packages.length, `${id} packages`).toBeGreaterThan(0);
    }
  });

  it("covers the servers the team relies on", () => {
    const all = servers();
    for (const id of ["typescript-language-server", "csharp-ls"]) {
      expect(all[id]?.["auto-install"], id).toBeDefined();
    }
  });
});
