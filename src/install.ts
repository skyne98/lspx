// Lazy, on-demand installation of language servers.
//
// The registry's `install` field is a human-readable hint and cannot be
// executed: a third of the entries are bare URLs or prose, and the rest span
// eleven package managers. So auto-install is opt-in per server via a
// structured `auto-install`, and only for recipes that are unambiguous and
// cross-platform.
//
// Commands are argv arrays, never shell strings, so nothing in the registry
// can be interpreted as shell syntax.

import { spawn } from "node:child_process";
import type { ServerDef } from "./registry/index.ts";
import type { ProgressSink } from "./progress.ts";

interface Manager {
  /** Must be on PATH for this manager to be usable. */
  bin: string;
  /** One argv per invocation: some managers take many packages, some one. */
  commands: (packages: string[]) => string[][];
}

export const MANAGERS: Record<string, Manager> = {
  npm: {
    bin: "npm",
    commands: (packages) => [["install", "--global", ...packages]],
  },
  // `dotnet tool install` accepts a single package id per invocation.
  dotnet: {
    bin: "dotnet",
    commands: (packages) => packages.map((p) => ["tool", "install", "--global", p]),
  },
};

export type InstallPlan =
  | { kind: "declined"; reason: string }
  | { kind: "install"; manager: string; bin: string; commands: string[][] };

/** What, if anything, can be installed for a server that is not on PATH. */
export function planInstall(
  def: ServerDef,
  managerOnPath: (bin: string) => boolean,
): InstallPlan {
  const auto = def["auto-install"];
  if (!auto) {
    return {
      kind: "declined",
      reason: def.install
        ? `no automatic recipe; install manually: ${def.install}`
        : "no automatic recipe",
    };
  }
  const manager = MANAGERS[auto.manager];
  if (!manager) {
    return { kind: "declined", reason: `unknown package manager '${auto.manager}'` };
  }
  if (!managerOnPath(manager.bin)) {
    return { kind: "declined", reason: `'${manager.bin}' is not on PATH` };
  }
  if (auto.packages.length === 0) {
    return { kind: "declined", reason: "no packages listed" };
  }
  return {
    kind: "install",
    manager: auto.manager,
    bin: manager.bin,
    commands: manager.commands(auto.packages),
  };
}

/** How long a single install invocation may run. */
export const INSTALL_TIMEOUT_MS = 300_000;

// A failed install stays failed for the life of the process: retrying on every
// query would turn one broken recipe into a stall on each request.
const failed = new Set<string>();

export function installAttempted(serverId: string): boolean {
  return failed.has(serverId);
}

/** For tests, which run several scenarios in one process. */
export function resetInstallAttempts(): void {
  failed.clear();
}

function run(bin: string, args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      stdio: ["ignore", "ignore", "pipe"],
      // `npm` on Windows is a .cmd shim, which CreateProcess cannot exec directly.
      shell: process.platform === "win32",
    });
    let stderr = "";
    child.stderr?.on("data", (c) => {
      stderr += c.toString();
    });
    const timer = setTimeout(() => child.kill(), INSTALL_TIMEOUT_MS);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: 1, stderr: String(e) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stderr });
    });
  });
}

/** Install a missing server, if it declares a usable recipe.
 *
 *  Returns true only when the binary is on PATH afterwards, so a package that
 *  installs into a directory PATH does not cover still counts as a failure
 *  rather than being reported as success. */
export async function tryInstall(
  serverId: string,
  def: ServerDef,
  which: (bin: string) => boolean,
  onProgress?: ProgressSink,
): Promise<{ installed: boolean; reason?: string }> {
  if (failed.has(serverId)) {
    return { installed: false, reason: "an earlier install attempt failed" };
  }
  const plan = planInstall(def, which);
  if (plan.kind === "declined") {
    failed.add(serverId);
    return { installed: false, reason: plan.reason };
  }

  onProgress?.(`installing ${serverId} via ${plan.manager}…`);
  for (const args of plan.commands) {
    const { code, stderr } = await run(plan.bin, args);
    if (code !== 0) {
      failed.add(serverId);
      const detail = stderr.trim().split("\n").filter(Boolean).pop();
      return { installed: false, reason: detail || `${plan.bin} exited ${code}` };
    }
  }

  if (!which(def.command)) {
    failed.add(serverId);
    return {
      installed: false,
      reason: `installed, but '${def.command}' is still not on PATH`,
    };
  }
  return { installed: true };
}
