// A focused LSP *client* over stdio, built on `vscode-jsonrpc`.
//
// We deliberately use the canonical, battle-tested JSON-RPC + LSP protocol
// implementation from `vscode-languageserver-node` rather than hand-rolling
// framing. This module owns exactly one language-server subprocess per
// instance and exposes the navigation requests an AI agent needs:
//   initialize / didOpen / definition / references / hover / documentSymbol
//   workspace/symbol / rename / prepareRename / typeDefinition / implementation
//   declaration / callHierarchy
//
// It does NOT try to be a full LSP client (no workspace folders config UI,
// no semantic tokens, etc.) — only the symbol-navigation surface.
//
// Note: we use plain `MessageConnection` + string method names
// (`InitializeRequest.method` etc.) rather than the protocol-typed overloads,
// which keeps us compatible with the base jsonrpc connection returned by
// `createMessageConnection`.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  createMessageConnection,
  type MessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  NullLogger,
  type Logger,
} from "vscode-jsonrpc/node";
import * as lsp from "vscode-languageserver-protocol";
import { URI } from "vscode-uri";
import type { ServerCapabilities } from "vscode-languageserver-protocol";

export interface ServerLaunch {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** Initial workspace root (rootUri / workspaceFolders). */
  workspaceRoot: string;
  /** Optional initializationOptions to pass through. */
  initializationOptions?: unknown;
  /** Stdio logger; default is silent (NullLogger). */
  logger?: Logger;
}

export interface OpenedDoc {
  uri: string;
  languageId: string;
  version: number;
  text: string;
}

/** Capabilities we always request — kept tight to what we use. */
function clientCapabilities(): lsp.ClientCapabilities {
  return {
    textDocument: {
      synchronization: { dynamicRegistration: false },
      hover: { contentFormat: ["markdown", "plaintext"] },
      completion: { completionItem: { snippetSupport: false } },
      definition: { linkSupport: true },
      typeDefinition: { linkSupport: true },
      implementation: { linkSupport: true },
      declaration: { linkSupport: true },
      callHierarchy: { dynamicRegistration: false },
      typeHierarchy: { dynamicRegistration: false },
      rename: { prepareSupport: true },
    },
    workspace: {
      symbol: {},
      configuration: true,
      workspaceEdit: {
        documentChanges: true,
        resourceOperations: ["create", "rename", "delete"],
      },
    },
  };
}

export class LspClient {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private conn: MessageConnection | null = null;
  private capabilities: ServerCapabilities | null = null;
  private openDocs = new Map<string, OpenedDoc>();
  /** Number of documents currently open (didOpen sent, no didClose). */
  get openDocCount(): number {
    return this.openDocs.size;
  }
  private nextVersion = 1;
  readonly rootUri: string;
  private readonly logger: Logger;
  /** Resolves when diagnostics are published for a given URI (readiness signal). */
  private diagWaiters = new Map<string, Array<() => void>>();
  private diagListenerInstalled = false;
  /** Latest diagnostics per URI, kept up-to-date as the server publishes
   *  them. Used by the `diagnostics` command — we already receive these
   *  notifications for the readiness signal, so storing them is free. */
  private diagnosticsByUri = new Map<string, lsp.Diagnostic[]>();

  /** Snapshot of the most recent diagnostics for a URI (may be empty).
   *  Returns `undefined` if the server has never reported on this URI
   *  (e.g. it doesn't publish diagnostics at all). */
  diagnosticsFor(uri: string): lsp.Diagnostic[] | undefined {
    return this.diagnosticsByUri.get(normalizeUri(uri));
  }

  /** Wait for the *next* diagnostics push for `uri`, returning the pushed
   *  array. Resolves with `undefined` on timeout. Servers (esp. tsserver)
   *  may push an empty list first as a didOpen ack, then the real
   *  diagnostics after type-checking; cold starts can also take longer
   *  than the 1500ms readiness fallback. So the diagnostics command uses
   *  this to wait for the push that actually carries results. */
  async waitForNextDiagnostics(
    uri: string,
    timeoutMs = 3000,
  ): Promise<lsp.Diagnostic[] | undefined> {
    if (!this.conn) return undefined;
    const norm = normalizeUri(uri);
    // Already have results → return them immediately (first push was real).
    const cur = this.diagnosticsByUri.get(norm);
    if (cur && cur.length > 0) return cur;
    return new Promise((resolve) => {
      let settled = false;
      const finish = (v?: lsp.Diagnostic[]) => {
        if (settled) return;
        settled = true;
        clearTimeout(t);
        resolve(v);
      };
      const t = setTimeout(() => finish(this.diagnosticsByUri.get(norm)), timeoutMs);
      const wake = () => finish(this.diagnosticsByUri.get(norm) ?? []);
      const arr = this.diagWaiters.get(norm) ?? [];
      arr.push(wake);
      this.diagWaiters.set(norm, arr);
      if (this.proc) this.proc.once("exit", () => finish(undefined));
    });
  }

  constructor(private launch: ServerLaunch) {
    this.rootUri = URI.file(launch.workspaceRoot).toString();
    this.logger = launch.logger ?? NullLogger;
  }

  get caps(): ServerCapabilities | null {
    return this.capabilities;
  }

  async start(): Promise<void> {
    if (this.conn) return;
    const { command, args = [], env } = this.launch;
    this.proc = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    this.proc.on("error", (err) => {
      this.logger.error(`LSP process error: ${err.message}`);
    });
    this.proc.on("exit", (code, signal) => {
      this.logger.warn(`LSP process exited (code=${code} signal=${signal})`);
    });
    const reader = new StreamMessageReader(this.proc.stdout);
    const writer = new StreamMessageWriter(this.proc.stdin);
    this.conn = createMessageConnection(reader, writer, this.logger);
    this.conn.onError((err) => {
      this.logger.error(`connection error: ${err[0]?.message ?? String(err)}`);
    });
    this.installDiagListener();
    this.conn.listen();
  }

  /** Listen for textDocument/publishDiagnostics and notify waiters.
   *  Also stores the diagnostics so the `diagnostics` command can surface
   *  them — this notification is the *only* way LSP delivers them (there
   *  is no pull request in the base protocol), so capturing here is the
   *  single source of truth. A diagnostics push (even an empty list,
   *  which means "file is now clean") replaces the previous snapshot.
   *
   *  Also answers a few server→client requests some servers send after
   *  initialize: `workspace/configuration` (typescript-language-server
   *  won't push diagnostics unless it's answered — we return nulls, i.e.
   *  "use your defaults"), and `client/registerCapability` (dynamic
   *  registration, which we advertise as static-only and ignore). */
  private installDiagListener(): void {
    if (this.diagListenerInstalled || !this.conn) return;
    this.diagListenerInstalled = true;
    this.conn.onNotification(lsp.PublishDiagnosticsNotification.method, (params) => {
      this.diagnosticsByUri.set(params.uri, params.diagnostics ?? []);
      const waiters = this.diagWaiters.get(params.uri);
      if (waiters) {
        for (const w of waiters) w();
        this.diagWaiters.delete(params.uri);
      }
    });
    // Answer workspace/configuration with nulls ("use server defaults").
    // Returning an error here makes some servers (tsserver) skip diagnostics.
    this.conn.onRequest(lsp.ConfigurationRequest.method, (params) =>
      // Return an empty object per item ("no overrides, use your defaults")
      // rather than null — some servers (tsserver) won't enable features
      // unless they receive *some* settings object.
      (params.items ?? []).map(() => ({})),
    );
    // Ignore dynamic-capability registration (we advertise static only)
    // and $/logTrace — handled as raw method strings since the optional
    // request/notification names vary across protocol versions.
    this.conn.onRequest("client/registerCapability", () => null);
    this.conn.onNotification("$/logTrace", () => { /* ignore */ });
  }

  /** Resolve when the server has analyzed `uri` — best-effort.
   *
   *  The readiness signal is `textDocument/publishDiagnostics`, which most
   *  servers send (even an empty list) once they've analyzed the file. But
   *  some servers (marksman, nil, glsl_analyzer, …) never publish
   *  diagnostics at all; for those, we don't want to block. So we wait at
   *  most `fallbackMs` (default 1500ms — empirically diagnostics arrive in
   *  <500ms or never), then proceed regardless. The caller's own timeout
   *  governs the worst case; there is no hard kill here. */
  async waitForDocReady(
    uri: string,
    fallbackMs = 1500,
    onFallback?: () => void,
  ): Promise<void> {
    if (!this.conn) return;
    const norm = normalizeUri(uri);
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(t);
        resolve();
      };
      const t = setTimeout(() => {
        onFallback?.();
        finish();
      }, fallbackMs);
      const wake = () => finish();
      const arr = this.diagWaiters.get(norm) ?? [];
      arr.push(wake);
      this.diagWaiters.set(norm, arr);
      // Also resolve if the server process dies, so we never hang on a
      // crashed LSP.
      if (this.proc) {
        this.proc.once("exit", finish);
      }
    });
  }

  async initialize(): Promise<ServerCapabilities> {
    if (!this.conn) throw new Error("LspClient.start() not called");
    const result = await this.conn.sendRequest<lsp.InitializeResult>(
      lsp.InitializeRequest.method,
      {
        processId: process.pid,
        rootUri: this.rootUri,
        capabilities: clientCapabilities(),
        initializationOptions: this.launch.initializationOptions ?? undefined,
        workspaceFolders: [{ uri: this.rootUri, name: "root" }],
      },
    );
    this.capabilities = result.capabilities;
    return result.capabilities;
  }

  async initialized(): Promise<void> {
    if (!this.conn) return;
    await this.conn.sendNotification(lsp.InitializedNotification.method, {});
  }

  /** DidOpen a doc, tracking version. No-op if already open with same text.
   *  `onIndexFallback` is called if the server never publishes diagnostics
   *  for this doc (rare); we proceed regardless. */
  async openDoc(
    uri: string,
    text: string,
    languageId: string,
    onIndexFallback?: () => void,
  ): Promise<void> {
    if (!this.conn) throw new Error("LspClient not started");
    const norm = normalizeUri(uri);
    const existing = this.openDocs.get(norm);
    if (existing && existing.text === text) return;
    const version = existing ? existing.version + 1 : this.nextVersion++;
    const item: lsp.TextDocumentItem = { uri: norm, languageId, version, text };
    this.conn.sendNotification(lsp.DidOpenTextDocumentNotification.method, {
      textDocument: item,
    });
    this.openDocs.set(norm, { uri: norm, languageId, version, text });
    // Wait for the server to finish analyzing the doc (best-effort), so
    // the immediately-following navigation request usually sees an indexed
    // file. Servers that never publish diagnostics resolve via fallback.
    await this.waitForDocReady(norm, 1500, onIndexFallback);
  }

  async closeDoc(uri: string): Promise<void> {
    if (!this.conn) return;
    const norm = normalizeUri(uri);
    if (!this.openDocs.has(norm)) return;
    this.conn.sendNotification(lsp.DidCloseTextDocumentNotification.method, {
      textDocument: { uri: norm },
    });
    this.openDocs.delete(norm);
  }

  /** Re-sync a doc whose on-disk text was changed externally (e.g. after
   *  `rename --apply` wrote edits). If the doc is open and the text differs,
   *  sends a `textDocument/didChange` (full-document sync) — NOT a second
   *  didOpen, which would be a protocol violation on an already-open doc.
   *  If the doc was never opened, opens it fresh (didOpen). If the text is
   *  unchanged, no-op. Fire-and-forget: no readiness wait; the next query
   *  sees the synced text. */
  syncDoc(uri: string, text: string, languageId: string): void {
    if (!this.conn) return;
    const norm = normalizeUri(uri);
    const existing = this.openDocs.get(norm);
    if (existing && existing.text === text) return;
    if (!existing) {
      // Server never saw this doc — fresh didOpen.
      const version = this.nextVersion++;
      const item: lsp.TextDocumentItem = { uri: norm, languageId, version, text };
      this.conn.sendNotification(lsp.DidOpenTextDocumentNotification.method, {
        textDocument: item,
      });
      this.openDocs.set(norm, { uri: norm, languageId, version, text });
      return;
    }
    // Already open + text changed → didChange (full sync, bump version).
    const version = existing.version + 1;
    this.conn.sendNotification(lsp.DidChangeTextDocumentNotification.method, {
      textDocument: { uri: norm, version },
      contentChanges: [{ text }],
    });
    this.openDocs.set(norm, { uri: norm, languageId, version, text });
  }

  pos(fileOrUri: string, line: number, character: number): lsp.TextDocumentPositionParams {
    return {
      textDocument: { uri: normalizeUri(fileOrUri) },
      position: { line, character },
    };
  }

  // ---- Navigation requests (each guarded by capability) ----

  async definition(
    p: lsp.TextDocumentPositionParams,
  ): Promise<lsp.Definition | lsp.LocationLink[] | null> {
    if (!this.supports("definitionProvider")) return null;
    return this.conn!.sendRequest(lsp.DefinitionRequest.method, p);
  }

  async declaration(
    p: lsp.TextDocumentPositionParams,
  ): Promise<lsp.Declaration | lsp.LocationLink[] | null> {
    if (!this.supports("declarationProvider")) return null;
    return this.conn!.sendRequest(lsp.DeclarationRequest.method, p);
  }

  async typeDefinition(
    p: lsp.TextDocumentPositionParams,
  ): Promise<lsp.Definition | lsp.LocationLink[] | null> {
    if (!this.supports("typeDefinitionProvider")) return null;
    return this.conn!.sendRequest(lsp.TypeDefinitionRequest.method, p);
  }

  async implementation(
    p: lsp.TextDocumentPositionParams,
  ): Promise<lsp.Definition | lsp.LocationLink[] | null> {
    if (!this.supports("implementationProvider")) return null;
    return this.conn!.sendRequest(lsp.ImplementationRequest.method, p);
  }

  async references(p: lsp.TextDocumentPositionParams): Promise<lsp.Location[] | null> {
    if (!this.supports("referencesProvider")) return null;
    return this.conn!.sendRequest(lsp.ReferencesRequest.method, {
      ...p,
      context: { includeDeclaration: true },
    });
  }

  // ---- Call hierarchy (control-flow navigation) ----
  // Two-step: prepareCallHierarchy(position) → CallHierarchyItem[] (usually
  // one: the function at that position), then incomingCalls/outgoingCalls
  // on each item. incoming = who calls this; outgoing = what this calls.
  // The fromRanges in the result are the call sites — for incoming they're
  // in the caller's document, for outgoing in the queried document.

  async prepareCallHierarchy(
    p: lsp.TextDocumentPositionParams,
  ): Promise<lsp.CallHierarchyItem[] | null> {
    if (!this.supports("callHierarchyProvider")) return null;
    return this.conn!.sendRequest(lsp.CallHierarchyPrepareRequest.method, p);
  }

  async incomingCalls(
    item: lsp.CallHierarchyItem,
  ): Promise<lsp.CallHierarchyIncomingCall[] | null> {
    if (!this.supports("callHierarchyProvider")) return null;
    return this.conn!.sendRequest(lsp.CallHierarchyIncomingCallsRequest.method, {
      item,
    });
  }

  async outgoingCalls(
    item: lsp.CallHierarchyItem,
  ): Promise<lsp.CallHierarchyOutgoingCall[] | null> {
    if (!this.supports("callHierarchyProvider")) return null;
    return this.conn!.sendRequest(lsp.CallHierarchyOutgoingCallsRequest.method, {
      item,
    });
  }

  // ---- Type hierarchy (inheritance navigation) ----
  // Two-step: prepareTypeHierarchy(position) → TypeHierarchyItem[] (usually
  // one: the type at that position), then supertypes/subtypes on each item.
  // supertypes = what this inherits from; subtypes = what inherits from this.
  // Mirrors call hierarchy exactly.

  async prepareTypeHierarchy(
    p: lsp.TextDocumentPositionParams,
  ): Promise<lsp.TypeHierarchyItem[] | null> {
    // NOTE: some servers (typescript-language-server) register request
    // handlers for type hierarchy but don't advertise typeHierarchyProvider
    // in their capabilities. So we don't gate on the capability here — we
    // send the request and let the server respond (null/error if unsupported).
    if (!this.conn) return null;
    return this.conn!.sendRequest(lsp.TypeHierarchyPrepareRequest.method, p);
  }

  async supertypes(
    item: lsp.TypeHierarchyItem,
  ): Promise<lsp.TypeHierarchyItem[] | null> {
    if (!this.conn) return null;
    return this.conn!.sendRequest(lsp.TypeHierarchySupertypesRequest.method, { item });
  }

  async subtypes(
    item: lsp.TypeHierarchyItem,
  ): Promise<lsp.TypeHierarchyItem[] | null> {
    if (!this.conn) return null;
    return this.conn!.sendRequest(lsp.TypeHierarchySubtypesRequest.method, { item });
  }

  async hover(p: lsp.TextDocumentPositionParams): Promise<lsp.Hover | null> {
    if (!this.supports("hoverProvider")) return null;
    return this.conn!.sendRequest(lsp.HoverRequest.method, p);
  }

  async documentSymbol(
    uri: string,
  ): Promise<lsp.DocumentSymbol[] | lsp.SymbolInformation[] | null> {
    if (!this.supports("documentSymbolProvider")) return null;
    return this.conn!.sendRequest(lsp.DocumentSymbolRequest.method, {
      textDocument: { uri: normalizeUri(uri) },
    });
  }

  async workspaceSymbol(
    query: string,
  ): Promise<lsp.SymbolInformation[] | lsp.WorkspaceSymbol[] | null> {
    if (!this.supports("workspaceSymbolProvider")) return null;
    return this.conn!.sendRequest(lsp.WorkspaceSymbolRequest.method, { query });
  }

  async prepareRename(
    p: lsp.TextDocumentPositionParams,
  ): Promise<lsp.PrepareRenameResult | null> {
    const rename = this.capabilities?.renameProvider;
    if (!rename) return null;
    if (typeof rename === "object" && rename.prepareProvider === false) return null;
    return this.conn!.sendRequest(lsp.PrepareRenameRequest.method, p);
  }

  /** Perform a rename: returns a WorkspaceEdit describing the exact text
   *  changes across all files (server-computed ranges — no symbol-span
   *  guessing). The CLI applies these with `--apply`, or prints them as a
   *  dry-run plan otherwise. Handles both `changes` (legacy) and
   *  `documentChanges` (LSP 3.x) forms. */
  async rename(
    p: lsp.TextDocumentPositionParams,
    newName: string,
  ): Promise<lsp.WorkspaceEdit | null> {
    if (!this.supports("renameProvider")) return null;
    return this.conn!.sendRequest(lsp.RenameRequest.method, {
      ...p,
      newName,
    });
  }

  async shutdown(): Promise<void> {
    if (!this.conn) return;
    try {
      await this.conn.sendRequest(lsp.ShutdownRequest.method, undefined);
    } catch {
      /* server may be gone */
    }
  }

  async exit(): Promise<void> {
    if (this.conn) {
      try {
        this.conn.sendNotification(lsp.ExitNotification.method);
      } catch {
        /* ignore */
      }
    }
    this.conn?.dispose();
    this.conn = null;
    if (this.proc && !this.proc.killed) {
      this.proc.stdin?.end();
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          this.proc?.kill("SIGKILL");
          resolve();
        }, 1500);
        this.proc?.once("exit", () => {
          clearTimeout(t);
          resolve();
        });
      });
    }
    this.proc = null;
    this.openDocs.clear();
  }

  private supports(key: keyof ServerCapabilities): boolean {
    const v = this.capabilities?.[key];
    return v === true || (typeof v === "object" && v !== null);
  }
}

/** file: path or already-URI -> canonical file:// URI string. */
export function normalizeUri(fileOrUri: string): string {
  if (fileOrUri.startsWith("file:")) return URI.parse(fileOrUri).toString();
  return URI.file(fileOrUri).toString();
}

/** file:// URI -> filesystem path. */
export function uriToPath(uri: string): string {
  return URI.parse(uri).fsPath;
}
