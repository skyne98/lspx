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
  → `defs` (ctrl-click). Every span comes from the previous result; the agent's
  only a-priori input is a name.
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
bun install -g lspx
```

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
lspx defs <f> <l> <c>      Find definitions.
lspx decl <f> <l> <c>      Find declarations.
lspx typedef <f> <l> <c>   Find type definitions.
lspx impl <f> <l> <c>      Find implementations.
lspx refs <f> <l> <c>      Find references.
lspx hover <f> <l> <c>     Show hover/docs at position.
```

### Symbols

```
lspx symbols <f>           Document symbols (outline) for a file.
lspx ws-symbols <query>    Workspace symbol search (fuzzy, by name).
```

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

## License

Apache-2.0.
