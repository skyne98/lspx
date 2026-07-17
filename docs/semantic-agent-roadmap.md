# Semantic agent roadmap

Status: design proposal. This document is normative for new CLI surface and output behavior.

## Goal

Make lspx a stronger semantic code interface for AI agents than Dirac's AST toolset without turning lspx into a general coding-agent monolith.

Dirac exposes seven relevant capabilities:

1. Multi-file file skeletons with call information.
2. Full function extraction by name.
3. Definition/reference lookup by name and path.
4. Workspace symbol rename.
5. Batched whole-symbol replacement.
6. Batched arbitrary multi-file editing.
7. Multi-file syntax/lint diagnostics.

lspx already exceeds Dirac at semantic navigation: it uses language servers rather than a standalone parser, includes source snippets, supports definitions, references, implementations, call/type hierarchy, dry-run workspace rename, call-enriched maps, and type-aware diagnostics.

The remaining work is not "copy every Dirac command." The intended separation is:

- **lspx:** semantic queries and server-computed refactoring.
- **dbgx:** runtime inspection and behavioral verification.
- **pi extension:** generic batched text edits and workflow orchestration.

This separation keeps each tool narrow while the combined agent workflow exceeds Dirac in navigation, context quality, editing precision, static verification, and runtime verification.

## Repository and package layout

The pi extension is part of this repository and ships with lspx as one installable pi package. It must not be maintained as a separate dotfile or repository.

```text
lspx/
├── bin/lspx.js                         # CLI entry
├── src/                                # daemon, LSP clients, semantic core
├── extensions/lspx.ts                  # shipping pi extension entry
├── docs/semantic-agent-roadmap.md
└── package.json                        # CLI bin + pi.extensions manifest
```

Installation from Git must make both layers available:

```text
pi install git:github.com/skyne98/lspx
```

Package requirements:

- `package.json` declares `pi.extensions: ["./extensions/lspx.ts"]` and the `pi-package` keyword.
- The extension invokes the repository-local lspx implementation; it must not require a separately installed global `lspx` binary.
- The initial extension exposes the current navigation/symbol/map/diagnostic/rename surface as one typed `lspx` tool.
- As the roadmap lands, the same extension gains `replace_symbols` and `batch_edit`; no second package is introduced.
- CLI and extension call a shared normalized API/daemon protocol. The mature extension must not parse human CLI output. The initial CLI-backed adapter is temporary until that public client API exists.
- Extension tool schemas use exact operation enums, 1-indexed positions, explicit dry-run/apply fields, and descriptions optimized for native tool calling (including Google-compatible string enums).
- Installing the repository as a normal Bun CLI remains supported and does not require pi.

## Design principles

1. **Semantic operations belong in lspx.** Symbol resolution, symbol source, rename, code actions, formatting, and diagnostics are LSP concerns.
2. **Generic text editing does not.** Arbitrary `oldText -> newText` batching belongs in the pi extension. lspx may apply a `WorkspaceEdit`, but it should not become another generic editor CLI.
3. **Position is canonical; names are conveniences.** A file position is unambiguous. Name lookup must return exactly one result or fail with useful candidates.
4. **Mutations are plans first.** Every mutating command is a dry-run unless `--apply` is present.
5. **Never apply stale locations.** Every planned edit carries an expected document version or content digest and expected source text.
6. **One transaction path.** Rename, symbol replacement, code actions, and formatting use the same validated workspace-edit transaction engine.
7. **Verification reports freshness.** A diagnostic result is not called verified unless it corresponds to the post-edit document version.
8. **Optimize for agent tokens and decisions.** Output carries the source or fact needed for the next decision, but does not repeat input or emit decorative prose.
9. **No silent ambiguity, truncation, or partial success.** Each is explicit in text and JSON.
10. **Human and JSON output describe the same public model.** Public positions are always 1-indexed; raw LSP coordinates stay internal.

## Current architectural blocker: one server per workspace

The daemon currently owns one client:

```ts
private client: LspClient | null = null;
```

A polyglot workspace can therefore start one server and subsequently open unrelated languages through it. Semantic multi-file operations cannot be correct across TypeScript, Python, Rust, C++, and configuration files until this changes.

### Replace it with a lazy client pool

```ts
class LspClientPool {
  private clients: Map<ServerId, ClientState>;

  forFile(path: string): Promise<LspClient>;
  forLanguage(languageId: string): Promise<LspClient>;
  active(): LspClient[];
  closeAll(): Promise<void>;
}
```

Requirements:

- Resolve a file to language and server through the existing registry.
- Lazily start only servers needed by queried/opened files.
- Reuse one client when a server handles multiple related languages.
- Group multi-file diagnostics and refactors by server.
- Fan out workspace-symbol queries only to relevant active or discovered project languages, then merge and deduplicate results.
- Preserve `--server` and `--language` as explicit single-server overrides.
- Make `status` show every client, language set, capabilities, readiness, and open-document count.
- Make `close` stop all workspace clients.
- Keep progress per server concise: `lspx: starting pyright…`, not generic repeated initialization messages.

This is Phase 0. No cross-language batching should be advertised before it lands.

## Core internal types

### Canonical symbol target

All symbol-oriented commands share one resolver.

```ts
type SymbolTarget =
  | { path: string; line: number; column: number }
  | {
      symbol: string;
      within?: string;
      container?: string;
      kind?: SymbolKind;
    };
```

Resolution rules:

1. Position target: select the deepest `DocumentSymbol.range` containing the position.
2. Name target: query `workspace/symbol`, filter by `within`, `container`, and `kind`, then confirm against `documentSymbol`.
3. Handle both hierarchical `DocumentSymbol[]` and flat `SymbolInformation[]` server responses.
4. If zero candidates remain, return `symbol-not-found`.
5. If more than one candidate remains, return `ambiguous-symbol` and all compact candidates. Never choose the first silently.
6. Resolve `WorkspaceSymbol` lazily when the server supports `workspaceSymbol/resolve`.

```ts
interface ResolvedSymbol {
  path: string;
  name: string;
  container?: string;
  kind: SymbolKind;
  range: PublicRange;
  selectionRange: PublicRange;
  documentVersion?: number;
  expectedText: string;
  contentHash: string;
  serverId: string;
}
```

The content precondition prevents a range emitted before another edit from targeting unrelated text later.

### Workspace-edit transaction

Generalize `src/edit.ts` from a direct writer into the only mutation path:

```ts
WorkspaceEditTransaction
  .normalize()
  .validatePreconditions()
  .rejectOverlaps()
  .stage()
  .renderPlan()
  .applyWithRollback()
  .syncServers()
  .verifyDiagnostics();
```

It must:

- Normalize `WorkspaceEdit.changes` and `documentChanges`.
- Validate expected text, document versions, and content hashes before any write.
- Reject overlapping edits, duplicate targets, paths outside the workspace, and unsupported resource operations.
- Resolve UTF-16 LSP positions correctly.
- Build all resulting file contents in memory first.
- Stage writes and restore originals if any write fails.
- Preserve existing file permissions.
- Apply per-file edits end-of-document-first.
- Re-sync every touched document with the correct language-server client.
- Return touched paths, edit counts, resource operations, before/after hashes, and diagnostic verification status.
- Keep create/rename/delete resource operations unsupported until they can be planned, confirmed, and rolled back safely. Never merely count and ignore them during an apply.

## CLI additions

### `source`: complete declaration source

```text
lspx source <file> <line> <column>
lspx source --symbol <exact-name> [--within <path>] [--container <name>] [--kind <kind>]
```

This replaces Dirac's `get_function` while covering classes, methods, functions, types, and other document symbols.

Behavior:

- Return the complete declaration represented by `DocumentSymbol.range`.
- Include a compact symbol header followed by source with line numbers.
- Do not call it `body`: the returned range may include signature, body, decorators, attributes, or comments.
- Test metadata ownership by server. Some servers include doc comments/decorators in the symbol range and some do not. Report `metadataIncluded` in JSON rather than claiming uniform behavior.
- Allow multiple semantic targets through the pi tool schema; keep the human CLI focused on one target per invocation.

Text output:

```text
function parseConfig  src/config.ts:12:1→31:2
 12 │ export function parseConfig(path: string): Config {
    …
 31 │ }
```

JSON output:

```json
{
  "symbol": {
    "name": "parseConfig",
    "kind": "function",
    "path": "src/config.ts",
    "range": {
      "start": { "line": 12, "column": 1 },
      "end": { "line": 31, "column": 2 }
    },
    "container": null,
    "metadataIncluded": "server-dependent"
  },
  "source": "export function parseConfig…"
}
```

### `replace-symbol`: semantic whole-symbol replacement

```text
lspx replace-symbol <file> <line> <column> --stdin
lspx replace-symbol --symbol <name> [--within <path>] [--container <name>] --stdin
lspx replace-symbol … --stdin --apply
```

Behavior:

- Replacement text is read from stdin. Do not put large source strings in positional CLI arguments.
- Resolve the symbol at execution time and replace exactly its full semantic range.
- Dry-run by default.
- `--apply` runs through `WorkspaceEditTransaction`.
- Verification runs by default after apply when diagnostics are supported; `--no-verify` opts out.
- `--check` makes introduced errors, stale verification, unsupported verification, or verification timeout return exit code 2.
- `--format` applies server range formatting before verification when supported.
- Do not echo the submitted replacement text back to the model. The caller already has it.

Default dry-run output is compact:

```text
replace function parseConfig  src/config.ts:12:1→31:2
 20 lines → 17 lines
 dry-run; pass --apply
```

`--diff` may print a unified diff for human review. It is not the default because it repeats both old and newly supplied source into the model context.

Applied output:

```text
✓ replaced function parseConfig  src/config.ts:12:1  20→17 lines
verify: fresh  0 introduced errors, 2 existing, 1 resolved
```

### Extend `symbols`, do not add `skeleton`

```text
lspx symbols <file> [<file-or-directory>…]
lspx symbols src/a.ts src/b.ts
```

- Accept multiple files/directories.
- Keep `map` as the call-enriched view.
- Add `--ranges` only if ranges are not already visible in the chosen format.
- Do not add `skeleton` as a synonym; `symbols` is the precise LSP term and avoids overlapping concepts.

### Extend `diagnostics` to multiple paths

```text
lspx diagnostics <file-or-directory> [<file-or-directory>…]
```

- Route files through the client pool.
- Deduplicate server diagnostics.
- Prefer `textDocument/diagnostic` pull diagnostics when advertised.
- Otherwise wait for a `publishDiagnostics` event with a matching/newer document version.
- Report freshness as `fresh`, `stale`, `timed-out`, or `unsupported`.
- For mutation verification, compare before/after sets and report introduced, resolved, and pre-existing diagnostics. Do not implement a persistent `--since-checkpoint` state machine.

### `context`: bounded semantic context pack

Add after the foundational work:

```text
lspx context <file> <line> <column> [--depth N] [--budget N]
lspx context --symbol <name> [--within <path>] [--depth N] [--budget N]
```

It should produce, in priority order:

1. Target declaration source.
2. Containing type/module signature.
3. Direct workspace-local caller and callee signatures.
4. Referenced workspace type definitions and implementations.
5. Relevant diagnostics.
6. Deeper call/type edges while budget remains.

Requirements:

- Deduplicate by canonical symbol location.
- Rank same-file and direct edges before remote/deeper edges.
- Enforce the requested character/token budget.
- Never truncate silently; state exactly how many candidates were omitted and how to request more.
- `--json` reports included/omitted sections and budget usage.

This is the direct answer to Dirac's "high-bandwidth context" claim: one bounded semantic query rather than repeated symbol/read calls.

### Native LSP refactor commands

After the transaction engine is stable:

- `code-actions <file> <line> <column>` lists server code actions tersely.
- `code-actions … --select <exact-kind-or-index> --apply` applies one action through the transaction engine.
- `format <file>` and `format <file> --range <start>-<end>` use server formatting.

These are genuine LSP features and provide stronger structural refactoring than manually generating whole replacement declarations.

## Pi extension surface

The pi extension gives the model structured batching without bloating the human CLI.

### `replace_symbols`

```ts
{
  replacements: [
    {
      target: {
        path?: string,
        line?: number,
        column?: number,
        symbol?: string,
        within?: string,
        container?: string,
        kind?: string
      },
      text: string
    }
  ],
  apply: boolean,
  verify?: boolean,
  format?: boolean
}
```

The extension resolves all symbols, creates one transaction, validates every precondition, and applies none if any target is stale or ambiguous.

### `batch_edit`

```ts
{
  files: [
    {
      path: string,
      edits: [{ oldText: string, newText: string }]
    }
  ],
  apply: boolean,
  verifyWithLspx?: boolean
}
```

This is the Dirac-style arbitrary multi-file batching capability. It belongs in pi because it is exact text editing, not an LSP operation.

Workflow:

1. Resolve and validate every exact match.
2. Reject duplicates and overlaps.
3. Stage all file contents before writing.
4. Apply transactionally with rollback.
5. Ask lspx to re-sync touched documents.
6. Request fresh multi-server diagnostics.
7. Optionally run repository-specific lint/tests through pi's `bash` tool.

## CLI option contract

The option surface should stay small, consistent, and orthogonal.

### Global options

```text
--json                     One stable JSON value on stdout.
--workspace <dir>          Workspace root (default: current directory).
--server <id>              Force one server instead of automatic routing.
--language <id>            Override language detection.
--color / --no-color       Force color behavior.
--no-snippet               Omit snippets where a command normally includes them.
--limit N                  Maximum returned matches; explicit omission summary.
```

### Symbol target options

All commands accepting semantic targets use the same names:

```text
<file> <line> <column>      Canonical position target.
--symbol <exact-name>       Exact symbol name target.
--within <path>             Restrict name resolution to a file/directory.
--container <name>          Restrict to a containing symbol/module.
--kind <kind>               Restrict symbol kind.
```

Rules:

- Position and `--symbol` modes are mutually exclusive.
- `--within`, `--container`, and `--kind` are invalid without `--symbol`.
- Never overload `--name`: rename already needs a destination name. `--symbol` is explicit.
- Ambiguous symbol lookup is an error with candidate locations and a corrective hint.

### Mutation options

```text
--apply                    Apply; otherwise dry-run.
--verify / --no-verify     Verify fresh diagnostics after apply (default: verify).
--check                    Exit 2 unless verification is fresh and introduces no errors.
--format                   Ask the server to format the changed range/files.
--diff                     Include unified diff in dry-run output.
--stdin                    Read replacement source from stdin.
```

Do not add command-specific synonyms for these behaviors.

## Output contract for LLM callers

### Streams

- **stdout:** command result only.
- **stderr:** progress, warnings, hints, and errors only.
- Fast warm commands print no progress.
- Progress appears only when useful, e.g. `lspx: starting rust-analyzer…` or `lspx: indexing…`.
- `--json` emits exactly one JSON value to stdout. Never mix progress JSONL into stdout.

### Paths and positions

- Prefer workspace-relative forward-slash paths.
- Use absolute paths only for results outside the workspace and mark them as external in JSON.
- Human and JSON line/column numbers are always **1-indexed**.
- Public JSON uses `column`, not raw LSP's `character`.
- Ranges are half-open and documented once in `lspx help output`.
- Do not expose `file://` URIs in normal public output.

### Text output

- Use one compact identity line per result: `kind name  path:start→end`.
- Include the minimum source snippet needed to understand the result.
- Keep current line-number + underline rendering.
- Stable sort: workspace-local first, then path, line, column, kind, name.
- Deduplicate identical locations before rendering.
- Do not print generic headings such as `Results:` or explanatory paragraphs.
- Do not repeat command input, replacement source, or large unchanged code.
- Summaries state actionable counts: `6 references across 3 files`, not `Operation completed successfully`.

### Empty and truncated results

Successful empty query:

```text
(no results)
```

This exits 0 because the query succeeded.

Truncation is always explicit:

```text
… 37 more (use --limit 50)
```

JSON includes:

```json
{ "results": [], "truncated": true, "omitted": 37 }
```

### Errors and ambiguity

Text errors use a stable code:

```text
error[ambiguous-symbol]: 'parseConfig' matched 2 symbols
  1 function parseConfig         src/a.ts:12:8
  2 method   Config.parseConfig  src/b.ts:44:3
hint: add --within, --container, or use file line column
```

JSON errors use:

```json
{
  "error": {
    "code": "ambiguous-symbol",
    "message": "'parseConfig' matched 2 symbols",
    "candidates": []
  }
}
```

Required error codes include:

- `invalid-arguments`
- `unsupported`
- `server-unavailable`
- `server-not-ready`
- `symbol-not-found`
- `ambiguous-symbol`
- `stale-target`
- `overlapping-edits`
- `apply-failed`
- `verification-timeout`
- `verification-failed`

### JSON success shape

Use command-specific, terse objects rather than a verbose generic envelope. Do not repeat command name, workspace, or `ok: true` unless needed to disambiguate data.

Normalize all public fields:

- `path`, never URI.
- `line`/`column`, always 1-indexed.
- Symbol kinds as lowercase strings, not numeric LSP enum values.
- Stable arrays and stable key meanings.
- `null` only when semantically distinct from omission.

Raw wire LSP structures stay internal; do not make them the public `--json` API.

### Verification output

A mutation must distinguish edit success from verification success:

```text
✓ replaced function parseConfig  src/config.ts:12:1  20→17 lines
verify: fresh  0 introduced errors, 2 existing, 1 resolved
```

Timeout/unsupported verification is explicit:

```text
warning[verification-timeout]: edits applied; no fresh diagnostics within 3s
```

Existing diagnostics do not fail `--check`; newly introduced errors do. A stale, timed-out, or unsupported verification does fail `--check` because correctness was not established.

### Exit codes

- `0`: request completed; query may have zero results; apply succeeded and `--check` passed or was not requested.
- `1`: invalid invocation, resolution/transport failure, stale target, unsafe/failed apply.
- `2`: `--check` failed due to introduced errors or incomplete verification.

## Phased implementation

### Phase 0: package and multi-server foundation

- Keep `extensions/lspx.ts` functional and installable from the repository throughout the refactor.
- Extract a stable normalized client API so the extension can stop shelling out to/parsing the CLI while preserving one semantic implementation.
- Introduce `LspClientPool` in the daemon.
- Route file commands by registry language/server.
- Merge workspace queries across relevant clients.
- Update status, close, progress, and tests.

### Phase 1: shared semantic target resolver

- Normalize hierarchical and flat document symbols.
- Implement position and exact-name resolution.
- Add ambiguity candidates and stable public symbol/range types.
- Add content/version preconditions.

### Phase 2: transaction engine

- Refactor `src/edit.ts` around staged validation, overlap rejection, rollback, re-sync, and result metadata.
- Move existing rename application onto it without changing CLI behavior.
- Add comprehensive UTF-16, overlap, stale-content, rollback, and multi-file tests.

### Phase 3: `source`

- Add command dispatch and daemon method.
- Reuse the target resolver.
- Generalize snippet/range extraction for full declarations.
- Test nested symbols, flat symbol servers, decorators/doc comments, Unicode, and ambiguous names.

### Phase 4: `replace-symbol`

- Read replacement from stdin.
- Dry-run by default; apply through the transaction engine.
- Re-sync the correct client(s).
- Add compact plan/apply output and stable JSON.

### Phase 5: fresh diagnostics and verify-on-apply

- Add pull diagnostics where supported.
- Correlate push diagnostics with synced document versions.
- Report introduced/resolved/pre-existing sets.
- Add `--verify`, `--no-verify`, and `--check` consistently to mutations.

### Phase 6: multi-path symbols/diagnostics and pi batching

- Extend `symbols` and `diagnostics` without adding aliases.
- Add `replace_symbols` and `batch_edit` to `extensions/lspx.ts` in this repository.
- Route extension calls through the normalized client API/daemon protocol, not human-output parsing.
- Ensure one failed/stale target prevents the entire batch.
- Test installation with `pi -e .` and `pi install git:github.com/skyne98/lspx`.

### Phase 7: bounded `context`

- Compose source, containment, call/type edges, and diagnostics.
- Implement deterministic ranking, deduplication, budgeting, and omission reporting.

### Phase 8: code actions and formatting

- Add client capabilities and commands.
- Apply all returned edits through the same transaction engine.

## Acceptance criteria

### Correctness

- No mutation applies when any precondition is stale or ambiguous.
- No overlapping edit is accepted silently.
- All apply commands are dry-run by default.
- Multi-file failure rolls back previously written files.
- Post-edit LSP state matches disk for every touched language server.
- Verification never labels stale diagnostics as fresh.

### CLI quality

- Every command follows the option and output contract above.
- Warm success output contains no progress or decorative prose.
- JSON is one value, stable, relative-path, 1-indexed, and free of raw LSP enums/URIs.
- Empty, ambiguous, truncated, stale, unsupported, and partial states are explicit.
- Large user-supplied replacement text is not echoed by default.

### Capability parity

- Dirac's skeleton, function extraction, references, rename, replace-symbol, batch-edit, and diagnostics workflows all have an equal or stronger lspx+pi workflow.
- Polyglot repositories route each semantic operation to the correct server.
- dbgx supplies runtime verification that Dirac lacks.

### Evaluation

Run identical models and prompts against:

1. pi baseline.
2. pi + current lspx/dbgx.
3. pi + roadmap implementation.
4. Dirac where reproducible.

Record:

- Task success and introduced diagnostics.
- Input/output tokens.
- Tool-call count and model roundtrips.
- Cold/warm wall time.
- Bytes returned by each tool.
- Ambiguous/stale edit rejection rate.
- Verification freshness and timeout rate.

Use Dirac's eight published refactoring tasks as one regression set, but add debugging, greenfield, polyglot, ambiguous-symbol, stale-edit, and runtime-behavior tasks so the evaluation is not biased toward one editing mechanism.

## Explicit non-goals

- Reimplementing a parser or tree-sitter fallback inside lspx.
- Copying Dirac's hash-word anchor protocol.
- Turning lspx into a shell, test runner, browser, or autonomous agent.
- Hiding ambiguous symbols by choosing a likely candidate.
- Claiming atomic filesystem semantics before rollback and resource-operation handling are implemented.
- Treating unsupported or timed-out diagnostics as successful verification.
