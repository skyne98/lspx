import { fileURLToPath } from "node:url";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const OPERATIONS = [
  "definitions",
  "declaration",
  "type_definition",
  "implementations",
  "references",
  "callers",
  "callees",
  "supertypes",
  "subtypes",
  "hover",
  "symbols",
  "workspace_symbols",
  "map",
  "diagnostics",
  "source",
  "context",
  "selection",
  "code_actions",
  "format",
  "open",
  "rename",
  "status",
  "doctor",
] as const;

type Operation = (typeof OPERATIONS)[number];

interface LspxParams {
  operation: Operation;
  path?: string;
  line?: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
  query?: string;
  symbol?: string;
  within?: string;
  container?: string;
  newName?: string;
  depth?: number;
  budget?: number;
  kind?: string;
  select?: string;
  tabSize?: number;
  tabs?: boolean;
  verify?: boolean;
  apply?: boolean;
  snippets?: boolean;
  includeCalls?: boolean;
  includeDependencies?: boolean;
  server?: string;
  language?: string;
}

const NAV_COMMANDS: Partial<Record<Operation, string>> = {
  definitions: "defs",
  declaration: "decl",
  type_definition: "typedef",
  implementations: "impl",
  references: "refs",
  callers: "callers",
  callees: "callees",
  supertypes: "supertypes",
  subtypes: "subtypes",
  hover: "hover",
};

const LOCAL_BIN = fileURLToPath(new URL("../bin/lspx.js", import.meta.url));

function requireValue<T>(value: T | undefined, name: string, operation: Operation): T {
  if (value === undefined || value === "") {
    throw new Error(`${operation} requires ${name}`);
  }
  return value;
}

function buildArgs(params: LspxParams): string[] {
  const args: string[] = [];
  const navCommand = NAV_COMMANDS[params.operation];

  if (navCommand) {
    args.push(
      navCommand,
      requireValue(params.path, "path", params.operation),
      String(requireValue(params.line, "line", params.operation)),
      String(requireValue(params.column, "column", params.operation)),
    );
    if ((params.operation === "callers" || params.operation === "callees") && params.depth !== undefined) {
      args.push("--depth", String(params.depth));
    }
  } else {
    switch (params.operation) {
      case "symbols":
        args.push("symbols", requireValue(params.path, "path", params.operation));
        break;
      case "workspace_symbols":
        args.push("ws-symbols", requireValue(params.query, "query", params.operation));
        break;
      case "map":
        args.push("map");
        if (params.path) args.push(params.path);
        if (params.includeCalls === false) args.push("--no-calls");
        if (params.includeDependencies === true) args.push("--all");
        break;
      case "diagnostics":
        args.push("diagnostics", requireValue(params.path, "path", params.operation));
        break;
      case "source":
      case "context":
        args.push(params.operation);
        if (params.symbol) {
          args.push("--symbol", params.symbol);
          if (params.within) args.push("--within", params.within);
          if (params.container) args.push("--container", params.container);
        } else {
          args.push(
            requireValue(params.path, "path", params.operation),
            String(requireValue(params.line, "line", params.operation)),
            String(requireValue(params.column, "column", params.operation)),
          );
        }
        if (params.operation === "context") {
          if (params.depth !== undefined) args.push("--depth", String(params.depth));
          if (params.budget !== undefined) args.push("--budget", String(params.budget));
        }
        break;
      case "selection":
        args.push(
          "selection",
          requireValue(params.path, "path", params.operation),
          String(requireValue(params.line, "line", params.operation)),
          String(requireValue(params.column, "column", params.operation)),
        );
        break;
      case "code_actions":
        args.push(
          "code-actions",
          requireValue(params.path, "path", params.operation),
          String(requireValue(params.line, "line", params.operation)),
          String(requireValue(params.column, "column", params.operation)),
        );
        if ((params.endLine === undefined) !== (params.endColumn === undefined)) {
          throw new Error("code_actions range requires both endLine and endColumn");
        }
        if (params.endLine !== undefined && params.endColumn !== undefined) {
          args.push("--range", `${params.line}:${params.column}-${params.endLine}:${params.endColumn}`);
        }
        if (params.kind) args.push("--kind", params.kind);
        if (params.select) args.push("--select", params.select);
        if (params.apply) args.push("--apply");
        if (params.verify === false) args.push("--no-verify");
        break;
      case "format":
        args.push("format", requireValue(params.path, "path", params.operation));
        const rangeParts = [params.line, params.column, params.endLine, params.endColumn];
        if (rangeParts.some((part) => part !== undefined) && rangeParts.some((part) => part === undefined)) {
          throw new Error("format range requires line, column, endLine, and endColumn");
        }
        if (params.line !== undefined && params.column !== undefined && params.endLine !== undefined && params.endColumn !== undefined) {
          args.push("--range", `${params.line}:${params.column}-${params.endLine}:${params.endColumn}`);
        }
        if (params.tabSize !== undefined) args.push("--tab-size", String(params.tabSize));
        if (params.tabs) args.push("--tabs");
        if (params.apply) args.push("--apply");
        if (params.verify === false) args.push("--no-verify");
        break;
      case "open":
        args.push("open", requireValue(params.path, "path", params.operation));
        break;
      case "rename":
        args.push(
          "rename",
          requireValue(params.path, "path", params.operation),
          String(requireValue(params.line, "line", params.operation)),
          String(requireValue(params.column, "column", params.operation)),
          requireValue(params.newName, "newName", params.operation),
        );
        if (params.apply === true) args.push("--apply");
        break;
      case "status":
        args.push("status");
        break;
      case "doctor":
        args.push("doctor");
        if (params.query) args.push(params.query);
        break;
    }
  }

  if (params.snippets === false && !args.includes("--no-snippet")) args.push("--no-snippet");
  if (params.server) args.push("--server", params.server);
  if (params.language) args.push("--language", params.language);
  return args;
}

function usefulStderr(stderr: string): string {
  return stderr
    .split("\n")
    .filter((line) => /(?:warning|error|hint|⚠)/i.test(line))
    .join("\n")
    .trim();
}

export default function lspxExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "lspx",
    label: "LSP Code Intelligence",
    description:
      "Navigate, gather bounded context, inspect selection ranges, and invoke server refactors/formatting through workspace language servers. Prefer this over grep/read for definitions, references, implementations, callers, callees, types, symbols, declaration source, or diagnostics. Rename, code actions, and formatting are dry-run unless apply=true.",
    promptSnippet:
      "Use lspx for semantic navigation; context for a bounded target+call/type/diagnostic pack; source for one declaration; map for structural overviews; code_actions/format for server-computed edits.",
    promptGuidelines: [
      "Use workspace_symbols to find a module-level symbol by name, then use the returned 1-indexed position for definitions, references, callers, callees, or rename.",
      "Prefer callers over references when you specifically need invocation sites.",
      "Prefer map or symbols over reading an entire large source file just to understand its structure; use source to read one complete declaration.",
      "Use context for a bounded target+call/type/diagnostic pack instead of repeated source/navigation calls.",
      "Rename, code_actions, and format are dry-run by default. Set apply=true only when edits should be written.",
    ],
    parameters: Type.Object({
      operation: StringEnum(OPERATIONS, {
        description: "Exact semantic operation to perform.",
      }),
      path: Type.Optional(
        Type.String({
          description: "Workspace-relative source path. Required by position, symbols, diagnostics, open, and rename operations; optional for map.",
        }),
      ),
      line: Type.Optional(Type.Integer({ minimum: 1, description: "1-indexed source/range-start line." })),
      column: Type.Optional(Type.Integer({ minimum: 1, description: "1-indexed source/range-start column." })),
      endLine: Type.Optional(Type.Integer({ minimum: 1, description: "1-indexed range end line for code_actions/format." })),
      endColumn: Type.Optional(Type.Integer({ minimum: 1, description: "1-indexed range end column for code_actions/format." })),
      query: Type.Optional(
        Type.String({
          description: "Symbol query for workspace_symbols, or optional language filter for doctor.",
        }),
      ),
      symbol: Type.Optional(Type.String({ description: "Exact symbol name for source name-based resolution." })),
      within: Type.Optional(Type.String({ description: "Restrict source name resolution to this file/directory." })),
      container: Type.Optional(Type.String({ description: "Restrict source name resolution to this containing symbol/module." })),
      newName: Type.Optional(Type.String({ description: "New symbol name for rename." })),
      depth: Type.Optional(
        Type.Integer({ minimum: 1, maximum: 10, description: "Call-hierarchy or context depth (context max 4, default 1)." }),
      ),
      budget: Type.Optional(Type.Integer({ minimum: 256, maximum: 200000, description: "Context content-character budget (default 12000)." })),
      kind: Type.Optional(Type.String({ description: "Code-action kind filter, e.g. quickfix or refactor.extract." })),
      select: Type.Optional(Type.String({ description: "Code action to select by 1-based index or exact kind." })),
      tabSize: Type.Optional(Type.Integer({ minimum: 1, maximum: 16, description: "Formatting tab size (default 2)." })),
      tabs: Type.Optional(Type.Boolean({ description: "Use tabs rather than spaces for formatting." })),
      verify: Type.Optional(Type.Boolean({ description: "Verify fresh diagnostics after mutation (default true)." })),
      apply: Type.Optional(
        Type.Boolean({ description: "Apply rename/code-action/format edits. False/omitted keeps the safe dry-run default." }),
      ),
      snippets: Type.Optional(
        Type.Boolean({ description: "Include source snippets (default true). Set false for compact location-only output." }),
      ),
      includeCalls: Type.Optional(
        Type.Boolean({ description: "For map, enrich symbols with call edges (default true)." }),
      ),
      includeDependencies: Type.Optional(
        Type.Boolean({ description: "For map, include dependency/stdlib calls (default false)." }),
      ),
      server: Type.Optional(Type.String({ description: "Force a language-server id instead of auto-detection." })),
      language: Type.Optional(Type.String({ description: "Force an LSP language id instead of extension detection." })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      let args: string[];
      try {
        args = buildArgs(params as LspxParams);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `error[invalid-arguments]: ${message}` }],
          details: { operation: params.operation, code: 1 },
        };
      }

      const result = await pi.exec("bun", [LOCAL_BIN, ...args], {
        cwd: ctx.cwd,
        signal,
        timeout: 120_000,
      });

      const stdout = result.stdout.trim();
      const stderr = result.stderr.trim();
      if (result.code !== 0) {
        const text = [stderr, stdout].filter(Boolean).join("\n") || `lspx exited with code ${result.code}`;
        return {
          content: [{ type: "text", text }],
          details: { operation: params.operation, args, code: result.code },
        };
      }

      const warning = usefulStderr(stderr);
      const text = [stdout || "(no results)", warning].filter(Boolean).join("\n");
      return {
        content: [{ type: "text", text }],
        details: { operation: params.operation, args, code: 0 },
      };
    },
  });

  /** Run a JSON-plan lspx command (replace-symbols / batch-edit), returning
   *  the structured --json result to the model. Shared by the two batched
   *  editing tools — the daemon owns all resolution + transaction + verify
   *  logic; the extension is a thin typed adapter. Writes the plan to a temp
   *  file (pi.exec has no stdin option) and passes --plan. */
  async function runPlanTool(
    command: string,
    plan: unknown,
    opts: { apply?: boolean; verify?: boolean },
    _toolCallId: string,
    signal: AbortSignal | undefined,
    ctx: { cwd: string },
  ) {
    const { writeFileSync, mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "lspx-plan-"));
    const planPath = join(dir, "plan.json");
    try {
      writeFileSync(planPath, JSON.stringify(plan), { mode: 0o600 });
      const args = [LOCAL_BIN, command, "--plan", planPath, "--json"];
      if (opts.apply) args.push("--apply");
      if (opts.verify === false) args.push("--no-verify");
      const result = await pi.exec("bun", args, {
        cwd: ctx.cwd,
        signal: signal ?? undefined,
        timeout: 180_000,
      });
      const stdout = result.stdout.trim();
      const stderr = result.stderr.trim();
      const text = [stdout || "(no result)", usefulStderr(stderr)].filter(Boolean).join("\n");
      return {
        content: [{ type: "text" as const, text }],
        details: { command, applied: Boolean(opts.apply), code: result.code },
      };
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  }

  pi.registerTool({
    name: "replace_symbols",
    label: "LSP Symbol Replacement",
    description:
      "Replace one or more symbols (functions/methods/classes) by name or position in one staleness-guarded transaction. Targets are resolved by the language server (true AST ranges), so this is more precise than text-based editing. One stale or ambiguous target aborts before any write. Dry-run unless apply=true. Verifies fresh diagnostics after apply.",
    promptSnippet:
      "Use replace_symbols to rewrite whole function/method/class bodies by name. Prefer this over edit when replacing an entire declaration.",
    promptGuidelines: [
      "Provide the COMPLETE replacement for each symbol (signature + body + doc comments).",
      "Resolve by name with `symbol` (+ `within`/`container` to disambiguate) or by `path`+`line`+`column`.",
      "Set apply=true to write; otherwise the tool returns a dry-run plan.",
      "One ambiguous symbol returns candidates and aborts — narrow with `within`/`container`.",
    ],
    parameters: Type.Object({
      replacements: Type.Array(
        Type.Object({
          symbol: Type.Optional(Type.String({ description: "Exact symbol name to replace (name-based resolution)." })),
          path: Type.Optional(Type.String({ description: "Workspace-relative path (position-based resolution)." })),
          line: Type.Optional(Type.Integer({ minimum: 1, description: "1-indexed line (position-based)." })),
          column: Type.Optional(Type.Integer({ minimum: 1, description: "1-indexed column on the symbol (position-based)." })),
          within: Type.Optional(Type.String({ description: "Restrict name resolution to a file/directory." })),
          container: Type.Optional(Type.String({ description: "Restrict to a containing symbol/module." })),
          text: Type.String({ description: "Complete new source for the symbol." }),
        }),
        { minItems: 1 },
      ),
      apply: Type.Optional(Type.Boolean({ description: "Apply to disk. False/omitted = dry-run plan." })),
      verify: Type.Optional(Type.Boolean({ description: "Verify fresh diagnostics after apply (default true)." })),
    }),
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      return runPlanTool(
        "replace-symbols",
        params.replacements,
        { apply: params.apply, verify: params.verify },
        toolCallId,
        signal,
        ctx,
      );
    },
  });

  pi.registerTool({
    name: "batch_edit",
    label: "Batched Text Edits",
    description:
      "Apply exact oldText→newText edits across multiple files in one staleness-guarded transaction. One failed, ambiguous, or overlapping match aborts before any write; write failures trigger best-effort rollback. After apply, re-syncs the language server and verifies fresh diagnostics. Prefer this over many single edits when touching several files.",
    promptSnippet:
      "Use batch_edit to apply several exact-match edits across files in one call. Each oldText must be unique in its file.",
    promptGuidelines: [
      "Each `oldText` must appear exactly once in its file; repeated matches are rejected.",
      "Include enough surrounding context in `oldText` to be unique.",
      "Set apply=true to write; otherwise returns a dry-run plan.",
    ],
    parameters: Type.Object({
      files: Type.Array(
        Type.Object({
          path: Type.String({ description: "Workspace-relative file path." }),
          edits: Type.Array(
            Type.Object({
              oldText: Type.String({ description: "Exact text to find (must be unique in the file)." }),
              newText: Type.String({ description: "Replacement text." }),
            }),
            { minItems: 1 },
          ),
        }),
        { minItems: 1 },
      ),
      apply: Type.Optional(Type.Boolean({ description: "Apply to disk. False/omitted = dry-run plan." })),
      verify: Type.Optional(Type.Boolean({ description: "Verify fresh diagnostics via lspx after apply (default true)." })),
    }),
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      return runPlanTool(
        "batch-edit",
        params.files,
        { apply: params.apply, verify: params.verify },
        toolCallId,
        signal,
        ctx,
      );
    },
  });
}
