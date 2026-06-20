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
import { resolve, extname, basename } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
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
import { uriToPath } from "../lsp/client.ts";

const execFileP = promisify(execFile);

/** SymbolKinds that represent callable symbols (have a call graph). */
const CALLABLE_KINDS = new Set<number>([
  lsp.SymbolKind.Function,
  lsp.SymbolKind.Method,
  lsp.SymbolKind.Constructor,
]);

/** Symbol kinds that are noise inside function/method bodies (local vars,
 *  local consts, literals). Filtered from the codemap when nested inside a
 *  callable. Module-level constants are kept. */
const LOCAL_NOISE_KINDS = new Set<number>([
  lsp.SymbolKind.Variable,
  lsp.SymbolKind.Constant,
  lsp.SymbolKind.Property,
  lsp.SymbolKind.String,
  lsp.SymbolKind.Number,
  lsp.SymbolKind.Boolean,
  lsp.SymbolKind.Array,
  lsp.SymbolKind.Null,
  lsp.SymbolKind.Key,
]);

/** Codemap wire types (raw — kind is numeric, file is absolute). */
interface CodemapFile { file: string; symbols: CodemapSymbol[] }
interface CodemapSymbol {
  name: string; kind: number; detail?: string; container?: string;
  line: number; col: number;
  children?: CodemapSymbol[];
  callees?: CodemapEdge[]; callers?: CodemapEdge[];
}
interface CodemapEdge {
  name: string; kind: number; detail?: string;
  file: string; line: number; col: number;
}

function log(...a: unknown[]): void {
  try {
    appendFileSync(LOG_PATH, a.map(String).join(" ") + "\n");
  } catch {
    /* best-effort logging only */
  }
}

/** Position <= comparison (for range containment in hierarchy reconstruction). */
function posLe(a: lsp.Position, b: lsp.Position): boolean {
  return a.line < b.line || (a.line === b.line && a.character <= b.character);
}

/** Find the position of `name` on line `line` in `text`. For flat
 *  SymbolInformation, range.start is at the declaration start (e.g. 'pub fn'),
 *  but prepareCallHierarchy needs the function NAME position. Searches the
 *  source line for the name; falls back to the line start if not found. */
function findNamePos(text: string, line: number, name: string): lsp.Position {
  const lines = text.split("\n");
  const srcLine = lines[line] ?? "";
  const col = srcLine.indexOf(name);
  return col >= 0 ? { line, character: col } : { line, character: 0 };
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
      case "callersTree":
        return await this.callHierarchyTreeQuery(socket, "incoming", a);
      case "calleesTree":
        return await this.callHierarchyTreeQuery(socket, "outgoing", a);
      case "supertypes":
        return await this.typeHierarchyQuery(socket, "super", a);
      case "subtypes":
        return await this.typeHierarchyQuery(socket, "sub", a);
      case "diagnostics":
        return await this.diagnosticsQuery(socket, a);
      case "rename":
        return await this.renameQuery(socket, a);
      case "syncChanged":
        return await this.syncChanged(socket, a as string[]);
      case "hover":
        return await this.query(socket, "hover", () => this.client!.hover(this.pos(a)));
      case "docSymbols":
        return await this.query(socket, "docSymbols", () =>
          this.client!.documentSymbol(this.abs(a[0])),
        );
      case "wsSymbols":
        return await this.wsSymbolsQuery(socket, String(a[0] ?? ""));
      case "codemap":
        return await this.codemapQuery(socket, a);
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

  /** Multi-hop call hierarchy: recurse incoming/outgoing to `depth` levels,
   *  returning a tree rather than one flat level. Collapses the multi-call
   *  cascade agents otherwise do by hand ("trace how a keypress reaches a
   *  widget"). Each node carries its CallHierarchyItem + the call sites
   *  (edge to its parent). Dedup is GLOBAL across the whole tree: once a
   *  function has been expanded, re-encountering it renders as a leaf
   *  marked ↻ (already shown) — this bounds the output and prevents
   *  infinite recursion on cyclic call graphs (e.g. mutual recursion).
   *  Depth is hard-capped at 10. Recursion uses a quiet retry (no per-call
   *  progress spam — a 15-node tree would otherwise emit 15 identical lines). */
  private async callHierarchyTreeQuery(
    socket: Socket,
    direction: "incoming" | "outgoing",
    a: unknown[],
  ): Promise<{ queriedFile: string; roots: unknown[] }> {
    const file = this.abs(String(a[0]));
    const depth = Math.min(Math.max(1, Number(a[3] ?? 1)), 10);
    const items = await this.query(socket, direction, () =>
      this.client!.prepareCallHierarchy(
        this.client!.pos(file, Number(a[1]), Number(a[2])),
      ),
    );
    if (!items || items.length === 0) return { queriedFile: file, roots: [] };
    const expanded = new Set<string>();
    const keyOf = (it: lsp.CallHierarchyItem) =>
      `${it.uri}:${it.selectionRange.start.line}:${it.selectionRange.start.character}`;
    const build = async (
      item: lsp.CallHierarchyItem,
      remaining: number,
    ): Promise<unknown> => {
      const node: {
        item: lsp.CallHierarchyItem;
        sites: lsp.Range[];
        siteUri: string;
        children: unknown[];
        cyclic: boolean;
      } = { item, sites: [], siteUri: "", children: [], cyclic: false };
      if (remaining <= 0) return node;
      const k = keyOf(item);
      if (expanded.has(k)) {
        node.cyclic = true;
        return node;
      }
      expanded.add(k);
      let calls: lsp.CallHierarchyIncomingCall[] | lsp.CallHierarchyOutgoingCall[] | null = null;
      try {
        calls =
          direction === "incoming"
            ? await this.queryQuiet(() => this.client!.incomingCalls(item))
            : await this.queryQuiet(() => this.client!.outgoingCalls(item));
      } catch {
        /* transient server hiccup → treat as no children */
      }
      if (calls) {
        for (const call of calls) {
          const childItem =
            direction === "incoming"
              ? (call as lsp.CallHierarchyIncomingCall).from
              : (call as lsp.CallHierarchyOutgoingCall).to;
          // Call sites (fromRanges) live in the caller's document.
          // incoming: caller = child → sites in child's doc.
          // outgoing: caller = parent → sites in the PARENT's doc (which
          //   is `item` here, not necessarily the queried root for depth>1).
          const child = await build(childItem, remaining - 1) as {
            item: lsp.CallHierarchyItem;
            sites: lsp.Range[];
            siteUri: string;
            children: unknown[];
            cyclic: boolean;
          };
          child.sites = call.fromRanges;
          child.siteUri = direction === "incoming" ? childItem.uri : item.uri;
          node.children.push(child);
        }
      }
      return node;
    };
    const roots = [];
    for (const item of items) roots.push(await build(item, depth));
    return { queriedFile: file, roots };
  }

  /** Retry-with-backoff for LSP queries that report nothing to the client
   *  (used by call-hierarchy tree recursion, where per-call progress lines
   *  would be noise). Same transient-error handling as `query()`. */
  private async queryQuiet<T>(fn: () => Promise<T>): Promise<T> {
    const MAX = 4;
    let last: unknown;
    for (let attempt = 1; attempt <= MAX; attempt++) {
      try {
        return await fn();
      } catch (err) {
        last = err;
        if (!isTransientLspError(err)) throw err;
        await sleep(120 * attempt);
      }
    }
    throw last;
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

  /** Rename a symbol across the workspace. prepareRename validates the
   *  position is renameable (and yields the current name as a placeholder);
   *  rename returns the server-computed WorkspaceEdit. The CLI decides
   *  whether to apply (write) or dry-run (print the plan). Returns the
   *  raw edit — the formatter normalizes changes/documentChanges. */
  private async renameQuery(
    socket: Socket,
    a: unknown[],
  ): Promise<{
    file: string;
    newName: string;
    placeholder?: string;
    edit: lsp.WorkspaceEdit | null;
  }> {
    const file = this.abs(String(a[0]));
    const pos = this.client!.pos(file, Number(a[1]), Number(a[2]));
    const newName = String(a[3]);
    let placeholder: string | undefined;
    try {
      const prep = await this.query(socket, "rename", () => this.client!.prepareRename(pos));
      if (prep && typeof prep === "object" && "placeholder" in prep) {
        placeholder = String((prep as { placeholder: string }).placeholder);
      }
    } catch {
      /* prepare optional / not supported — proceed to rename directly */
    }
    const edit = await this.query(socket, "rename", () => this.client!.rename(pos, newName));
    return { file, newName, placeholder, edit };
  }

  /** Re-sync files whose on-disk text was changed externally (after
   *  `rename --apply` wrote edits). For each path: read from disk, send a
   *  didChange (or didOpen if the server never saw it) so the server's
   *  in-memory text matches disk again. Fire-and-forget — no progress,
   *  no readiness wait; the next query sees the synced text. Returns the
   *  lists of synced / failed paths for diagnostics. */
  private async syncChanged(
    _socket: Socket,
    paths: string[],
  ): Promise<{ synced: string[]; failed: { path: string; error: string }[] }> {
    const synced: string[] = [];
    const failed: { path: string; error: string }[] = [];
    if (!this.client) return { synced, failed };
    for (const p of paths) {
      try {
        const abs = this.abs(p);
        const text = await readFile(abs, "utf-8");
        const languageId = this.opts.languageId ?? languageIdForFile(abs) ?? "plaintext";
        this.client.syncDoc(abs, text, languageId);
        synced.push(p);
      } catch (e) {
        failed.push({ path: p, error: e instanceof Error ? e.message : String(e) });
      }
    }
    return { synced, failed };
  }

  /** Codemap: a complete symbol tree for a scope (file | dir | workspace),
   *  enriched with call edges (callees + callers) on every callable symbol
   *  (function/method/constructor). Walks source files via `git ls-files`
   *  (respects .gitignore) with a readdir fallback, opens each fast (no
   *  readiness wait — documentSymbol is syntactic), fetches the document
   *  symbol tree, then batches call-hierarchy requests with concurrency.
   *
   *  `noCalls` skips the call-hierarchy enrichment for a fast symbol-only
   *  map (useful for large workspaces where edges would be too slow). */
  private async codemapQuery(
    socket: Socket,
    a: unknown[],
  ): Promise<{ files: CodemapFile[] }> {
    const scopeArg = a[0] ? String(a[0]) : null;
    const noCalls = Boolean(a[1]);
    const includeAll = Boolean(a[2]);
    const scope = scopeArg ? this.abs(scopeArg) : this.workspaceRoot;

    // 1. Discover source files matching the daemon's resolved language.
    this.progressTo(socket, "discovering source files…");
    let files = await this.discoverSourceFiles(scope);
    if (files.length === 0) return { files: [] };
    // De-duplicate + sort for stable output.
    files = [...new Set(files)].sort();

    // 2. Open all files. With calls: use openDoc (waits for server to
    //    finish analyzing — call hierarchy is semantic and needs the file
    //    analyzed). Without calls: openDocFast (documentSymbol is syntactic).
    const supportsCalls = !noCalls && Boolean(this.client?.caps?.callHierarchyProvider);
    this.progressTo(socket, `opening ${files.length} file${files.length === 1 ? "" : "s"}…`);
    for (const file of files) {
      try {
        const text = await readFile(file, "utf-8");
        const languageId = this.opts.languageId ?? languageIdForFile(file) ?? "plaintext";
        if (supportsCalls) {
          await this.client!.openDoc(file, text, languageId);
        } else {
          this.client!.openDocFast(file, text, languageId);
        }
      } catch {
        /* unreadable file — skip */
      }
    }

    const result: CodemapFile[] = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      this.progressTo(socket, `mapping ${i + 1}/${files.length}: ${relLabel(file)}…`);

      let symbols: lsp.DocumentSymbol[] | lsp.SymbolInformation[] | null = null;
      try {
        symbols = await this.client!.documentSymbol(file);
      } catch {
        /* server can't handle this file — skip */
      }
      if (!symbols || symbols.length === 0) {
        result.push({ file, symbols: [] });
        continue;
      }

      // Read the source text for name-position resolution (flat symbols
      // give range.start at the declaration, not the function name).
      let srcText: string | null = null;
      try {
        srcText = await readFile(file, "utf-8");
      } catch { /* best-effort */ }
      const tree = await this.buildCodemapSymbols(socket, symbols, file, supportsCalls, srcText, includeAll);
      result.push({ file, symbols: tree });
    }

    return { files: result };
  }

  /** Build the codemap symbol tree from a documentSymbol result. Two passes:
   *   1. Synchronously build the tree + collect callable positions.
   *   2. Fetch call edges for all callables with concurrency, mutating the
   *      tree in place (attaching callees/callers + upgrading detail to
   *      the real signature from CallHierarchyItem.detail). */
  private async buildCodemapSymbols(
    socket: Socket,
    symbols: lsp.DocumentSymbol[] | lsp.SymbolInformation[],
    file: string,
    withCalls: boolean,
    srcText: string | null,
    includeAll: boolean,
  ): Promise<CodemapSymbol[]> {
    const callables: { sym: CodemapSymbol; pos: lsp.Position }[] = [];
    let tree: CodemapSymbol[];

    if (symbols.length > 0 && "selectionRange" in symbols[0]) {
      // Hierarchical DocumentSymbol — build tree from .children.
      // Filter local-noise kinds (vars, consts) when inside a callable.
      const docs = symbols as lsp.DocumentSymbol[];
      const build = (syms: lsp.DocumentSymbol[], insideCallable: boolean): CodemapSymbol[] => {
        const out: CodemapSymbol[] = [];
        for (const d of syms) {
          if (insideCallable && LOCAL_NOISE_KINDS.has(d.kind)) continue;
          const sym: CodemapSymbol = {
            name: d.name,
            kind: d.kind,
            line: d.selectionRange.start.line + 1,
            col: d.selectionRange.start.character + 1,
          };
          if (d.detail) sym.detail = d.detail;
          const childCallable = insideCallable || CALLABLE_KINDS.has(d.kind);
          if (d.children?.length) sym.children = build(d.children, childCallable);
          if (withCalls && CALLABLE_KINDS.has(d.kind)) {
            callables.push({ sym, pos: d.selectionRange.start });
          }
          out.push(sym);
        }
        return out;
      };
      tree = build(docs, false);
    } else {
      // Flat SymbolInformation — reconstruct hierarchy from range
      // containment (a symbol whose range contains another is its parent).
      const flat = symbols as lsp.SymbolInformation[];
      // Sort: start asc, then wider range first (end desc) so parents
      // precede their children.
      const sorted = [...flat].sort((a, b) => {
        const sa = a.location.range.start;
        const sb = b.location.range.start;
        if (sa.line !== sb.line) return sa.line - sb.line;
        if (sa.character !== sb.character) return sa.character - sb.character;
        const ea = a.location.range.end;
        const eb = b.location.range.end;
        if (ea.line !== eb.line) return eb.line - ea.line;
        return eb.character - ea.character;
      });
      const stack: { sym: CodemapSymbol; end: lsp.Position }[] = [];
      tree = [];
      for (const s of sorted) {
        // Pop stack until we find an ancestor whose range contains this one.
        while (stack.length > 0) {
          const top = stack[stack.length - 1];
          if (posLe(s.location.range.end, top.end)) break;
          stack.pop();
        }
        // Filter local-noise kinds (vars, consts) when inside a callable.
        const insideCallable = stack.some((a) => CALLABLE_KINDS.has(a.sym.kind));
        if (insideCallable && LOCAL_NOISE_KINDS.has(s.kind)) continue;
        const sym: CodemapSymbol = {
          name: s.name,
          kind: s.kind,
          line: s.location.range.start.line + 1,
          col: s.location.range.start.character + 1,
        };
        if (s.containerName) sym.container = s.containerName;
        if (stack.length > 0) {
          const parent = stack[stack.length - 1];
          (parent.sym.children ??= []).push(sym);
        } else {
          tree.push(sym);
        }
        stack.push({ sym, end: s.location.range.end });
        if (withCalls && CALLABLE_KINDS.has(s.kind)) {
          // For flat SymbolInformation, range.start is at the declaration
          // start (e.g. 'pub fn'), not the function name. Find the name on
          // the source line so prepareCallHierarchy resolves correctly.
          const namePos = srcText
            ? findNamePos(srcText, s.location.range.start.line, s.name)
            : s.location.range.start;
          callables.push({ sym, pos: namePos });
        }
      }
    }

    // Fetch call edges with concurrency. The first prepareCallHierarchy on a
    // fresh daemon eats the cold start (~3s for the call-graph index to
    // build); subsequent ones are ~90ms each.
    if (callables.length > 0) {
      const CONCURRENCY = 8;
      let idx = 0;
      const workers = Array.from(
        { length: Math.min(CONCURRENCY, callables.length) },
        async () => {
          while (idx < callables.length) {
            const i = idx++;
            const { sym, pos } = callables[i];
            try {
              const edges = await this.getCallEdges(file, pos, includeAll);
              if (edges.callees.length) sym.callees = edges.callees;
              if (edges.callers.length) sym.callers = edges.callers;
              // Upgrade detail to the real signature from CallHierarchyItem.
              if (edges.signature) sym.detail = edges.signature;
            } catch {
              /* transient — symbol just shows without edges */
            }
          }
        },
      );
      await Promise.all(workers);
    }

    return tree;
  }

  /** Fetch callees + callers for one callable position. Returns the
   *  signature (from prepareCallHierarchy's CallHierarchyItem.detail) so the
   *  symbol tree can be upgraded from documentSymbol's "impl X" detail to
   *  the actual function signature. */
  private async getCallEdges(
    file: string,
    pos: lsp.Position,
    includeAll: boolean,
  ): Promise<{ callees: CodemapEdge[]; callers: CodemapEdge[]; signature?: string }> {
    const items = await this.queryQuiet(() =>
      this.client!.prepareCallHierarchy(this.client!.pos(file, pos.line, pos.character)),
    );
    if (!items || items.length === 0) return { callees: [], callers: [] };

    const signature = items[0]?.detail || undefined;
    const callees: CodemapEdge[] = [];
    const callers: CodemapEdge[] = [];
    const EXTERNAL = ["/node_modules/", "/.git/", "/vendor/", "/third_party/", "/.cargo/registry/"];
    const isLocal = (item: lsp.CallHierarchyItem): boolean => {
      if (includeAll) return true;
      const p = uriToPath(item.uri);
      if (!p.startsWith(this.workspaceRoot + "/")) return false;
      return !EXTERNAL.some((seg) => p.includes(seg));
    };

    for (const item of items) {
      try {
        const out = await this.queryQuiet(() => this.client!.outgoingCalls(item));
        if (out) for (const call of out) {
          if (isLocal(call.to)) callees.push(this.callItemToEdge(call.to));
        }
      } catch { /* transient */ }
      try {
        const inc = await this.queryQuiet(() => this.client!.incomingCalls(item));
        if (inc) for (const call of inc) {
          if (isLocal(call.from)) callers.push(this.callItemToEdge(call.from));
        }
      } catch { /* transient */ }
    }

    return { callees, callers, signature };
  }

  private callItemToEdge(item: lsp.CallHierarchyItem): CodemapEdge {
    return {
      name: item.name,
      kind: item.kind,
      detail: item.detail || undefined,
      file: uriToPath(item.uri),
      line: item.selectionRange.start.line + 1,
      col: item.selectionRange.start.character + 1,
    };
  }

  /** Discover source files under `scope` matching the daemon's resolved
   *  language. Uses `git ls-files` (fast, respects .gitignore) with a readdir
   *  walk fallback for non-git dirs. */
  private async discoverSourceFiles(scope: string): Promise<string[]> {
    // Single file → just return it.
    try {
      if ((await stat(scope)).isFile()) return [scope];
    } catch {
      /* doesn't exist or unreadable */
    }

    const langId = this.resolvedLanguageId ?? this.opts.languageId;
    if (!langId) return [];
    const lang = getLanguage(langId);
    const fts = lang?.["file-types"] ?? [];
    if (fts.length === 0) return [];

    // Try git ls-files first.
    const gitFiles = await this.gitLsFiles(scope);
    if (gitFiles !== null) {
      return gitFiles.filter((f) => matchesFileType(basename(f), fts));
    }

    // Fallback: readdir walk.
    return this.walkSourceFiles(scope, fts);
  }

  private async gitLsFiles(dir: string): Promise<string[] | null> {
    try {
      const { stdout } = await execFileP("git", ["ls-files"], {
        cwd: dir,
        maxBuffer: 10 * 1024 * 1024,
      });
      return stdout.trim().split("\n").filter(Boolean).map((f) => resolve(dir, f));
    } catch {
      return null;
    }
  }

  private async walkSourceFiles(
    dir: string,
    fts: (string | { glob: string })[],
  ): Promise<string[]> {
    const skip = new Set([
      "node_modules", ".git", "target", "build", "dist", ".next",
      ".deno", ".cache", "__pycache__", ".venv", "venv",
    ]);
    const result: string[] = [];
    const walk = async (d: string, depth: number) => {
      if (depth > 10) return;
      let entries: string[];
      try {
        entries = await readdir(d);
      } catch {
        return;
      }
      for (const f of entries) {
        if (skip.has(f) || f.startsWith(".")) continue;
        const full = resolve(d, f);
        let isDir = false;
        try {
          isDir = (await stat(full)).isDirectory();
        } catch {
          continue;
        }
        if (isDir) {
          await walk(full, depth + 1);
        } else if (matchesFileType(f, fts)) {
          result.push(full);
        }
      }
    };
    await walk(dir, 0);
    return result;
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
        rename: Boolean(caps.renameProvider),
        hover: Boolean(caps.hoverProvider),
        documentSymbol: Boolean(caps.documentSymbolProvider),
        workspaceSymbol: Boolean(caps.workspaceSymbolProvider),
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
