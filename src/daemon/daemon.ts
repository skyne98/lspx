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
import { LspClientPool, findRepresentativeSourceFile, matchesFileType } from "../lsp/pool.ts";
import { resolveSymbolAt, filterCandidates, type ResolvedSymbol, type NameFilter } from "../lsp/symbol.ts";
import { hashContent } from "../lsp/symbol.ts";
import { WorkspaceEditTransaction, type PlannedEdit } from "../transaction.ts";
import { defaultIO } from "../edit.ts";
import { getLanguage, getServer, languages } from "../registry/index.ts";
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
  private pool!: LspClientPool;
  private ready = false;
  /** True per-server once that server's workspace-symbol index has returned
   *  non-empty results (rust-analyzer builds it asynchronously). Before this,
   *  an empty result is treated as "still indexing" and retried. */
  private wsIndexReady = new Set<string>();
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
    this.pool = new LspClientPool({
      workspaceRoot: this.workspaceRoot,
      serverId: this.opts.serverId,
      languageId: this.opts.languageId,
    });
    // Boot in the background; clients connecting meanwhile are deferred +
    // streamed progress. We do NOT await here — start() must return fast.
    this.bootPromise = this.bootClient(onBootProgress);
  }

  private async bootClient(onProgress?: ProgressSink): Promise<void> {
    try {
      const sink: ProgressSink = (m) => {
        log(`progress: ${m}`);
        this.broadcastProgress(m);
        onProgress?.(m);
      };
      await this.pool.bootPrimary(sink);
      this.ready = true;
      log(`lsp server '${this.pool.primaryServerId()}' ready`);
    } catch (err) {
      this.bootError = err instanceof Error ? err : new Error(String(err));
      log(`boot failed: ${this.bootError.stack ?? this.bootError.message}`);
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
    // A client can connect immediately after listen() succeeds, before the
    // async continuation in start() assigns bootPromise. Wait for that
    // continuation instead of returning a false "daemon not ready"; slow
    // Windows C# servers made this startup race reproducible.
    for (let i = 0; !this.ready && !this.bootPromise && i < 100; i++) {
      await sleep(10);
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
    if (!this.pool.primary()) {
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
        return await this.navQuery(socket, "defs", a, (c, p) => c.definition(p));
      case "decl":
        return await this.navQuery(socket, "decl", a, (c, p) => c.declaration(p));
      case "typedef":
        return await this.navQuery(socket, "typedef", a, (c, p) => c.typeDefinition(p));
      case "impl":
        return await this.navQuery(socket, "impl", a, (c, p) => c.implementation(p));
      case "refs":
        return await this.navQuery(socket, "refs", a, (c, p) => c.references(p));
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
      case "source":
        return await this.sourceQuery(socket, a);
      case "sourceByName":
        return await this.sourceByNameQuery(socket, a);
      case "replaceSymbol":
        return await this.replaceSymbolQuery(socket, a);
      case "replaceSymbols":
        return await this.replaceSymbolsQuery(socket, a);
      case "batchEdit":
        return await this.batchEditQuery(socket, a);
      case "syncChanged":
        return await this.syncChanged(socket, a as string[]);
      case "hover":
        return await this.navQuery(socket, "hover", a, (c, p) => c.hover(p));
      case "docSymbols":
        return await this.docSymbolsQuery(socket, a);
      case "wsSymbols":
        return await this.wsSymbolsQuery(socket, String(a[0] ?? ""));
      case "codemap":
        return await this.codemapQuery(socket, a);
      default:
        throw new Error(`unknown method: ${m}`);
    }
  }

  /** Resolve the language-server client for the file in `a[0]`, build a
   *  position, and run a position-based navigation request through the
   *  transient-retry wrapper. Routing is per-file: the right server for the
   *  file's language is selected (and lazily booted) by the client pool. */
  private async navQuery<T>(
    socket: Socket,
    method: string,
    a: unknown[],
    fn: (client: LspClient, p: lsp.TextDocumentPositionParams) => Promise<T>,
  ): Promise<T> {
    const file = this.abs(a[0]);
    const client = await this.pool.forFile(file);
    const p = client.pos(file, Number(a[1]), Number(a[2]));
    return this.query(socket, method, () => fn(client, p));
  }

  /** documentSymbol for one file, routed to the file's language server. */
  private async docSymbolsQuery(
    socket: Socket,
    a: unknown[],
  ): Promise<lsp.DocumentSymbol[] | lsp.SymbolInformation[] | null> {
    const file = this.abs(a[0]);
    const client = await this.pool.forFile(file);
    return this.query(socket, "docSymbols", () => client.documentSymbol(file));
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
    const client = await this.pool.forFile(file);
    const items = await this.query(socket, direction, () =>
      client.prepareCallHierarchy(
        client.pos(file, Number(a[1]), Number(a[2])),
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
          ? await this.query(socket, direction, () => client.incomingCalls(item))
          : await this.query(socket, direction, () => client.outgoingCalls(item));
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
    const client = await this.pool.forFile(file);
    const items = await this.query(socket, direction, () =>
      client.prepareCallHierarchy(
        client.pos(file, Number(a[1]), Number(a[2])),
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
            ? await this.queryQuiet(() => client.incomingCalls(item))
            : await this.queryQuiet(() => client.outgoingCalls(item));
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
    const client = await this.pool.forFile(file);
    let items: lsp.TypeHierarchyItem[] | null;
    try {
      items = await this.query(socket, direction, () =>
        client.prepareTypeHierarchy(
          client.pos(file, Number(a[1]), Number(a[2])),
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
          ? await this.query(socket, direction, () => client.supertypes(item))
          : await this.query(socket, direction, () => client.subtypes(item));
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
    const client = await this.pool.forFile(file);
    await this.openDoc(socket, String(a[0]));
    let diags = client.diagnosticsFor(file);
    if (!diags || diags.length === 0) {
      this.progressTo(socket, "waiting for diagnostics…");
      const next = await client.waitForNextDiagnostics(file, 1200);
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
    const client = await this.pool.forFile(file);
    const pos = client.pos(file, Number(a[1]), Number(a[2]));
    const newName = String(a[3]);
    let placeholder: string | undefined;
    try {
      const prep = await this.query(socket, "rename", () => client.prepareRename(pos));
      if (prep && typeof prep === "object" && "placeholder" in prep) {
        placeholder = String((prep as { placeholder: string }).placeholder);
      }
    } catch {
      /* prepare optional / not supported — proceed to rename directly */
    }
    const edit = await this.query(socket, "rename", () => client.rename(pos, newName));
    return { file, newName, placeholder, edit };
  }

  /** `source`: the complete declaration at a position (replaces Dirac's
   *  get_function). Resolves the deepest enclosing DocumentSymbol (or, for
   *  flat-symbol servers, the smallest containing SymbolInformation) and
   *  returns its full source + a content digest so a later replace can reject
   *  a stale target. Read-only. */
  private async sourceQuery(
    socket: Socket,
    a: unknown[],
  ): Promise<ResolvedSymbol | null> {
    const file = this.abs(String(a[0]));
    const client = await this.pool.forFile(file);
    await this.openDoc(socket, String(a[0]));
    const symbols = await this.query(socket, "source", () => client.documentSymbol(file));
    const text = await readFile(file, "utf-8");
    return resolveSymbolAt(
      symbols,
      file,
      { line: Number(a[1]), character: Number(a[2]) },
      text,
    );
  }

  /** `source` / `replace-symbol` by name: fan out workspace/symbol across
   *  ready clients, filter by within/container/kind, and resolve the single
   *  match to a full ResolvedSymbol. Returns `{ ambiguous, candidates }` if
   *  more than one candidate remains — never silently picks the first. */
  private async resolveByName(
    socket: Socket,
    name: string,
    filter: NameFilter,
  ): Promise<
    | { kind: "resolved"; symbol: ResolvedSymbol }
    | { kind: "ambiguous"; candidates: ReturnType<typeof filterCandidates> }
    | { kind: "not-found" }
  > {
    const targets = this.pool.readyClients().filter(
      (c) => c.client.caps?.workspaceSymbolProvider,
    );
    if (targets.length === 0) return { kind: "not-found" };
    let all: (lsp.SymbolInformation | lsp.WorkspaceSymbol)[] = [];
    for (const { client } of targets) {
      try {
        const res = await this.queryQuiet(() => client.workspaceSymbol(name));
        if (res) all = all.concat(res);
      } catch {
        /* one server's query failed — keep going */
      }
    }
    // Exact-name candidates only (workspace/symbol is fuzzy).
    const exact = all.filter((s) => s.name === name);
    const candidates = filterCandidates(exact, filter);
    if (candidates.length === 0) return { kind: "not-found" };
    if (candidates.length > 1) return { kind: "ambiguous", candidates };
    const c = candidates[0];
    if (c.line === 0) return { kind: "not-found" }; // unresolved WorkspaceSymbol (uri only)
    const file = c.path;
    const client = await this.pool.forFile(file);
    await this.openDoc(socket, file);
    const symbols = await this.queryQuiet(() => client.documentSymbol(file));
    const text = await readFile(file, "utf-8");
    const symbol = resolveSymbolAt(
      symbols,
      file,
      { line: c.line - 1, character: c.column - 1 },
      text,
    );
    return symbol ? { kind: "resolved", symbol } : { kind: "not-found" };
  }

  private async sourceByNameQuery(
    socket: Socket,
    a: unknown[],
  ): Promise<unknown> {
    const name = String(a[0]);
    const filter: NameFilter = {
      within: a[1] ? this.abs(String(a[1])) : undefined,
      container: a[2] ? String(a[2]) : undefined,
    };
    return this.resolveByName(socket, name, filter);
  }

  /** `replace-symbol`: replace a symbol's full declaration range with new
   *  text (read from stdin by the CLI, passed as `a[3]`). Dry-run by
   *  default → returns the plan. With `--apply` (a[4] === true) runs the
   *  transaction (staleness-guarded, overlap-checked, rollback-safe),
   *  re-syncs the server, and verifies fresh diagnostics on touched files. */
  private async replaceSymbolQuery(
    socket: Socket,
    a: unknown[],
  ): Promise<unknown> {
    const apply = a[4] === true;
    const verify = a[5] !== false; // default verify on apply
    const newText = String(a[3] ?? "");
    let resolved: ResolvedSymbol | null = null;
    if (typeof a[0] === "string" && typeof a[1] === "number") {
      // Position form: [file, line, col, text, apply?, verify?]
      const file = this.abs(String(a[0]));
      const client = await this.pool.forFile(file);
      await this.openDoc(socket, String(a[0]));
      const symbols = await this.query(socket, "replaceSymbol", () => client.documentSymbol(file));
      const text = await readFile(file, "utf-8");
      resolved = resolveSymbolAt(symbols, file, { line: Number(a[1]), character: Number(a[2]) }, text);
    } else if (typeof a[0] === "string" && typeof a[3] === "string") {
      // Name form: [name, withinPath?, container?, text, apply?, verify?]
      const name = String(a[0]);
      const filter: NameFilter = {
        within: a[1] ? this.abs(String(a[1])) : undefined,
        container: a[2] ? String(a[2]) : undefined,
      };
      // Shift text/apply/verify into the name-form slots.
      const nameNewText = String(a[3]);
      const nameApply = a[4] === true;
      const nameVerify = a[5] !== false;
      const r = await this.resolveByName(socket, name, filter);
      if (r.kind === "not-found") return { error: { code: "symbol-not-found", message: `'${name}' not found` } };
      if (r.kind === "ambiguous") return { error: { code: "ambiguous-symbol", message: `'${name}' matched ${r.candidates.length} symbols`, candidates: r.candidates } };
      resolved = r.symbol;
      return this.runReplaceTransaction(socket, resolved, nameNewText, nameApply, nameVerify);
    }
    if (!resolved) return { error: { code: "symbol-not-found", message: "no symbol at position" } };
    return this.runReplaceTransaction(socket, resolved, newText, apply, verify);
  }

  /** Apply (or dry-run plan) a batch of planned edits through the transaction
   *  engine, then re-sync + verify. Shared by single-symbol replace, batched
   *  symbol replacement, and generic batch_edit. One stale/overlapping edit
   *  aborts the entire transaction — lspx never applies a partial batch. */
  private async applyPlanned(
    socket: Socket,
    planned: PlannedEdit[],
    apply: boolean,
    verify: boolean,
  ): Promise<unknown> {
    const tx = new WorkspaceEditTransaction(planned, defaultIO);
    const plan = tx.validate();
    if (plan.aborted) {
      return {
        error: { code: plan.rejected[0]?.code ?? "apply-failed", message: plan.rejected[0]?.reason ?? "precondition failed", rejected: plan.rejected },
      };
    }
    if (!apply) {
      return {
        dryRun: true,
        edits: planned.length,
        files: plan.staged.length,
        plan: plan.staged.map((f) => ({ path: f.path, edits: f.edits, beforeLines: f.original.split("\n").length, afterLines: f.staged.split("\n").length })),
      };
    }
    const result = tx.apply();
    if (result.rolledBack) {
      return { error: { code: "apply-failed", message: "transaction rolled back" } };
    }
    // Re-sync the server's in-memory text so the verification diagnostics
    // reflect the post-edit document.
    await this.syncChanged(socket, result.paths).catch(() => { /* best-effort */ });
    let verification: unknown = undefined;
    if (verify && result.paths.length > 0) {
      verification = await this.verifyDiagnostics(socket, result.paths);
    }
    return {
      applied: true,
      files: result.files,
      edits: result.edits,
      verification,
    };
  }

  /** Apply (or dry-run plan) a single-symbol replacement through the
   *  transaction engine, then re-sync + verify. */
  private async runReplaceTransaction(
    socket: Socket,
    resolved: ResolvedSymbol,
    newText: string,
    apply: boolean,
    verify: boolean,
  ): Promise<unknown> {
    const planned: PlannedEdit[] = [{
      path: resolved.path,
      range: resolved.range,
      newText,
      expectedText: resolved.expectedText,
      expectedHash: resolved.contentHash,
      label: resolved.name,
    }];
    const r = await this.applyPlanned(socket, planned, apply, verify);
    if (apply && r && typeof r === "object" && "applied" in r) {
      (r as Record<string, unknown>).symbol = { name: resolved.name, kind: resolved.kind, path: resolved.path, range: resolved.range };
    } else if (!apply && r && typeof r === "object" && "dryRun" in r) {
      (r as Record<string, unknown>).symbol = { name: resolved.name, kind: resolved.kind, path: resolved.path, range: resolved.range };
      const staged = (r as { plan?: Array<{ beforeLines: number; afterLines: number }> }).plan?.[0];
      if (staged) {
        (r as Record<string, unknown>).beforeLines = staged.beforeLines;
        (r as Record<string, unknown>).afterLines = staged.afterLines;
      }
    }
    return r;
  }

  /** `replaceSymbols` (batched): resolve each target (position or name), build
   *  one transaction, apply atomically + verify. One ambiguous/stale target
   *  aborts the whole batch. Used by the pi `replace_symbols` tool. */
  private async replaceSymbolsQuery(
    socket: Socket,
    a: unknown[],
  ): Promise<unknown> {
    const replacements = a[0] as Array<Record<string, unknown>>;
    if (!Array.isArray(replacements)) return { error: { code: "invalid-arguments", message: "replacements must be an array" } };
    const apply = a[1] === true;
    const verify = a[2] !== false;
    const planned: PlannedEdit[] = [];
    for (const r of replacements ?? []) {
      const text = String(r.text ?? "");
      const label = r.name ? String(r.name) : r.path ? String(r.path) : "symbol";
      let resolved: ResolvedSymbol | null = null;
      if (typeof r.path === "string" && typeof r.line === "number") {
        const file = this.abs(String(r.path));
        const client = await this.pool.forFile(file);
        await this.openDoc(socket, String(r.path));
        const symbols = await this.query(socket, "replaceSymbols", () => client.documentSymbol(file));
        const src = await readFile(file, "utf-8");
        resolved = resolveSymbolAt(symbols, file, { line: Number(r.line), character: Number(r.column ?? 0) }, src);
      } else if (typeof r.name === "string") {
        const filter: NameFilter = {
          within: r.within ? this.abs(String(r.within)) : undefined,
          container: r.container ? String(r.container) : undefined,
        };
        const res = await this.resolveByName(socket, String(r.name), filter);
        if (res.kind === "not-found") return { error: { code: "symbol-not-found", message: `'${r.name}' not found` } };
        if (res.kind === "ambiguous") return { error: { code: "ambiguous-symbol", message: `'${r.name}' matched ${res.candidates.length} symbols`, candidates: res.candidates } };
        resolved = res.symbol;
      }
      if (!resolved) return { error: { code: "symbol-not-found", message: `could not resolve ${label}` } };
      planned.push({
        path: resolved.path,
        range: resolved.range,
        newText: text,
        expectedText: resolved.expectedText,
        expectedHash: resolved.contentHash,
        label,
      });
    }
    return this.applyPlanned(socket, planned, apply, verify);
  }

  /** `batchEdit`: generic exact-match multi-file editing. For each edit, locate
   *  `oldText` in the file, derive the LSP range, and plan a staleness-guarded
   *  edit (expectedText = oldText). One transaction, atomic apply + verify.
   *  Used by the pi `batch_edit` tool — this is the Dirac-style multi-file
   *  batching capability, owned by lspx so it can LSP-validate + verify. */
  private async batchEditQuery(
    socket: Socket,
    a: unknown[],
  ): Promise<unknown> {
    const files = a[0] as Array<{ path: string; edits: Array<{ oldText: string; newText: string }> }>;
    if (!Array.isArray(files)) return { error: { code: "invalid-arguments", message: "files must be an array" } };
    const apply = a[1] === true;
    const verify = a[2] !== false;
    const planned: PlannedEdit[] = [];
    for (const f of files ?? []) {
      const file = this.abs(f.path);
      let src: string;
      try {
        src = await readFile(file, "utf-8");
      } catch {
        return { error: { code: "stale-target", message: `cannot read ${f.path}` } };
      }
      const lines = src.split("\n");
      for (const e of f.edits) {
        const range = locateExact(src, lines, e.oldText);
        if (!range) return { error: { code: "stale-target", message: `oldText not found in ${f.path}`, path: f.path } };
        planned.push({
          path: file,
          range,
          newText: e.newText,
          expectedText: e.oldText,
          expectedHash: hashContent(e.oldText),
          label: f.path,
        });
      }
    }
    return this.applyPlanned(socket, planned, apply, verify);
  }

  /** Fresh-diagnostics verification for a set of just-written paths. Returns
   *  introduced / resolved / pre-existing diagnostics per file, plus a
   *  freshness status. Captures before-diags from the client's last snapshot,
   *  re-opens to trigger a fresh push, waits for the new push, and diffs. */
  private async verifyDiagnostics(
    socket: Socket,
    paths: string[],
  ): Promise<unknown> {
    const perFile: unknown[] = [];
    for (const p of paths) {
      try {
        const file = this.abs(p);
        const client = await this.pool.forFile(file);
        const before = client.diagnosticsFor(file) ?? [];
        // syncChanged already re-synced the server's in-memory text via
        // didChange; that triggers a fresh diagnostics push for the new
        // version. Wait for THAT push (not the cached pre-edit snapshot).
        this.progressTo(socket, "verifying diagnostics…");
        const push = await client.awaitDiagnosticsPush(file, 3000);
        const after = push.diagnostics;
        const beforeKeys = new Set(before.map(dgKey));
        const afterKeys = new Set(after.map(dgKey));
        const introduced = after.filter((d) => !beforeKeys.has(dgKey(d)));
        const resolved = before.filter((d) => !afterKeys.has(dgKey(d)));
        const preexisting = after.filter((d) => beforeKeys.has(dgKey(d)));
        perFile.push({
          path: p,
          freshness: push.fresh ? "fresh" : "timed-out",
          introduced: introduced.length,
          resolved: resolved.length,
          preexisting: preexisting.length,
          introducedDiagnostics: introduced.map(diagSummary),
        });
      } catch (e) {
        perFile.push({ path: p, freshness: "unsupported", error: e instanceof Error ? e.message : String(e) });
      }
    }
    return { files: perFile };
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
    for (const p of paths) {
      try {
        const abs = this.abs(p);
        const text = await readFile(abs, "utf-8");
        const languageId = this.opts.languageId ?? this.pool.languageIdForFile(abs) ?? "plaintext";
        const client = await this.pool.forFile(abs);
        client.syncDoc(abs, text, languageId);
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

    // 1. Discover source files of ANY language that has an installed server
    //    (polyglot codemap). discoverSourceFiles groups by language.
    this.progressTo(socket, "discovering source files…");
    let files = await this.discoverSourceFiles(scope);
    if (files.length === 0) return { files: [] };
    // De-duplicate + sort for stable output.
    files = [...new Set(files)].sort();

    // 2. Open each file with its own language server (lazily booted via the
    //    pool). Call edges need the file analyzed (openDoc); symbol-only
    //    maps use openDocFast (documentSymbol is syntactic). Call-hierarchy
    //    support is per-server, so track it per file.
    const fileClient = new Map<string, LspClient>();
    const wantsCalls = new Set<string>();
    this.progressTo(socket, `opening ${files.length} file${files.length === 1 ? "" : "s"}…`);
    for (const file of files) {
      try {
        const text = await readFile(file, "utf-8");
        const languageId = this.opts.languageId ?? this.pool.languageIdForFile(file) ?? "plaintext";
        const client = await this.pool.forFile(file);
        fileClient.set(file, client);
        const canCalls = !noCalls && Boolean(client.caps?.callHierarchyProvider);
        if (canCalls) {
          wantsCalls.add(file);
          await client.openDoc(file, text, languageId);
        } else {
          client.openDocFast(file, text, languageId);
        }
      } catch {
        /* unreadable file or no server for its language — skip */
      }
    }

    const result: CodemapFile[] = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const client = fileClient.get(file);
      if (!client) {
        result.push({ file, symbols: [] });
        continue;
      }
      this.progressTo(socket, `mapping ${i + 1}/${files.length}: ${relLabel(file)}…`);

      let symbols: lsp.DocumentSymbol[] | lsp.SymbolInformation[] | null = null;
      try {
        symbols = await client.documentSymbol(file);
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
      const tree = await this.buildCodemapSymbols(socket, client, symbols, file, wantsCalls.has(file), srcText, includeAll);
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
    client: LspClient,
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
              const edges = await this.getCallEdges(client, file, pos, includeAll);
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
    client: LspClient,
    file: string,
    pos: lsp.Position,
    includeAll: boolean,
  ): Promise<{ callees: CodemapEdge[]; callers: CodemapEdge[]; signature?: string }> {
    const items = await this.queryQuiet(() =>
      client.prepareCallHierarchy(client.pos(file, pos.line, pos.character)),
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
        const out = await this.queryQuiet(() => client.outgoingCalls(item));
        if (out) for (const call of out) {
          if (isLocal(call.to)) callees.push(this.callItemToEdge(call.to));
        }
      } catch { /* transient */ }
      try {
        const inc = await this.queryQuiet(() => client.incomingCalls(item));
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

  /** Discover source files under `scope` for ANY language that has an
   *  installed server (polyglot codemap). Uses `git ls-files` (fast,
   *  respects .gitignore) with a readdir walk fallback for non-git dirs.
   *  Files whose extension matches no known language, or whose language has
   *  no installed server, are excluded so the map only covers languages
   *  lspx can actually analyze. */
  private async discoverSourceFiles(scope: string): Promise<string[]> {
    // Single file → just return it (the caller routes it to its server).
    try {
      if ((await stat(scope)).isFile()) return [scope];
    } catch {
      /* doesn't exist or unreadable */
    }

    // Union of file-types across all languages that have an installed server.
    const allFts = new Set<string>();
    const globs = new Set<string>();
    for (const lang of languages()) {
      if (!lang.name) continue;
      if (!hasInstalledServer(lang)) continue;
      for (const ft of lang["file-types"] ?? []) {
        if (typeof ft === "string") allFts.add(ft.toLowerCase());
        else if (ft?.glob) globs.add(ft.glob.toLowerCase());
      }
    }
    const matchAny = (name: string): boolean => {
      const lower = name.toLowerCase();
      const ext = extname(lower).slice(1);
      if (ext && allFts.has(ext)) return true;
      if (allFts.has(lower)) return true;
      if (globs.has(lower)) return true;
      return false;
    };

    // Try git ls-files first.
    const gitFiles = await this.gitLsFiles(scope);
    if (gitFiles !== null) {
      return gitFiles.filter((f) => matchAny(basename(f)));
    }

    // Fallback: readdir walk (no language filter — matchAny covers it).
    return this.walkSourceFiles(scope, matchAny);
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
    match: (name: string) => boolean,
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
        } else if (match(f)) {
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
    // Fan out across every *ready* client that advertises workspace symbols.
    // Servers not yet booted are not queried (no eager boot for a search),
    // and results are merged + deduped by (uri, range, name).
    const LAZY_PROJECT_SERVERS = new Set([
      "typescript-language-server",
      "vtsls",
    ]);
    const targets = this.pool.readyClients().filter(
      (c) => c.client.caps?.workspaceSymbolProvider,
    );
    if (targets.length === 0) return null;

    // For lazy-project servers with no open docs, open a representative file
    // so the project loads before the query (tsserver: "No Project." otherwise).
    for (const { serverId, client } of targets) {
      if (LAZY_PROJECT_SERVERS.has(serverId) && client.openDocCount === 0) {
        const langId = this.pool.languageForServer(serverId);
        const rep = langId ? findRepresentativeSourceFile(this.workspaceRoot, langId) : null;
        if (rep) {
          this.progressTo(socket, `opening ${relLabel(rep)} to load project…`);
          await this.openDoc(socket, rep).catch(() => { /* best-effort */ });
        }
      }
    }

    const MAX = 6;
    let reported = false;
    const merged: (lsp.SymbolInformation | lsp.WorkspaceSymbol)[] = [];
    const seen = new Set<string>();
    let anyNonEmpty = false;
    for (let attempt = 1; attempt <= MAX; attempt++) {
      let allEmpty = true;
      for (const { serverId, client } of targets) {
        let res: lsp.SymbolInformation[] | lsp.WorkspaceSymbol[] | null = null;
        try {
          res = await client.workspaceSymbol(query);
        } catch (err) {
          if (!isTransientLspError(err)) throw err;
          res = null;
        }
        if (res && res.length > 0) {
          anyNonEmpty = true;
          this.wsIndexReady.add(serverId);
          for (const s of res) {
            const loc = (s as lsp.SymbolInformation).location ??
              (s as lsp.WorkspaceSymbol).location;
            const key = `${s.name}:${s.kind}:${loc?.uri ?? ""}:${loc?.range?.start.line ?? 0}:${loc?.range?.start.character ?? 0}`;
            if (!seen.has(key)) {
              seen.add(key);
              merged.push(s);
            }
          }
          allEmpty = false;
        }
      }
      if (anyNonEmpty && allEmpty) break; // index-ready servers answered; rest genuinely miss
      if (anyNonEmpty) return merged.length > 0 ? merged : null;
      // Nothing yet — maybe still indexing. Retry unless every target is
      // already known ready (then empties are genuine misses).
      if (targets.every((t) => this.wsIndexReady.has(t.serverId))) {
        return merged.length > 0 ? merged : null;
      }
      if (attempt < MAX) {
        if (!reported) {
          this.progressTo(socket, "waiting for workspace index…");
          reported = true;
        }
        await sleep(350 * attempt);
      }
    }
    return merged.length > 0 ? merged : null;
  }

  private status(): Record<string, unknown> {
    const clients = this.pool.active().map((e) => ({
      serverId: e.serverId,
      state: e.state,
      languages: [...e.languageIds],
      openDocs: e.client.openDocCount,
      capabilities: capsOf(e.client.caps),
    }));
    return {
      workspace: this.workspaceRoot,
      socket: this.socketPath(),
      pid: process.pid,
      serverId: this.opts.serverId ?? "auto",
      primary: this.pool.primaryServerId() ?? null,
      ready: this.ready,
      clients,
    };
  }

  /** Open (or re-open) a doc; reports "indexing <file>…" while the server
   *  analyzes it. Routes to the file's language server via the pool. No-op if
   *  the file is already open with unchanged text. */
  private async openDoc(
    socket: Socket,
    path: string,
  ): Promise<{ uri: string; languageId: string }> {
    const abs = this.abs(path);
    const text = await readFile(abs, "utf-8");
    const languageId = this.opts.languageId ?? this.pool.languageIdForFile(abs) ?? "plaintext";
    const uri = normalizeUri(abs);
    const client = await this.pool.forFile(abs);
    await phase(`indexing ${relLabel(path)}`, async () => {
      await client.openDoc(uri, text, languageId);
    }, (m) => this.progressTo(socket, m));
    return { uri, languageId };
  }

  private abs(p: unknown): string {
    return resolve(this.workspaceRoot, String(p));
  }

  async stop(): Promise<void> {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    if (this.pool) {
      await this.pool.closeAll();
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

/** Compact capability flags for `status` output. */
function capsOf(caps: lsp.ServerCapabilities | null): Record<string, boolean> {
  return {
    definition: Boolean(caps?.definitionProvider),
    declaration: Boolean(caps?.declarationProvider),
    typeDefinition: Boolean(caps?.typeDefinitionProvider),
    implementation: Boolean(caps?.implementationProvider),
    references: Boolean(caps?.referencesProvider),
    callHierarchy: Boolean(caps?.callHierarchyProvider),
    typeHierarchy: Boolean(caps?.typeHierarchyProvider),
    rename: Boolean(caps?.renameProvider),
    hover: Boolean(caps?.hoverProvider),
    documentSymbol: Boolean(caps?.documentSymbolProvider),
    workspaceSymbol: Boolean(caps?.workspaceSymbolProvider),
  };
}

/** Does this language have at least one installed server on $PATH? */
function hasInstalledServer(lang: { "language-servers"?: string[] }): boolean {
  const ids = lang["language-servers"] ?? [];
  return ids.some((id) => {
    const def = getServer(id);
    return Boolean(def && Bun.which(def.command));
  });
}

/** Stable key for a diagnostic (for before/after diffing in verification). */
function dgKey(d: lsp.Diagnostic): string {
  return `${d.severity ?? 1}:${d.range.start.line}:${d.range.start.character}:${d.message}`;
}

/** Compact diagnostic summary for verification output. */
function diagSummary(d: lsp.Diagnostic): Record<string, unknown> {
  return {
    severity: d.severity ?? 1,
    line: d.range.start.line + 1,
    column: d.range.start.character + 1,
    source: d.source ?? null,
    message: d.message,
  };
}

/** Locate `oldText` in `src` and return its 0-indexed LSP range. Matches the
 *  first occurrence (callers must disambiguate before calling). Returns null
 *  if not found. Character offsets are UTF-16 code units to match LSP. */
function locateExact(
  src: string,
  lines: string[],
  oldText: string,
): { start: lsp.Position; end: lsp.Position } | null {
  const idx = src.indexOf(oldText);
  if (idx === -1) return null;
  let line = 0;
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const lineStart = offset;
    const lineEnd = lineStart + lines[i].length;
    if (idx >= lineStart && idx <= lineEnd) {
      line = i;
      const startChar = idx - lineStart;
      // Compute end position by walking forward through newlines from start.
      const endIdx = idx + oldText.length;
      let endLine = line;
      let endChar = startChar;
      let pos = idx;
      while (pos < endIdx) {
        if (src[pos] === "\n") {
          endLine++;
          endChar = 0;
          pos++;
          offset = lineStart + lines[i].length + 1; // not needed further
        } else {
          endChar++;
          pos++;
        }
      }
      return {
        start: { line, character: startChar },
        end: { line: endLine, character: endChar },
      };
    }
    offset = lineEnd + 1; // +1 for the '\n'
  }
  return null;
}
