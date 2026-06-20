// The lspx daemon: one per workspace, owns the LSP server subprocess,
// listens on a Unix socket and dispatches the wire protocol defined in
// ./protocol.ts. Auto-spawned by client commands (see ./rpc.ts); run in
// the foreground with `lspx daemon`.
//
// Boot model: the socket starts listening IMMEDIATELY (so clients can
// connect at once), then the LSP server is spawned + initialized in the
// background. A client whose request arrives during boot is streamed
// progress lines ("starting <server>…", "initializing <server>…") and
// has its request deferred until boot completes. This makes every latency
// explicit and visible to the agent.

import { createServer, type Socket } from "node:net";
import { readFile, readdir, stat } from "node:fs/promises";
import { existsSync, unlinkSync, writeFileSync, appendFileSync } from "node:fs";
import { resolve, extname } from "node:path";
import {
  SOCKET_PATH,
  PID_PATH,
  LOG_PATH,
  ensureDirs,
  workspaceHash,
} from "../paths.ts";
import { LspClient, normalizeUri } from "../lsp/client.ts";
import { getLanguage, getServer, languageServers, languages } from "../registry/index.ts";
import type { DaemonRequest, DaemonResponse } from "./protocol.ts";
import { phase, type ProgressSink } from "../progress.ts";
import * as lsp from "vscode-languageserver-protocol";
import type { ResponseError } from "vscode-jsonrpc/node";

function log(...a: unknown[]): void {
  try {
    appendFileSync(LOG_PATH, a.map(String).join(" ") + "\n");
  } catch {
    /* best-effort logging only */
  }
}

/** Map a file extension to a language id via the registry. */
function languageIdForFile(path: string): string | undefined {
  const ext = extname(path).slice(1).toLowerCase();
  if (!ext) return undefined;
  for (const lang of languages()) {
    for (const ft of lang["file-types"] ?? []) {
      if (typeof ft === "string" && ft.toLowerCase() === ext) return lang.name;
    }
  }
  return undefined;
}

/** Reverse-lookup: which language does this server id belong to?
 *  Used to find a representative source file to open before workspace-symbol
 *  queries (tsserver loads its project lazily on first didOpen). */
function languageForServer(serverId: string): string | undefined {
  for (const lang of languages()) {
    const ids = lang["language-servers"] ?? [];
    if (ids.includes(serverId)) return lang.name;
  }
  return undefined;
}

/** Does `filename` match one of a language's file-type entries?
 *  Handles both string extensions ("py") and glob basenames ({glob:"Dockerfile"}). */
function matchesFileType(filename: string, types: (string | { glob: string })[]): boolean {
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

export interface DaemonOptions {
  workspaceRoot: string;
  /** Explicit server id; auto-detected from the registry otherwise. */
  serverId?: string;
  /** Force a specific language id (overrides file-extension detection). */
  languageId?: string;
}

export class Daemon {
  readonly workspaceRoot: string;
  readonly workspaceHash: string;
  private server: ReturnType<typeof createServer> | null = null;
  private client: LspClient | null = null;
  private ready = false;
  /** True once a workspace-symbol query has returned non-empty results,
   *  meaning rust-analyzer has finished building its background index.
   *  Before this, an empty result is treated as "still indexing" and retried. */
  private wsIndexReady = false;
  /** Language id resolved during boot (forced via --language, or derived
   *  from the detected server). Used to find a representative source file
   *  to open before workspace-symbol queries (tsserver needs a project
   *  loaded, which happens lazily on first didOpen). */
  private resolvedLanguageId: string | undefined;
  /** Server id resolved during boot (forced via --server, or auto-detected).
   *  Used to gate the lazy-project auto-open to servers that need it. */
  private resolvedServerId: string | undefined;
  /** Resolves when the LSP server is booted (or rejects on boot failure). */
  private bootPromise: Promise<void> | null = null;
  private bootError: Error | null = null;
  /** Sockets currently waiting for boot, to receive streamed progress. */
  private bootSubs = new Set<Socket>();

  constructor(private opts: DaemonOptions) {
    this.workspaceRoot = resolve(opts.workspaceRoot);
    this.workspaceHash = workspaceHash(this.workspaceRoot);
  }

  socketPath(): string {
    return SOCKET_PATH.replace("daemon.sock", `daemon-${this.workspaceHash}.sock`);
  }

  /** Promise that resolves once the LSP server is booted. */
  get booted(): Promise<void> | null {
    return this.bootPromise;
  }

  /**
   * Listen on the socket (fast), write the PID file, then start booting the
   * LSP server in the background. Returns as soon as the socket is accepting
   * connections — boot continues asynchronously, streaming progress to any
   * client that connects during it.
   */
  async start(onBootProgress?: ProgressSink): Promise<void> {
    ensureDirs();
    const sock = this.socketPath();
    if (existsSync(sock)) {
      try {
        unlinkSync(sock);
      } catch {
        /* listen() will surface a real conflict */
      }
    }
    this.server = createServer((s) => this.handle(s));
    await new Promise<void>((res, rej) => {
      this.server!.listen(sock, () => res());
      this.server!.on("error", rej);
    });
    writeFileSync(PID_PATH, String(process.pid));
    log(`daemon pid=${process.pid} socket=${sock} workspace=${this.workspaceRoot}`);
    // Boot in the background; clients connecting meanwhile are deferred +
    // streamed progress. We do NOT await here — start() must return fast.
    this.bootPromise = this.bootClient(onBootProgress);
  }

  private async bootClient(onProgress?: ProgressSink): Promise<void> {
    try {
      const serverId = this.opts.serverId ?? (await this.detectServer());
      if (!serverId) {
        throw new Error(
          "No language server configured for this workspace. " +
            "Run 'lspx doctor' to see what's available, or pass --server <id>.",
        );
      }
      this.resolvedLanguageId = this.opts.languageId ?? languageForServer(serverId);
      this.resolvedServerId = serverId;
      const def = getServer(serverId);
      if (!def) throw new Error(`Unknown server '${serverId}' in registry.`);
      const client = new LspClient({
        command: def.command,
        args: def.args,
        workspaceRoot: this.workspaceRoot,
      });
      const sink: ProgressSink = (m) => {
        log(`progress: ${m}`);
        this.broadcastProgress(m);
        onProgress?.(m);
      };
      await phase(`starting ${serverId}`, () => client.start(), sink);
      await phase(
        `initializing ${serverId}`,
        async () => {
          await client.initialize();
          await client.initialized();
        },
        sink,
      );
      this.client = client;
      this.ready = true;
      log(`lsp server '${serverId}' (${def.command}) ready`);
    } catch (err) {
      this.bootError = err instanceof Error ? err : new Error(String(err));
      log(`boot failed: ${this.bootError.message}`);
      // Let any waiting clients receive their error reply, then exit so the
      // stale socket doesn't linger.
      setImmediate(() => {
        void this.stop().finally(() => process.exit(1));
      });
    }
  }

  /** Send a progress line to every client currently waiting for boot. */
  private broadcastProgress(msg: string): void {
    const line = JSON.stringify({ progress: msg }) + "\n";
    for (const s of this.bootSubs) {
      try {
        s.write(line);
      } catch {
        /* socket gone */
      }
    }
  }

  /** Send a progress line to one client (used during request handling). */
  private progressTo(socket: Socket, msg: string): void {
    try {
      socket.write(JSON.stringify({ progress: msg }) + "\n");
    } catch {
      /* socket gone */
    }
  }

  /** Pick a server from the registry.
   *  1. Match by root markers (Cargo.toml → rust, go.mod → go, …).
   *  2. Fallback: scan top-level workspace files for a file-type hit across
   *     ALL languages (including ones with roots that just aren't present).
   *     A workspace with .py files but no pyproject.toml should still pick
   *     python; a workspace with .ts but no tsconfig should still pick tsserver. */
  async detectServer(): Promise<string | undefined> {
    for (const lang of languages()) {
      const roots = lang.roots ?? [];
      if (roots.length === 0 || !lang.name) continue;
      const hasRoot = roots.some((r) => existsSync(resolve(this.workspaceRoot, r)));
      if (!hasRoot) continue;
      const servers = languageServers(lang);
      if (servers.length > 0) return (lang["language-servers"] ?? [])[0];
    }
    // File-type fallback: no root markers matched, so scan top-level files.
    let entries: string[] = [];
    try {
      entries = await readdir(this.workspaceRoot);
    } catch {
      /* not a readable dir */
    }
    if (entries.length > 0) {
      for (const lang of languages()) {
        if (!lang.name) continue;
        const fts = lang["file-types"] ?? [];
        if (fts.length === 0) continue;
        if (!entries.some((f) => matchesFileType(f, fts))) continue;
        const servers = languageServers(lang);
        if (servers.length > 0) return (lang["language-servers"] ?? [])[0];
      }
    }
    return undefined;
  }

  private handle(socket: Socket): void {
    socket.setEncoding("utf-8");
    let buffer = "";
    socket.on("data", async (chunk) => {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        await this.dispatch(socket, line);
      }
    });
    socket.on("error", () => {
      /* client disconnects are expected */
    });
  }

  private async dispatch(socket: Socket, line: string): Promise<void> {
    const req = parseRequest(line);
    if (!req) {
      this.reply(socket, { ok: false, e: "invalid request line" });
      return;
    }
    // 'shutdown' is special: clean up fully *before* replying so the client
    // (e.g. 'lspx close') sees a consistent post-shutdown filesystem state.
    if (req.m === "shutdown") {
      try {
        await this.stop();
      } catch (err) {
        this.reply(socket, {
          ok: false,
          e: err instanceof Error ? err.message : String(err),
        });
        return;
      }
      this.reply(socket, { ok: true, r: { stopped: true } });
      return;
    }
    // Defer until boot completes; stream progress to this socket meanwhile.
    if (this.bootPromise && !this.ready) {
      this.bootSubs.add(socket);
      try {
        await this.bootPromise;
      } catch {
        /* handled via bootError below */
      } finally {
        this.bootSubs.delete(socket);
      }
    }
    if (this.bootError) {
      this.reply(socket, { ok: false, e: this.bootError.message });
      return;
    }
    if (!this.client) {
      this.reply(socket, { ok: false, e: "daemon not ready" });
      return;
    }
    try {
      const r = await this.route(socket, req);
      this.reply(socket, { ok: true, r });
    } catch (err) {
      const e = err instanceof Error ? err.message : String(err);
      this.reply(socket, { ok: false, e });
    }
  }

  private reply(socket: Socket, res: DaemonResponse): void {
    socket.write(JSON.stringify(res) + "\n");
  }

  private async route(socket: Socket, req: DaemonRequest): Promise<unknown> {
    const { m, a = [] } = req;
    switch (m) {
      case "ping":
        return { workspace: this.workspaceRoot, server: this.opts.serverId ?? "auto" };
      case "status":
        return this.status();
      case "open":
        return await this.openDoc(socket, String(a[0]));
      case "defs":
        return await this.query(socket, "defs", () =>
          this.client!.definition(this.client!.pos(this.abs(a[0]), Number(a[1]), Number(a[2]))),
        );
      case "decl":
        return await this.query(socket, "decl", () => this.client!.declaration(this.pos(a)));
      case "typedef":
        return await this.query(socket, "typedef", () => this.client!.typeDefinition(this.pos(a)));
      case "impl":
        return await this.query(socket, "impl", () => this.client!.implementation(this.pos(a)));
      case "refs":
        return await this.query(socket, "refs", () => this.client!.references(this.pos(a)));
      case "callers":
        return await this.callHierarchyQuery(socket, "incoming", a);
      case "callees":
        return await this.callHierarchyQuery(socket, "outgoing", a);
      case "supertypes":
        return await this.typeHierarchyQuery(socket, "super", a);
      case "subtypes":
        return await this.typeHierarchyQuery(socket, "sub", a);
      case "diagnostics":
        return await this.diagnosticsQuery(socket, a);
      case "hover":
        return await this.query(socket, "hover", () => this.client!.hover(this.pos(a)));
      case "docSymbols":
        return await this.query(socket, "docSymbols", () =>
          this.client!.documentSymbol(this.abs(a[0])),
        );
      case "wsSymbols":
        return await this.wsSymbolsQuery(socket, String(a[0] ?? ""));
      default:
        throw new Error(`unknown method: ${m}`);
    }
  }

  /** Wrap a query in a phase that reports "querying <m>…" only if it's slow.
   *  Retries on transient LSP errors (content modified / request cancelled)
   *  that the server emits while it is still settling after a didOpen. */
  private async query<T>(socket: Socket, method: string, fn: () => Promise<T>): Promise<T> {
    const MAX_ATTEMPTS = 6;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        return await phase(`querying ${method}`, fn, (m) => this.progressTo(socket, m));
      } catch (err) {
        lastErr = err;
        if (!isTransientLspError(err)) throw err;
        // The server is mid-indexing; back off briefly and retry.
        await sleep(150 * attempt);
        this.progressTo(socket, `retrying ${method} (server still indexing)`);
      }
    }
    throw lastErr;
  }

  /** Call hierarchy: who calls this function (incoming) or what does it
   *  call (outgoing). Two LSP round-trips — prepareCallHierarchy to resolve
   *  the function at the position, then incomingCalls/outgoingCalls on each
   *  prepared item. Returns the queried file path alongside the calls so
   *  the formatter knows where outgoing call sites live (they're in the
   *  queried document; incoming call sites are in each caller's document). */
  private async callHierarchyQuery(
    socket: Socket,
    direction: "incoming" | "outgoing",
    a: unknown[],
  ): Promise<{
    queriedFile: string;
    calls: lsp.CallHierarchyIncomingCall[] | lsp.CallHierarchyOutgoingCall[] | null;
  }> {
    const file = this.abs(String(a[0]));
    const items = await this.query(socket, direction, () =>
      this.client!.prepareCallHierarchy(
        this.client!.pos(file, Number(a[1]), Number(a[2])),
      ),
    );
    if (!items || items.length === 0) {
      return { queriedFile: file, calls: null };
    }
    // Usually one item; union results across all (e.g. overloaded symbols).
    const all: lsp.CallHierarchyIncomingCall[] | lsp.CallHierarchyOutgoingCall[] = [];
    for (const item of items) {
      const result =
        direction === "incoming"
          ? await this.query(socket, direction, () => this.client!.incomingCalls(item))
          : await this.query(socket, direction, () => this.client!.outgoingCalls(item));
      if (result) (all as unknown[]).push(...result);
    }
    return { queriedFile: file, calls: all.length > 0 ? all : null };
  }

  /** Type hierarchy: what does this type inherit from (supertypes) or what
   *  inherits from it (subtypes). Two LSP round-trips —
   *  prepareTypeHierarchy to resolve the type at the position, then
   *  supertypes/subtypes on each item. Mirrors callHierarchyQuery but
   *  simpler (no call sites — just the related type items themselves).
   *
   *  Unlike call hierarchy, the prepare step is wrapped in try/catch: some
   *  servers have the type-hierarchy protocol types in their binary but
   *  never activate the feature (typescript-language-server returns
   *  "Unhandled method textDocument/prepareTypeHierarchy"). The capability
   *  advertisement is accurate for clangd (advertises + handles) but we
   *  don't gate on it because a missing capability shouldn't surface as a
   *  raw RPC error — degrade to (no results) instead. */
  private async typeHierarchyQuery(
    socket: Socket,
    direction: "super" | "sub",
    a: unknown[],
  ): Promise<lsp.TypeHierarchyItem[] | null> {
    const file = this.abs(String(a[0]));
    let items: lsp.TypeHierarchyItem[] | null;
    try {
      items = await this.query(socket, direction, () =>
        this.client!.prepareTypeHierarchy(
          this.client!.pos(file, Number(a[1]), Number(a[2])),
        ),
      );
    } catch (err) {
      // Server doesn't handle type hierarchy (e.g. tsserver: "Unhandled
      // method"). Not an lspx error — the feature just isn't available.
      return null;
    }
    if (!items || items.length === 0) return null;
    // Usually one item; union results across all (e.g. overloads).
    const all: lsp.TypeHierarchyItem[] = [];
    for (const item of items) {
      const result =
        direction === "super"
          ? await this.query(socket, direction, () => this.client!.supertypes(item))
          : await this.query(socket, direction, () => this.client!.subtypes(item));
      if (result) all.push(...result);
    }
    return all.length > 0 ? all : null;
  }

  /** Diagnostics for a file. The server pushes these asynchronously via
   *  textDocument/publishDiagnostics after didOpen; we capture them in the
   *  client (the only source of truth — there's no LSP pull request). So
   *  this opens the file (triggering analysis + a diagnostics push) and
   *  returns whatever the client has stored. Cold starts (rust-analyzer
   *  building its index) and lazy servers (tsserver's empty-then-real push)
   *  mean the first snapshot can be empty; if so we wait for the next push
   *  that carries real results. */
  private async diagnosticsQuery(
    socket: Socket,
    a: unknown[],
  ): Promise<{ file: string; diagnostics: lsp.Diagnostic[] | null }> {
    const file = this.abs(String(a[0]));
    await this.openDoc(socket, String(a[0]));
    let diags = this.client!.diagnosticsFor(file);
    if (!diags || diags.length === 0) {
      this.progressTo(socket, "waiting for diagnostics…");
      const next = await this.client!.waitForNextDiagnostics(file, 1200);
      if (next) diags = next;
    }
    return { file, diagnostics: diags ?? null };
  }

  /** Workspace symbol search. rust-analyzer builds its symbol index
   *  asynchronously after initialize, so the first query (or first after a
   *  workspace change) can return [] before the index exists. We retry with
   *  backoff until non-empty, reporting the wait. Once we've seen a non-empty
   *  result we mark the index ready and never retry empties again.
   *
   *  If the server doesn't advertise workspaceSymbolProvider at all (zls,
   *  marksman, …), skip the retry loop — an empty result is a genuine miss,
   *  not a "still indexing" state, so we'd just waste seconds for nothing. */
  private async wsSymbolsQuery(
    socket: Socket,
    query: string,
  ): Promise<lsp.SymbolInformation[] | lsp.WorkspaceSymbol[] | null> {
    // Server doesn't support workspace symbols at all → return immediately.
    const supports = Boolean(this.client?.caps?.workspaceSymbolProvider);
    if (!supports) return null;
    // tsserver (and a few others) load their project lazily on the first
    // didOpen; a cold workspace/symbol then fails with "No Project.". Open a
    // representative source file first so the project is loaded. Gated to
    // servers known to need this — eager servers (rust-analyzer, gopls) index
    // the whole workspace on init and don't benefit.
    const LAZY_PROJECT_SERVERS = new Set([
      "typescript-language-server",
      "vtsls",
    ]);
    if (
      this.client &&
      this.client.openDocCount === 0 &&
      this.resolvedServerId &&
      LAZY_PROJECT_SERVERS.has(this.resolvedServerId)
    ) {
      const rep = await this.findRepresentativeSourceFile();
      if (rep) {
        this.progressTo(socket, `opening ${relLabel(rep)} to load project…`);
        await this.openDoc(socket, rep).catch(() => {
          /* best-effort: if the file can't be read, just proceed */
        });
      }
    }
    const MAX = 6;
    let reported = false;
    let last: lsp.SymbolInformation[] | lsp.WorkspaceSymbol[] | null = null;
    for (let attempt = 1; attempt <= MAX; attempt++) {
      try {
        last = await this.client!.workspaceSymbol(query);
      } catch (err) {
        if (!isTransientLspError(err)) throw err;
        last = null;
      }
      if (last && last.length > 0) {
        this.wsIndexReady = true;
        return last;
      }
      // Index already built earlier (we've seen non-empty before) → genuine miss.
      if (this.wsIndexReady) return last;
      if (attempt < MAX) {
        if (!reported) {
          this.progressTo(socket, "waiting for workspace index…");
          reported = true;
        }
        await sleep(350 * attempt);
      }
    }
    return last;
  }

  /** Find a source file in the workspace matching the resolved language,
   *  to open before a workspace-symbol query (loads the project for lazy
   *  servers like tsserver). Recurses up to depth 3, skipping node_modules
   *  and .git; returns the first match. Handles source layouts (src/),
   *  compiled packages (dist/*.d.ts), and flat repos alike. */
  private async findRepresentativeSourceFile(): Promise<string | null> {
    const langId = this.resolvedLanguageId ?? this.opts.languageId;
    if (!langId) return null;
    const lang = getLanguage(langId);
    const fts = lang?.["file-types"] ?? [];
    if (fts.length === 0) return null;
    const skip = new Set(["node_modules", ".git", "."]);
    const queue: Array<{ dir: string; depth: number }> = [
      { dir: this.workspaceRoot, depth: 0 },
    ];
    while (queue.length > 0) {
      const { dir, depth } = queue.shift()!;
      let entries: string[];
      try {
        entries = await readdir(dir);
      } catch {
        continue;
      }
      for (const f of entries) {
        if (skip.has(f)) continue;
        const full = resolve(dir, f);
        if (matchesFileType(f, fts)) {
          try {
            if ((await stat(full)).isFile()) return full;
          } catch {
            /* not readable, try next */
          }
        }
        // Recurse into subdirs (depth-limited).
        if (depth < 3 && !f.startsWith(".")) {
          queue.push({ dir: full, depth: depth + 1 });
        }
      }
    }
    return null;
  }

  private status(): Record<string, unknown> {
    const caps = this.client?.caps ?? {};
    return {
      workspace: this.workspaceRoot,
      socket: this.socketPath(),
      pid: process.pid,
      serverId: this.opts.serverId ?? "auto",
      ready: this.ready,
      capabilities: {
        definition: Boolean(caps.definitionProvider),
        declaration: Boolean(caps.declarationProvider),
        typeDefinition: Boolean(caps.typeDefinitionProvider),
        implementation: Boolean(caps.implementationProvider),
        references: Boolean(caps.referencesProvider),
        callHierarchy: Boolean(caps.callHierarchyProvider),
        typeHierarchy: Boolean(caps.typeHierarchyProvider),
        hover: Boolean(caps.hoverProvider),
        documentSymbol: Boolean(caps.documentSymbolProvider),
        workspaceSymbol: Boolean(caps.workspaceSymbolProvider),
        rename: Boolean(caps.renameProvider),
      },
    };
  }

  /** Open (or re-open) a doc; reports "indexing <file>…" while the server
   *  analyzes it. No-op if the file is already open with unchanged text. */
  private async openDoc(
    socket: Socket,
    path: string,
  ): Promise<{ uri: string; languageId: string }> {
    const abs = this.abs(path);
    const text = await readFile(abs, "utf-8");
    const languageId = this.opts.languageId ?? languageIdForFile(abs) ?? "plaintext";
    const uri = normalizeUri(abs);
    await phase(`indexing ${relLabel(path)}`, async () => {
      await this.client!.openDoc(uri, text, languageId);
    }, (m) => this.progressTo(socket, m));
    return { uri, languageId };
  }

  private abs(p: unknown): string {
    return resolve(this.workspaceRoot, String(p));
  }

  /** Build a TextDocumentPositionParams from method args: [file, line, char]. */
  private pos(a: unknown[]): lsp.TextDocumentPositionParams {
    return this.client!.pos(this.abs(a[0]), Number(a[1]), Number(a[2]));
  }

  async stop(): Promise<void> {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    if (this.client) {
      await this.client.shutdown();
      await this.client.exit();
      this.client = null;
    }
    try {
      if (existsSync(this.socketPath())) unlinkSync(this.socketPath());
    } catch {
      /* ignore */
    }
    try {
      if (existsSync(PID_PATH)) unlinkSync(PID_PATH);
    } catch {
      /* ignore */
    }
  }

  get isReady(): boolean {
    return this.ready;
  }
}

/** Short label for a path arg, for progress lines. */
function relLabel(p: string): string {
  const s = String(p);
  return s.length > 40 ? "…" + s.slice(-39) : s;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** LSP errors that are safe to retry: the server sent a transient
 *  "content modified" / "request cancelled" while it was still indexing. */
function isTransientLspError(err: unknown): boolean {
  const e = err as Partial<ResponseError> & Error;
  if (e && typeof e.code === "number") {
    return e.code === -32801 /* ContentModified */ || e.code === -32800; /* RequestCancelled */
  }
  return /content modified|request cancelled|cancelled/i.test(e?.message ?? "");
}

function parseRequest(line: string): DaemonRequest | null {
  const s = line.trim();
  if (!s) return null;
  try {
    return JSON.parse(s) as DaemonRequest;
  } catch {
    return null;
  }
}
