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
      rename: { prepareSupport: true },
    },
    workspace: {
      symbol: {},
    },
  };
}

export class LspClient {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private conn: MessageConnection | null = null;
  private capabilities: ServerCapabilities | null = null;
  private openDocs = new Map<string, OpenedDoc>();
  private nextVersion = 1;
  readonly rootUri: string;
  private readonly logger: Logger;
  /** Resolves when diagnostics are published for a given URI (readiness signal). */
  private diagWaiters = new Map<string, Array<() => void>>();
  private diagListenerInstalled = false;

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

  /** Listen for textDocument/publishDiagnostics and notify waiters. */
  private installDiagListener(): void {
    if (this.diagListenerInstalled || !this.conn) return;
    this.diagListenerInstalled = true;
    this.conn.onNotification(lsp.PublishDiagnosticsNotification.method, (params) => {
      const waiters = this.diagWaiters.get(params.uri);
      if (waiters) {
        for (const w of waiters) w();
        this.diagWaiters.delete(params.uri);
      }
    });
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
