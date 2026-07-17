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
  query?: string;
  newName?: string;
  depth?: number;
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
      "Navigate and inspect code semantically through the workspace language server. Results are terse and include source snippets. Prefer this over grep/read when locating definitions, references, implementations, callers, callees, types, symbols, or diagnostics. Rename is dry-run unless apply=true.",
    promptSnippet:
      "Use lspx for semantic code navigation: workspace_symbols → definitions/references/call hierarchy; map for structural overviews; diagnostics after edits.",
    promptGuidelines: [
      "Use workspace_symbols to find a module-level symbol by name, then use the returned 1-indexed position for definitions, references, callers, callees, or rename.",
      "Prefer callers over references when you specifically need invocation sites.",
      "Prefer map or symbols over reading an entire large source file just to understand its structure.",
      "Rename is a dry-run by default. Set apply=true only when the rename should be written.",
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
      line: Type.Optional(Type.Integer({ minimum: 1, description: "1-indexed source line." })),
      column: Type.Optional(Type.Integer({ minimum: 1, description: "1-indexed source column on the symbol." })),
      query: Type.Optional(
        Type.String({
          description: "Symbol query for workspace_symbols, or optional language filter for doctor.",
        }),
      ),
      newName: Type.Optional(Type.String({ description: "New symbol name for rename." })),
      depth: Type.Optional(
        Type.Integer({ minimum: 1, maximum: 10, description: "Call-hierarchy depth for callers/callees (default 1)." }),
      ),
      apply: Type.Optional(
        Type.Boolean({ description: "Apply rename edits. False/omitted keeps the safe dry-run default." }),
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

  /** Run a stdin-plan lspx command (replace-symbols / batch-edit), returning
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
    const { writeFileSync, unlinkSync, mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "lspx-plan-"));
    const planPath = join(dir, "plan.json");
    writeFileSync(planPath, JSON.stringify(plan));
    try {
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
      try { unlinkSync(planPath); } catch { /* best-effort */ }
      try { (await import("node:fs")).rmdirSync(dir); } catch { /* best-effort */ }
    }
  }

  pi.registerTool({
    name: "replace_symbols",
    label: "LSP Symbol Replacement",
    description:
      "Replace one or more symbols (functions/methods/classes) by name or position with new source, atomically. Targets are resolved by the language server (true AST ranges), so this is more precise than text-based editing. One stale or ambiguous target aborts the entire batch — nothing is partially applied. Dry-run unless apply=true. Verifies fresh diagnostics after apply.",
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
      "Apply exact oldText→newText edits across multiple files in one atomic, staleness-guarded transaction. One failed match or overlap aborts the whole batch (no partial applies). After apply, re-syncs the language server and verifies fresh diagnostics. This is the multi-file batching capability — prefer it over many single edits when touching several files.",
    promptSnippet:
      "Use batch_edit to apply several exact-match edits across files in one call. Each oldText must be unique in its file.",
    promptGuidelines: [
      "Each `oldText` must appear exactly once in its file (first match is used).",
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
