// lspx command dispatch.
//
// The CLI is the only interface (no MCP). Following the agent-browser model:
// a persistent per-workspace daemon owns the language server; each CLI
// command connects to it (auto-spawning on first use), issues one request,
// and prints compact output. `--json` gives machine-readable output.

import { resolve } from "node:path";
import { renderDoctor } from "./doctor.ts";
import { Daemon } from "./daemon/daemon.ts";
import { ensureDaemon, call, socketForWorkspace } from "./daemon/rpc.ts";
import type { DaemonRequest } from "./daemon/protocol.ts";
import type { ProgressSink } from "./progress.ts";
import {
  formatLocations,
  formatHover,
  formatSymbols,
  formatStatus,
  formatCallHierarchy,
  formatCallHierarchyTree,
  formatTypeHierarchy,
  formatDiagnostics,
  formatRename,
} from "./format.ts";
import { c } from "./color.ts";
import { applyWorkspaceEdit, defaultIO } from "./edit.ts";
import { formatCodemap } from "./format.ts";


const VERSION = "0.1.0";

export interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Record<string, boolean | string | number>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, boolean | string | number> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--color") flags.color = true;
    else if (a === "--no-color") flags.color = false;
    else if (a === "--snippet") flags.snippet = true;
    else if (a === "--no-snippet") flags.snippet = false;
    else if (a === "-h" || a === "--help") flags.help = true;
    else if (a === "-v" || a === "--version") flags.version = true;
    else if (a === "--json") flags.json = true;
    else if (a === "--server") flags.server = argv[++i] ?? "";
    else if (a === "--language") flags.language = argv[++i] ?? "";
    else if (a === "--depth") flags.depth = Number(argv[++i]) || 1;
    else if (a === "--apply") flags.apply = true;
    else if (a === "--no-calls") flags["no-calls"] = true;
    else if (a === "--workspace" || a === "-w") flags.workspace = argv[++i] ?? "";
    else if (a.startsWith("--")) flags[a.slice(2)] = true;
    else positional.push(a);
  }
  return { command: positional[0] ?? "help", positional: positional.slice(1), flags };
}

function workspaceRoot(flags: Record<string, boolean | string | number>): string {
  const w = typeof flags.workspace === "string" ? flags.workspace : process.cwd();
  return resolve(w);
}

/** Format options shared by every result renderer. Snippets default ON so
 *  agents see the code at each location without a separate read_file. */
function fmtOpts(flags: Record<string, boolean | string | number>): {
  workspaceRoot: string;
  json: boolean;
  snippet: boolean;
} {
  return {
    workspaceRoot: workspaceRoot(flags),
    json: !!flags.json,
    snippet: flags.snippet !== false,
  };
}

/** Progress sink for the CLI: one dim line to stderr. stdout stays clean
 *  for the result / --json output, so progress never corrupts JSON. */
function cliProgress(): ProgressSink {
  return (msg) => {
    process.stderr.write(`${c.dim("lspx: ")}${c.dim(msg)}\n`);
  };
}

export function usage(): string {
  return [
    "lspx — LSP-powered code navigation for AI agents",
    "",
    "USAGE",
    "  lspx <command> [args] [--json] [--workspace <dir>] [--server <id>]",
    "  lspx <command> -h        # help for a command",
    "",
    "DAEMON COMMANDS",
    "  daemon              Run the per-workspace daemon in the foreground.",
    "  status              Show daemon + server capabilities.",
    "  close [--all]       Stop the daemon (current workspace, or --all).",
    "",
    "NAVIGATION  (file:line:col are 1-indexed, like editors)",
    "  defs <f> <l> <c>    Find definitions.",
    "  decl <f> <l> <c>    Find declarations.",
    "  typedef <f> <l> <c> Find type definitions.",
    "  impl <f> <l> <c>    Find implementations.",
    "  refs <f> <l> <c>    Find references.",
    "  callers <f> <l> <c> Who calls this function (call hierarchy, incoming).",
    "  callees <f> <l> <c> What this function calls (call hierarchy, outgoing).",
    "                   Add --depth N to walk the chain multiple levels (tree).",
    "  supertypes <f> <l> <c> What this type inherits from (type hierarchy, up).",
    "  subtypes <f> <l> <c>  What inherits from this type (type hierarchy, down).",
    "  hover <f> <l> <c>   Show hover/docs at position.",
    "",
    "REFACTOR (writes with --apply; dry-run by default)",
    "  rename <f> <l> <c> <new>  Rename symbol across workspace. Print plan,",
    "                           or --apply to write the edits to disk.",
    "",
    "SYMBOLS",
    "  symbols <f>        Document symbols (outline) for a file.",
    "  ws-symbols <q>     Workspace symbol search (fuzzy, by name).",
    "  map [path]         Codemap: all symbols + call edges for a file, dir,",
    "                     or the whole workspace. --no-calls for symbol-only,",
    "                     --all to include calls into deps/stdlib.",
    "",
    "HEALTH",
    "  diagnostics <f>    Live errors/warnings for a file (LSP push diagnostics).",
    "",
    "PRE-WARM",
    "  open <f>           Open a file in the server (triggers analysis) so the",
    "                     next defs/refs/symbols call is warm. Safe to repeat.",
    "",
    "DISCOVERY",
    "  doctor [lang]      Known vs installed language servers (Helix --health).",
    "  version            Print version.",
    "  help               Show this help.",
    "",
    "COMMON FLAGS",
    "  --json               Machine-readable output (raw, URI-normalized).",
    "  --workspace <dir>   Operate on a different workspace (default: $PWD).",
    "  --server <id>        Force a specific server id (see 'doctor').",
    "  --color/--no-color   Force ANSI colors on/off.",
    "  --no-snippet         Omit source snippets (default: include them).",
    "",
    "EXAMPLES",
    "  lspx doctor                       # what LSPs are installed?",
    "  lspx defs src/main.ts 12 5        # go-to-definition",
    "  lspx refs lib.rs 42 9 --json      # references, machine output",
    "  lspx symbols src/cli.ts          # file outline",
    "  lspx wsSymbols parseRequest       # workspace symbol search",
    "",
    "The daemon auto-starts on first use and persists between commands,",
    "so you can chain with && like:  lspx defs f 1 1 && lspx refs f 1 1",
  ].join("\n");
}

const HELP_COMMANDS = new Set(["help", "h", "--help", "-h"]);

export async function run(argv: string[]): Promise<number> {
  const { command, positional, flags } = parseArgs(argv);

  if (flags.color !== undefined) {
    const { setColorEnabled } = await import("./color.ts");
    setColorEnabled(Boolean(flags.color));
  }

  if (flags.version || command === "version") {
    console.log(`lspx ${VERSION}`);
    return 0;
  }
  if (flags.help || command === "help" || command === undefined) {
    console.log(usage());
    return 0;
  }

  switch (command) {
    case "doctor":
    case "health":
      console.log(renderDoctor(positional[0]));
      return 0;
    case "daemon":
      return runDaemon(positional, flags);
    case "status":
      return await runDaemonCommand(flags, { m: "status" }, (r) =>
        formatStatus(r as Record<string, unknown>, fmtOpts(flags)),
      );
    case "close":
    case "stop":
    case "quit":
      return await runClose(flags);
    case "defs":
    case "def":
    case "definition":
      return await runNav(flags, positional, "defs");
    case "decl":
    case "declaration":
      return await runNav(flags, positional, "decl");
    case "typedef":
    case "typeDefinition":
      return await runNav(flags, positional, "typedef");
    case "impl":
    case "implementation":
      return await runNav(flags, positional, "impl");
    case "refs":
    case "references":
      return await runNav(flags, positional, "refs");
    case "callers":
    case "caller":
    case "incoming":
      return await runCallHierarchy(flags, positional, "incoming");
    case "callees":
    case "callee":
    case "outgoing":
      return await runCallHierarchy(flags, positional, "outgoing");
    case "rename":
      return await runRename(flags, positional);
    case "supertypes":
    case "supertype":
    case "super":
    case "parents":
      return await runTypeHierarchy(flags, positional, "super");
    case "subtypes":
    case "subtype":
    case "sub":
    case "children":
      return await runTypeHierarchy(flags, positional, "sub");
    case "hover":
      return await runNav(flags, positional, "hover");
    case "diagnostics":
    case "diags":
    case "lint":
      return await runDiagnostics(flags, positional);
    case "symbols":
    case "docSymbols":
      return await runDocSymbols(flags, positional);
    case "ws-symbols":
    case "wsSymbols":
    case "workspace-symbols":
      return await runWsSymbols(flags, positional);
    case "map":
    case "codemap":
      return await runCodemap(flags, positional);
    case "open":
    case "warm":
    case "index":
      return await runOpen(flags, positional);
    default:
      if (HELP_COMMANDS.has(command)) {
        console.log(usage());
        return 0;
      }
      console.error(`${c.red("error")}: unknown command '${command}'\n`);
      console.error(usage());
      return 2;
  }
}

// ---- Command implementations ----

async function runDaemon(positional: string[], flags: Record<string, boolean | string | number>): Promise<number> {
  const ws = workspaceRoot(flags);
  const serverId = typeof flags.server === "string" ? flags.server : undefined;
  const languageId = typeof flags.language === "string" ? flags.language : undefined;
  const daemon = new Daemon({ workspaceRoot: ws, serverId, languageId });
  const onProgress = cliProgress();
  await daemon.start(onProgress);
  // Boot happens in the background; report its progress, then announce ready.
  if (daemon.booted) {
    try {
      await daemon.booted;
    } catch (err) {
      console.error(`${c.red("error")}: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
  }
  console.error(`${c.green("✓")} lspx daemon ready for ${c.cyan(ws)}`);
  console.error(`  socket: ${daemon.socketPath()}`);
  console.error(`  (Ctrl-C or 'lspx close' to stop)`);
  const stopped = new Promise<void>((res) => {
    const handler = () => {
      void daemon.stop().then(res);
    };
    process.on("SIGINT", handler);
    process.on("SIGTERM", handler);
  });
  await stopped;
  console.error(`${c.dim("daemon stopped")}`);
  return 0;
}

interface NavArgs {
  file: string;
  line: number;
  col: number;
}

function parseNavArgs(positional: string[]): NavArgs {
  if (positional.length < 3) {
    throw new Error("expected <file> <line> <col> (1-indexed)");
  }
  return { file: positional[0], line: Number(positional[1]), col: Number(positional[2]) };
}

/** Common daemon options derived from flags. */
function daemonOpts(flags: Record<string, boolean | string | number>): {
  serverId?: string;
  languageId?: string;
} {
  return {
    serverId: typeof flags.server === "string" ? flags.server : undefined,
    languageId: typeof flags.language === "string" ? flags.language : undefined,
  };
}

async function runNav(
  flags: Record<string, boolean | string | number>,
  positional: string[],
  method: string,
): Promise<number> {
  try {
    const { file, line, col } = parseNavArgs(positional);
    const ws = workspaceRoot(flags);
    const onProgress = cliProgress();
    const handle = await ensureDaemon(ws, daemonOpts(flags), onProgress);
    await call(handle.socketPath, { m: "open", a: [file] }, onProgress);
    const res = await call(
      handle.socketPath,
      { m: method, a: [file, line - 1, col - 1] },
      onProgress,
    );
    if (!res.ok) throw new Error(res.e ?? "daemon error");
    const opts = fmtOpts(flags);
    const out =
      method === "hover"
        ? formatHover(res.r as never, opts)
        : formatLocations(res.r as never, opts);
    console.log(out);
    return 0;
  } catch (err) {
    console.error(`${c.red("error")}: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

async function runCallHierarchy(
  flags: Record<string, boolean | string | number>,
  positional: string[],
  direction: "incoming" | "outgoing",
): Promise<number> {
  // --depth N (>1) walks the chain multiple levels as a tree.
  const depth = typeof flags.depth === "number" ? flags.depth : 1;
  if (depth > 1) return await runCallHierarchyTree(flags, positional, direction, depth);
  try {
    const { file, line, col } = parseNavArgs(positional);
    const ws = workspaceRoot(flags);
    const onProgress = cliProgress();
    const handle = await ensureDaemon(ws, daemonOpts(flags), onProgress);
    await call(handle.socketPath, { m: "open", a: [file] }, onProgress);
    const res = await call(
      handle.socketPath,
      { m: direction === "incoming" ? "callers" : "callees", a: [file, line - 1, col - 1] },
      onProgress,
    );
    if (!res.ok) throw new Error(res.e ?? "daemon error");
    console.log(formatCallHierarchy(res.r, direction, fmtOpts(flags)));
    return 0;
  } catch (err) {
    console.error(`${c.red("error")}: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

async function runCallHierarchyTree(
  flags: Record<string, boolean | string | number>,
  positional: string[],
  direction: "incoming" | "outgoing",
  depth: number,
): Promise<number> {
  try {
    const { file, line, col } = parseNavArgs(positional);
    const ws = workspaceRoot(flags);
    const onProgress = cliProgress();
    const handle = await ensureDaemon(ws, daemonOpts(flags), onProgress);
    await call(handle.socketPath, { m: "open", a: [file] }, onProgress);
    const res = await call(
      handle.socketPath,
      {
        m: direction === "incoming" ? "callersTree" : "calleesTree",
        a: [file, line - 1, col - 1, depth],
      },
      onProgress,
    );
    if (!res.ok) throw new Error(res.e ?? "daemon error");
    console.log(formatCallHierarchyTree(res.r, direction, fmtOpts(flags)));
    return 0;
  } catch (err) {
    console.error(`${c.red("error")}: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

async function runRename(
  flags: Record<string, boolean | string | number>,
  positional: string[],
): Promise<number> {
  if (positional.length < 4) {
    console.error(`${c.red("error")}: expected <file> <line> <col> <newname>`);
    return 1;
  }
  const apply = !!flags.apply;
  try {
    const file = positional[0];
    const line = Number(positional[1]);
    const col = Number(positional[2]);
    const newName = positional[3];
    const ws = workspaceRoot(flags);
    const onProgress = cliProgress();
    const handle = await ensureDaemon(ws, daemonOpts(flags), onProgress);
    // Cold-start warning: if THIS invocation spawned the daemon, the server
    // just initialized and its workspace index likely isn't built yet — a
    // rename computed now can silently miss cross-file usages. We don't
    // refuse (scripted use), but warn loudly before --apply writes to disk.
    if (apply && handle.spawned) {
      console.error(
        c.yellow("⚠ daemon just started") +
          c.dim(
            " — the server may not have finished indexing the workspace, so this\n" +
              "  rename could be incomplete. Verify with `lspx refs` first, or warm\n" +
              "  with `lspx open <other-files>` and re-run. Proceeding…",
          ),
      );
    }
    await call(handle.socketPath, { m: "open", a: [file] }, onProgress);
    const res = await call(
      handle.socketPath,
      { m: "rename", a: [file, line - 1, col - 1, newName] },
      onProgress,
    );
    if (!res.ok) throw new Error(res.e ?? "daemon error");
    const opts = fmtOpts(flags);
    // Dry-run: just print the plan. --apply: write edits to disk, then print
    // a compact summary (the plan is noisy once applied).
    if (apply) {
      const r = res.r as { edit: unknown };
      const result = applyWorkspaceEdit(r.edit, defaultIO);
      // Re-sync the server's in-memory text so a follow-up refs/rename on the
      // same daemon sees the post-edit content, not the pre-edit snapshot.
      // Best-effort: a failure here just means the next query might be stale
      // until the file is reopened — the disk write already succeeded.
      if (result.paths.length > 0) {
        try {
          await call(
            handle.socketPath,
            { m: "syncChanged", a: [result.paths] },
            () => {},
          );
        } catch {
          /* best-effort re-sync */
        }
      }
      if (result.edits === 0) {
        console.log(c.yellow("⚠ no text edits to apply") +
          (result.fileOps > 0 ? c.dim(` (${result.fileOps} file op(s) not applied)`) : ""));
      } else {
        console.log(
          `${c.green("✓ applied")} ${c.bold(newName)}: ` +
          `${result.edits} edit${result.edits === 1 ? "" : "s"} ` +
          `across ${result.files} file${result.files === 1 ? "" : "s"}` +
          (result.fileOps > 0
            ? c.dim(` (${result.fileOps} file op(s) not applied)`)
            : ""),
        );
      }
    } else {
      console.log(formatRename(res.r, opts));
      console.error(c.dim("  (dry-run — pass --apply to write to disk)"));
    }
    return 0;
  } catch (err) {
    console.error(`${c.red("error")}: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

async function runTypeHierarchy(
  flags: Record<string, boolean | string | number>,
  positional: string[],
  direction: "super" | "sub",
): Promise<number> {
  try {
    const { file, line, col } = parseNavArgs(positional);
    const ws = workspaceRoot(flags);
    const onProgress = cliProgress();
    const handle = await ensureDaemon(ws, daemonOpts(flags), onProgress);
    await call(handle.socketPath, { m: "open", a: [file] }, onProgress);
    const res = await call(
      handle.socketPath,
      { m: direction === "super" ? "supertypes" : "subtypes", a: [file, line - 1, col - 1] },
      onProgress,
    );
    if (!res.ok) throw new Error(res.e ?? "daemon error");
    console.log(formatTypeHierarchy(res.r, direction, fmtOpts(flags)));
    return 0;
  } catch (err) {
    console.error(`${c.red("error")}: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

async function runDiagnostics(
  flags: Record<string, boolean | string | number>,
  positional: string[],
): Promise<number> {
  if (!positional[0]) {
    console.error(`${c.red("error")}: expected <file>`);
    return 1;
  }
  try {
    const ws = workspaceRoot(flags);
    const file = positional[0];
    const onProgress = cliProgress();
    const handle = await ensureDaemon(ws, daemonOpts(flags), onProgress);
    const res = await call(handle.socketPath, { m: "diagnostics", a: [file] }, onProgress);
    if (!res.ok) throw new Error(res.e ?? "daemon error");
    console.log(formatDiagnostics(res.r, fmtOpts(flags)));
    return 0;
  } catch (err) {
    console.error(`${c.red("error")}: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

async function runOpen(
  flags: Record<string, boolean | string | number>,
  positional: string[],
): Promise<number> {
  if (!positional[0]) {
    console.error(`${c.red("error")}: expected <file>`);
    return 1;
  }
  try {
    const ws = workspaceRoot(flags);
    const file = positional[0];
    const onProgress = cliProgress();
    const handle = await ensureDaemon(ws, daemonOpts(flags), onProgress);
    const res = await call(handle.socketPath, { m: "open", a: [file] }, onProgress);
    if (!res.ok) throw new Error(res.e ?? "daemon error");
    const r = res.r as { uri?: string; languageId?: string };
    if (flags.json) {
      console.log(JSON.stringify({ file, languageId: r.languageId ?? "plaintext" }, null, 2));
    } else {
      console.log(`${c.green("✓")} opened ${c.cyan(file)} (${r.languageId ?? "plaintext"})`);
    }
    return 0;
  } catch (err) {
    console.error(`${c.red("error")}: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

async function runDocSymbols(
  flags: Record<string, boolean | string | number>,
  positional: string[],
): Promise<number> {
  if (!positional[0]) {
    console.error(`${c.red("error")}: expected <file>`);
    return 1;
  }
  try {
    const ws = workspaceRoot(flags);
    const file = positional[0];
    const onProgress = cliProgress();
    const handle = await ensureDaemon(ws, daemonOpts(flags), onProgress);
    await call(handle.socketPath, { m: "open", a: [file] }, onProgress);
    const res = await call(handle.socketPath, { m: "docSymbols", a: [file] }, onProgress);
    if (!res.ok) throw new Error(res.e ?? "daemon error");
    console.log(
      formatSymbols(res.r as never, fmtOpts(flags)),
    );
    return 0;
  } catch (err) {
    console.error(`${c.red("error")}: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

async function runWsSymbols(
  flags: Record<string, boolean | string | number>,
  positional: string[],
): Promise<number> {
  try {
    const ws = workspaceRoot(flags);
    const query = positional[0] ?? "";
    const onProgress = cliProgress();
    const handle = await ensureDaemon(ws, daemonOpts(flags), onProgress);
    const res = await call(handle.socketPath, { m: "wsSymbols", a: [query] }, onProgress);
    if (!res.ok) throw new Error(res.e ?? "daemon error");
    console.log(formatSymbols(res.r as never, fmtOpts(flags)));
    return 0;
  } catch (err) {
    console.error(`${c.red("error")}: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

async function runCodemap(
  flags: Record<string, boolean | string | number>,
  positional: string[],
): Promise<number> {
  try {
    const ws = workspaceRoot(flags);
    const scope = positional[0] ?? null;
    const noCalls = !!flags["no-calls"];
    const includeAll = !!flags["all"];
    const onProgress = cliProgress();
    const handle = await ensureDaemon(ws, daemonOpts(flags), onProgress);
    const res = await call(
      handle.socketPath,
      { m: "codemap", a: [scope, noCalls, includeAll] },
      onProgress,
    );
    if (!res.ok) throw new Error(res.e ?? "daemon error");
    console.log(formatCodemap(res.r, fmtOpts(flags)));
    return 0;
  } catch (err) {
    console.error(`${c.red("error")}: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

async function runDaemonCommand(
  flags: Record<string, boolean | string | number>,
  req: DaemonRequest,
  render: (r: unknown) => string,
): Promise<number> {
  try {
    const ws = workspaceRoot(flags);
    const onProgress = cliProgress();
    const handle = await ensureDaemon(ws, {}, onProgress);
    const res = await call(handle.socketPath, req, onProgress);
    if (!res.ok) throw new Error(res.e ?? "daemon error");
    console.log(render(res.r));
    return 0;
  } catch (err) {
    console.error(`${c.red("error")}: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

async function runClose(flags: Record<string, boolean | string | number>): Promise<number> {
  const ws = workspaceRoot(flags);
  const sock = socketForWorkspace(ws);
  try {
    const res = await call(sock, { m: "shutdown" });
    console.log(res.ok ? c.green("✓ daemon stopped") : c.red(`✘ ${res.e ?? "failed"}`));
    return res.ok ? 0 : 1;
  } catch (err) {
    console.error(`${c.red("error")}: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
