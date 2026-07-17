// LspClientPool — owns every language-server subprocess for a workspace.
//
// Replaces the daemon's former single `LspClient` field with a lazy,
// registry-routed pool. The *primary* server (auto-detected from root
// markers / file types, or forced via --server) boots eagerly so the common
// single-language workspace keeps its one-cold-boot UX. Every other server
// boots lazily the first time a file of its language is opened or queried,
// so a polyglot workspace only pays for the languages it actually touches.
//
// Routing: file extension → language id → first *installed* server for that
// language (registry priority order). `--server` / `--language` override
// routing and force a single server for everything, preserving the old
// escape hatches.

import { existsSync, readdirSync, statSync } from "node:fs";
import { resolve, extname, basename } from "node:path";
import { LspClient } from "./client.ts";
import { getLanguage, getServer, languages, whichServer, type LanguageDef, type ServerDef } from "../registry/index.ts";
import { phase, type ProgressSink } from "../progress.ts";

export interface PoolOptions {
  workspaceRoot: string;
  /** Force a single server id for everything (overrides routing). */
  serverId?: string;
  /** Force a single language id (overrides extension detection). */
  languageId?: string;
}

export type ClientState = "booting" | "ready" | "error";

export interface ClientEntry {
  serverId: string;
  client: LspClient;
  state: ClientState;
  /** Resolves when boot completes (success or failure). Awaited by
   *  `forServer` so concurrent first-callers share one boot. */
  bootPromise: Promise<void>;
  /** Languages known to be served by this client (for status display). */
  languageIds: Set<string>;
}

export class LspClientPool {
  readonly workspaceRoot: string;
  private clients = new Map<string, ClientEntry>();
  /** The primary server id (forced or auto-detected). Booted eagerly. */
  private primaryId: string | undefined;
  private primaryBootError: Error | null = null;

  constructor(private opts: PoolOptions) {
    this.workspaceRoot = resolve(opts.workspaceRoot);
  }

  get forcedServerId(): string | undefined {
    return this.opts.serverId;
  }
  get forcedLanguageId(): string | undefined {
    return this.opts.languageId;
  }

  /** File extension → language id (registry name, with the c-sharp→csharp
   *  normalization some servers require on didOpen). */
  languageIdForFile(path: string): string | undefined {
    if (this.opts.languageId) return this.opts.languageId;
    const ext = extname(path).slice(1).toLowerCase();
    if (!ext) return undefined;
    for (const lang of languages()) {
      for (const ft of lang["file-types"] ?? []) {
        if (typeof ft === "string" && ft.toLowerCase() === ext) {
          return lang.name === "c-sharp" ? "csharp" : lang.name;
        }
      }
    }
    return undefined;
  }

  /** Which language id does this server belong to? (Reverse lookup for
   *  status + representative-file selection.) */
  languageForServer(serverId: string): string | undefined {
    for (const lang of languages()) {
      if ((lang["language-servers"] ?? []).includes(serverId)) return lang.name;
    }
    return undefined;
  }

  /** Resolve the server id that should handle a file.
   *  - Forced --server wins.
   *  - Otherwise: language → first *installed* server for that language. */
  serverIdForFile(path: string): string | undefined {
    if (this.opts.serverId) return this.opts.serverId;
    const langId = this.languageIdForFile(path);
    if (!langId) return undefined;
    const lang = getLanguage(langId);
    if (!lang) return undefined;
    return firstInstalledServer(lang);
  }

  /** Auto-detect the primary server for the workspace.
   *  1. Root markers (Cargo.toml → rust, go.mod → go, …).
   *  2. File-type fallback: scan top-level files for a hit across ALL
   *     languages (a .py repo with no pyproject.toml still picks python). */
  detectPrimary(): string | undefined {
    if (this.opts.serverId) return this.opts.serverId;
    for (const lang of languages()) {
      const roots = lang.roots ?? [];
      if (roots.length === 0 || !lang.name) continue;
      if (!roots.some((r) => existsSync(resolve(this.workspaceRoot, r)))) continue;
      const installed = firstInstalledServer(lang);
      if (installed) return installed;
    }
    // File-type fallback.
    let entries: string[] = [];
    try {
      entries = readdirSync(this.workspaceRoot);
    } catch {
      /* not a readable dir */
    }
    for (const lang of languages()) {
      if (!lang.name || !(lang["file-types"] ?? []).length) continue;
      if (!entries.some((f) => matchesFileType(f, lang["file-types"] ?? []))) continue;
      const installed = firstInstalledServer(lang);
      if (installed) return installed;
    }
    return undefined;
  }

  /** Boot the primary server eagerly. Preserves the old single-boot UX:
   *  the common single-language workspace pays exactly one cold boot. */
  async bootPrimary(onProgress?: ProgressSink): Promise<void> {
    const id = this.detectPrimary();
    if (!id) {
      this.primaryBootError = new Error(
        "No language server configured for this workspace. " +
          "Run 'lspx doctor' to see what's available, or pass --server <id>.",
      );
      throw this.primaryBootError;
    }
    this.primaryId = id;
    try {
      await this.forServer(id, onProgress);
    } catch (err) {
      this.primaryBootError = err instanceof Error ? err : new Error(String(err));
      throw this.primaryBootError;
    }
  }

  /** The primary client (forced --server, or the auto-detected one). Null
   *  until boot completes (or if it failed). */
  primary(): LspClient | null {
    if (!this.primaryId) return null;
    const e = this.clients.get(this.primaryId);
    return e?.state === "ready" ? e.client : null;
  }

  primaryServerId(): string | undefined {
    return this.primaryId ?? this.opts.serverId;
  }

  primaryBootFailure(): Error | null {
    return this.primaryBootError;
  }

  /** Get/boot the client for a file's language. */
  async forFile(path: string, onProgress?: ProgressSink): Promise<LspClient> {
    const id = this.serverIdForFile(path);
    if (!id) {
      throw new Error(
        `No language server for '${basename(path)}'. Run 'lspx doctor' or pass --server <id>.`,
      );
    }
    return this.forServer(id, onProgress);
  }

  /** Get/boot the client for a language id. */
  async forLanguage(languageId: string, onProgress?: ProgressSink): Promise<LspClient> {
    if (this.opts.serverId) return this.forServer(this.opts.serverId, onProgress);
    const lang = getLanguage(languageId);
    const id = lang ? firstInstalledServer(lang) : undefined;
    if (!id) throw new Error(`No installed server for language '${languageId}'.`);
    return this.forServer(id, onProgress);
  }

  /** Get/boot a specific server. Concurrent first-callers share one boot. */
  async forServer(serverId: string, onProgress?: ProgressSink): Promise<LspClient> {
    const existing = this.clients.get(serverId);
    if (existing) {
      await existing.bootPromise;
      if (existing.state === "error") {
        throw new Error(`language server '${serverId}' failed to boot`);
      }
      return existing.client;
    }
    const def = getServer(serverId);
    if (!def) throw new Error(`Unknown server '${serverId}' in registry.`);
    if (!whichServer(def)) {
      throw new Error(`language server '${serverId}' (${def.command}) not found on $PATH.`);
    }
    const client = new LspClient({
      command: def.command,
      args: def.args,
      workspaceRoot: this.workspaceRoot,
    });
    const entry: ClientEntry = {
      serverId,
      client,
      state: "booting",
      bootPromise: Promise.resolve(),
      languageIds: new Set(),
    };
    this.clients.set(serverId, entry);
    const lang = this.languageForServer(serverId);
    if (lang) entry.languageIds.add(lang);
    entry.bootPromise = this.bootOne(entry, def, onProgress);
    await entry.bootPromise;
    if (entry.state === "error") {
      throw new Error(`language server '${serverId}' failed to boot`);
    }
    return entry.client;
  }

  private async bootOne(
    entry: ClientEntry,
    def: ServerDef,
    onProgress?: ProgressSink,
  ): Promise<void> {
    const sink: ProgressSink = (m) => onProgress?.(m);
    try {
      await phase(`starting ${entry.serverId}`, () => entry.client.start(), sink);
      await phase(`initializing ${entry.serverId}`, async () => {
        await entry.client.initialize();
        await entry.client.initialized();
      }, sink);
      entry.state = "ready";
    } catch (err) {
      entry.state = "error";
      try {
        await entry.client.exit();
      } catch {
        /* best-effort */
      }
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  /** All currently-known client entries (booted, booting, or failed). */
  active(): ClientEntry[] {
    return [...this.clients.values()];
  }

  /** All ready clients (for workspace-wide fanout like workspace/symbol). */
  readyClients(): { serverId: string; client: LspClient }[] {
    return [...this.clients.values()]
      .filter((e) => e.state === "ready")
      .map((e) => ({ serverId: e.serverId, client: e.client }));
  }

  async closeAll(): Promise<void> {
    const entries = [...this.clients.values()];
    this.clients.clear();
    await Promise.all(
      entries.map(async (e) => {
        try {
          await e.client.shutdown();
        } catch {
          /* server may be gone */
        }
        try {
          await e.client.exit();
        } catch {
          /* ignore */
        }
      }),
    );
  }
}

/** First installed server for a language, in registry priority order. */
function firstInstalledServer(lang: LanguageDef): string | undefined {
  const ids = lang["language-servers"] ?? [];
  return ids.find((id) => {
    const def = getServer(id);
    return Boolean(def && whichServer(def));
  });
}

/** Does `filename` match one of a language's file-type entries?
 *  Handles string extensions ("py") and glob basenames ({glob:"Dockerfile"}). */
export function matchesFileType(
  filename: string,
  types: (string | { glob: string })[],
): boolean {
  const lower = filename.toLowerCase();
  const ext = extname(lower).slice(1);
  for (const ft of types) {
    if (typeof ft === "string") {
      if (ft === ext || lower === ft) return true;
    } else if (ft?.glob) {
      if (lower === ft.glob.toLowerCase()) return true;
    }
  }
  return false;
}

/** Find a representative source file for a language id in the workspace
 *  (for lazy-project servers like tsserver that load a project on first
 *  didOpen). Recurses up to depth 3, skipping node_modules / .git. */
export function findRepresentativeSourceFile(
  workspaceRoot: string,
  languageId: string,
): string | null {
  const lang = getLanguage(languageId);
  const fts = lang?.["file-types"] ?? [];
  if (fts.length === 0) return null;
  const skip = new Set(["node_modules", ".git", "."]);
  const queue: Array<{ dir: string; depth: number }> = [
    { dir: workspaceRoot, depth: 0 },
  ];
  while (queue.length > 0) {
    const { dir, depth } = queue.shift()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of entries) {
      if (skip.has(f)) continue;
      const full = resolve(dir, f);
      if (matchesFileType(f, fts)) {
        try {
          if (statSync(full).isFile()) return full;
        } catch {
          /* not readable */
        }
      }
      if (depth < 3 && !f.startsWith(".")) {
        queue.push({ dir: full, depth: depth + 1 });
      }
    }
  }
  return null;
}
