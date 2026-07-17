# lspx

**LSP-powered code navigation CLI for AI agents.**

Symbol-to-symbol navigation via the Language Server Protocol. Every result
carries the source snippet, so an agent never round-trips a `read_file` just to
see what's at a location. Output is terse; waits are explicit. Progress goes to
stderr so stdout stays clean for piping and `--json`.

```
$ lspx defs src/main.go 6 7
user.go:8:6 → 8:13
  8 │ func NewUser(name string, age int) User {
           ^^^^^^^
```

## Why

Agents navigate code by jumping symbol-to-symbol: *find this function, see its
references, ctrl-click into what it calls*. lspx does exactly that, in one tool,
across ~50 languages, with the code included at every step.

- **One tool, whole workflow** — `ws-symbols` (find by name) → `refs` (find uses)
  → `defs` (ctrl-click) → `callers`/`callees` (control flow) → `rename` (refactor).
  `map` collapses that workflow into a single file-or-dir view: the symbol
  outline *plus* call edges, in one pass. Every span comes from the previous
  result; the agent's only a-priori input is a name.
- **Snippets by default** — each location ships its source line(s) + a `^`
  underline for the matched token. `--json` adds structured `snippet`/`match`.
- **Silent when fast, explicit when slow** — a 60ms warm query prints nothing but
  the result; a cold boot reports `lspx: initializing…` / `lspx: indexing…` on
  stderr so the LLM knows what it's waiting on. No spinners, no kill timers.
- **Persistent per-workspace daemon** — auto-spawns on first command, survives
  `&&` chains and repeated calls. One cold boot per workspace.
- **Helix-style `doctor`** — known vs installed language servers at a glance.

## Install

Requires [Bun](https://bun.sh) (`>=1.1.0`) and at least one language server on
`$PATH` (e.g. `rust-analyzer`, `gopls`, `pyright`, `clangd`, …).

```bash
bun install -g skyne98/lspx
```

### Pi package

The same repository ships a structured pi extension backed by the repository-local
lspx CLI, so a separate global lspx install is not required:

```bash
pi install git:github.com/skyne98/lspx
```

The extension registers one compact `lspx` tool covering navigation, symbols,
maps, diagnostics, health, and safe dry-run rename. Its typed parameters keep
file positions 1-indexed and avoid shell quoting. Future semantic replacement
and generic batch-edit tools are designed in
[`docs/semantic-agent-roadmap.md`](docs/semantic-agent-roadmap.md) and will ship
from this repository as part of the same pi package.

Then check what's wired up:

```bash
lspx doctor          # known vs installed servers
lspx doctor rust     # filter to one language
```

Language servers are provided by your system — install the ones you use
(`rustup component add rust-analyzer`, `go install golang.org/x/tools/gopls@latest`,
`pip install pyright`, `brew install llvm` for clangd, …). lspx finds them on
`$PATH` via the registry in `src/registry/languages.toml`.

## Quick start (the agent loop)

An agent wants to find a function, see where a variable is used, and jump into
the function that initialized it. Every span after the first is output of the
previous command:

```bash
# 1. Find a function by NAME → get its location + the declaration line.
lspx ws-symbols load_config
#   function load_config src/config.rs:12:8

# 2. Find its call sites (= where a var was init'd by it) → refs ON the def.
lspx refs src/config.rs 12 8
#   src/main.rs:4:21 → 4:26
#     4 │     let cfg = load_config("app.toml");
#                        ^^^^^^^^^^^^

# 3. "Ctrl-click" into the function at the call site → defs.
lspx defs src/main.rs 4 21
#   src/config.rs:12:8 → 15:2
#     12 │ pub fn load_config(path: &str) -> Config {
#     ...
#     15 │ }
```

Chain with `&&` — the daemon persists between commands, so only the first is
cold:

```bash
lspx defs src/main.rs 4 21 && lspx refs src/config.rs 12 8
```

## Commands

Positions are **1-indexed** (line:col), like editors. LSP resolves the symbol at
the exact column; for a local variable, use `rg --column -w <name>` to land on
the identifier (module-level items are found directly via `ws-symbols`).

### Navigation

```
lspx defs <f> <l> <c>        Find definitions.
lspx decl <f> <l> <c>        Find declarations.
lspx typedef <f> <l> <c>     Find type definitions.
lspx impl <f> <l> <c>        Find implementations.
lspx refs <f> <l> <c>        Find references.
lspx hover <f> <l> <c>       Show hover/docs at position.
```

#### Call hierarchy (`callers` / `callees`)

The control-flow dimension — "who calls this?" and "what does this call?" —
returned as call sites with the matched token underlined. Prefer `callers`
over `refs` when you want actual invocations (not imports / doc mentions /
trait refs).

```
lspx callers <f> <l> <c>     Who calls this function? (incoming)
lspx callees <f> <l> <c>     What does this function call? (outgoing)
```

Add `--depth N` to walk the chain multiple levels in one command, returning a
tree instead of a flat list — collapses the manual cascade ("trace how a
keypress reaches a widget") into a single call. The tree is deduplicated (a
function expanded once renders as a leaf marked ↻ elsewhere), so output stays
bounded on cyclic call graphs. Depth is capped at 10; `--depth 1` (default) is
the flat single-level output. `--no-snippet` drops the decl source lines for a
compact name+location tree.

```
$ lspx callers src/events.rs 63 15 --depth 3
function emit src/events.rs:63:12
  63 │     pub fn emit(&self, event: SmashEvent) {
├── ← function update src/window.rs:95:12
│     95 │ pub fn update(&mut self) -> Result<bool> {
│   ← @ src/window.rs:103:37 (+2)
│   ├── ← function run_cookbook src/cookbook.rs:1202:14
│   └── ← function main src/main.rs:24:10
└── ← function dispatcher_processes_all… src/tests.rs:49:8
```

#### Type hierarchy (`supertypes` / `subtypes`)

The inheritance dimension — "what does this class inherit from?" and "what
inherits from it?". Output marks direction with ↑ (inherits from) / ↓
(inherited by).

```
lspx supertypes <f> <l> <c>  What this type inherits from (up).
lspx subtypes <f> <l> <c>    What inherits from this type (down).
```

Note: type hierarchy support is sparse across servers. clangd supports it
fully; rust-analyzer, gopls, tsserver, and pyright do not (verified at the
source level — the handler code is absent or explicitly disabled). Unsupported
servers return `(no results)`; fall back to `defs`/`impl`.

### Refactor

```
lspx rename <f> <l> <c> <new>            Rename symbol across the workspace (dry-run plan).
lspx rename <f> <l> <c> <new> --apply    Write the edits to disk.

lspx source <f> <l> <c>                  Print the full declaration at a position.
lspx source --symbol <name> [--within <p>] [--container <c>]   Resolve by name.

lspx replace-symbol <f> <l> <c> --stdin            Replace a symbol's full range (dry-run).
lspx replace-symbol <f> <l> <c> --stdin --apply    Write + verify.
lspx replace-symbol --symbol <name> [--within <p>] --stdin --apply   Name-based.

lspx replace-symbols --plan <file> [--apply]          Batched whole-symbol replacement.
lspx batch-edit --plan <file> [--apply]                Batched exact oldText→newText edits.
# Omit --plan to read either JSON plan from stdin.
```

`source` returns a symbol's complete declaration (signature + body) plus a
content digest — it replaces the need to `read` a whole file just to inspect
one function. `replace-symbol` rewrites a symbol's entire server-resolved
range; `--symbol` resolves by name (workspace/symbol, never silently picking
the first ambiguous match). Both accept `--apply` to write, then re-sync the
server and **verify fresh diagnostics** (`--check` exits 2 on introduced
errors or non-fresh verification).

`replace-symbols` and `batch-edit` take a JSON plan (`[{...}]`) from `--plan`
or stdin and apply **one staleness-guarded transaction**: one stale, ambiguous,
or overlapping target aborts before any write; a write failure triggers
best-effort rollback of every touched file. These back the pi
`replace_symbols` / `batch_edit` tools.

Workspace rename via server-computed ranges (exact, not symbol-span guessing).
**Default is a dry-run**: prints the plan — each edit's location + source line
with the replaced token underlined + the new text. Pass `--apply` to write the
edits to disk (applied end-of-document-first so positions stay valid; existing
files only — file ops like create/rename/delete are reported but NOT
performed).

```
$ lspx rename src/events.rs 63 15 push_event
rename: emit → push_event  6 edits across 3 files
src/window.rs (3)
  103:37→103:41 → push_event
  103 │     self.dispatcher.emit(SmashEvent::Key(key));
                            ^^^^
...
  (dry-run — pass --apply to write to disk)
```

**Readiness matters** (same as `refs`): on a cold daemon, the server's
workspace index may not be built, so rename can return an incomplete edit set.
If `--apply` runs against a freshly-spawned daemon, lspx prints a
`⚠ daemon just started` warning and proceeds (it warns, doesn't refuse — so
scripted use isn't blocked). Warm first (`lspx open <files>` or a `refs`
query) for complete results.

After `--apply`, lspx re-syncs every touched file with the server via
`textDocument/didChange`, so a follow-up `refs`/`rename` on the same daemon
sees the post-edit text, not the pre-edit snapshot.

### Symbols

```
lspx symbols <f> [<f>…]               Document symbols (outline) for one or more files.
lspx ws-symbols <query>                Workspace symbol search (fuzzy, by name).
lspx map [path]                        Codemap: all symbols + call edges for a file,
                                        directory, or the whole workspace.
```

`symbols` accepts multiple paths (each routed to its own language server via
the client pool) and `map` is polyglot — it discovers files of every language
with an installed server and opens/maps each with the correct server.

`map` shows the full symbol outline (structs, enums, methods, fields, …)
for every source file in scope, with call edges annotated on callables:
callees (`→ name  signature  file:line`) nested one level under each
function/method, and a `called by:` block of callers (`← …`). Call edges are
filtered to workspace-local by default; pass `--all` to include calls into
dependencies and the stdlib. Call edges require server call-hierarchy support
(rust-analyzer, tsserver); other servers fall back to a symbol-only map.
Use `--no-calls` for a fast symbol-only pass that skips call-hierarchy
enrichment (useful on large workspaces). The first `map` on a cold daemon is
slow (~3–6s for one file) while the server builds its call-graph index;
subsequent symbols within the file are fast.

### Health

```
lspx diagnostics <f> [<f>…]     Live errors/warnings for one or more files (LSP push diagnostics).
```

Reports what the server pushes after analyzing a file — syntax errors, type
errors, warnings. Grouped by severity with a summary line and per-diagnostic
source snippets. Support varies by server: rust-analyzer pushes eagerly (syntax
errors return immediately, type errors on warm); tsserver/pyright need
additional configuration and may not push. A clean file reports `(no results)`.

### Pre-warm

```
lspx open <f>              Open a file in the server (triggers analysis)
                           so the next nav call is warm. Safe to repeat.
```

### Daemon / discovery

```
lspx daemon                Run the per-workspace daemon in the foreground.
lspx status                Show daemon + server capabilities.
lspx close [--all]         Stop the daemon (current workspace, or --all).
lspx doctor [lang]         Known vs installed language servers.
lspx version
lspx help
```

### Flags

```
--json                     Machine-readable output (raw, URI-normalized).
--workspace <dir>          Operate on a different workspace (default: $PWD).
--server <id>              Force a specific server id (see 'doctor').
--language <id>            Force a language id (overrides extension detection).
--color / --no-color       Force ANSI colors on/off.
--no-snippet               Omit source snippets (default: include them).
--depth N                  Multi-hop call hierarchy tree (callers/callees).
--apply                    Write rename edits to disk (rename; default: dry-run).
--no-calls                 Codemap: symbol-only map, skip call-hierarchy edges.
--all                      Codemap: include calls into deps/stdlib (default: workspace-local only).
```

## How it works

```
┌────────┐  unix socket  ┌─────────┐  stdio (jsonrpc)  ┌──────────┐
│ lspx   │ ───────────▶  │ daemon  │ ────────────────▶ │ LSP      │
│ (CLI)  │  ◀── progress │ (per    │                   │ server   │
│        │               │  ws)    │                   │ (gopls…) │
└────────┘               └─────────┘                   └──────────┘
```

- **Per-workspace daemon** on a Unix socket (`~/.local/share/lspx/runtime/`).
  The socket listens *before* the LSP boots, so a connecting client is streamed
  boot progress (`{progress:"…"}` JSON lines) until ready.
- **Auto-spawn**: the first command starts the daemon if it isn't running;
  subsequent commands connect to the same one. `lspx close` tears it down.
- **Transient errors retried**: `content modified` / `request cancelled` (the
  classic indexing race) are retried with backoff and reported — never a
  cryptic failure mid-cold-boot.
- **Workspace symbol index**: some servers (rust-analyzer) build the symbol
  index asynchronously; lspx retries empty results until non-empty, reporting
  `lspx: waiting for workspace index…`. Servers that don't support it (zls,
  marksman) return immediately — no false spin.

## Supported languages

~50 languages are wired in the registry (`src/registry/languages.toml`), mirroring
Helix's `languages.toml` schema. A server is "installed" when its binary resolves
on `$PATH` via `Bun.which`. Run `lspx doctor` to see yours.

| Language | Server(s) |
|---|---|
| rust | rust-analyzer |
| go | gopls |
| python | pyright, basedpyright, pylsp, ruff |
| c / c++ / cuda / objc | clangd |
| zig | zls |
| lua | lua-language-server |
| bash | bash-language-server |
| nix | nil, nixd |
| markdown | marksman |
| glsl | glsl_analyzer, glslls |
| yaml / json / toml / css / html | vscode-langservers-extracted, taplo |
| typescript / javascript | typescript-language-server, vtsls |
| …and ~30 more (ruby, php, java, kotlin, scala, elixir, erlang, haskell, dart, swift, ocaml, r, terraform, docker, graphql, vue, svelte, astro, typst, julia, f-sharp, c-sharp, powershell, awk) | |

## Semantic agent roadmap

The multi-server architecture, transactional semantic editing, pi extension,
and strict LLM-oriented CLI/output contract are specified in
[`docs/semantic-agent-roadmap.md`](docs/semantic-agent-roadmap.md).

## License

Apache-2.0.
