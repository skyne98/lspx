// Runtime paths for the lspx daemon and per-workspace state.

import { mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const XDG_RUNTIME = process.env.XDG_RUNTIME_DIR || tmpdir();
const XDG_DATA = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");

/** Root dir for all lspx runtime artifacts. */
export const LSPX_DIR = process.env.LSPX_DIR || join(XDG_DATA, "lspx");

/** Directory holding the daemon socket, pid file, and logs. */
export const RUNTIME_DIR = join(LSPX_DIR, "runtime");

/** Directory holding per-workspace caches and ref tables. */
export const WORKSPACE_DIR = join(LSPX_DIR, "workspaces");

/** Path to the single daemon Unix socket. */
export const SOCKET_PATH = join(RUNTIME_DIR, "daemon.sock");

/** PID file used for health-checking and auto-restart. */
export const PID_PATH = join(RUNTIME_DIR, "daemon.pid");

/** Daemon stdout/stderr log. */
export const LOG_PATH = join(RUNTIME_DIR, "daemon.log");

export function ensureDirs(): void {
  for (const dir of [LSPX_DIR, RUNTIME_DIR, WORKSPACE_DIR]) {
    mkdirSync(dir, { recursive: true });
  }
}

/** A short, filesystem-safe hash of a workspace path (for cache keys). */
export function workspaceHash(ws: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < ws.length; i++) {
    h ^= ws.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export function workspaceDir(ws: string): string {
  return join(WORKSPACE_DIR, workspaceHash(ws));
}
