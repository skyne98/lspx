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
}
