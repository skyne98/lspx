// `lspx doctor` — Helix `--health`-style page showing known vs installed LSPs.
// Mirrors Helix's rendering: a padded table with one row per language,
// each language server rendered as "✓ <name>" (green) or "✘ <name>" (red);
// subsequent servers for the same language wrap onto indented lines.
//
// Faithful to helix-term/src/health.rs::health_all(). Colors respect NO_COLOR
// and non-TTY via src/color.ts; the table layout is always rendered.

import { c, colorEnabled } from "./color.ts";
import {
  allLanguageStatus,
  getLanguage,
  installedCount,
  languageServerStatus,
  registryPath,
} from "./registry/index.ts";
import { LSPX_DIR } from "./paths.ts";

const VERSION = "0.1.0";

function termWidth(): number {
  const w = process.stdout.columns;
  return typeof w === "number" && w >= 40 ? w : 80;
}

/** Fit a string into a fixed column width, truncating with "…" like Helix. */
function fit(s: string, width: number): string {
  if (s.length <= width) return s.padEnd(width);
  return s.slice(0, Math.max(0, width - 1)) + "…";
}

function statusGlyph(found: boolean): string {
  return found ? "✓" : "✘";
}

function renderServerCell(
  servers: { id: string; path: string | null }[],
  width: number,
): string {
  if (servers.length === 0) {
    return c.yellow(fit("None", width));
  }
  const lines = servers.map(({ id, path }) => {
    const glyph = statusGlyph(Boolean(path));
    const label = `${glyph} ${id}`;
    return Boolean(path) ? c.green(fit(label, width)) : c.red(fit(label, width));
  });
  return lines.join("\n");
}

/** Full table: every language in the registry. */
export function renderDoctorTable(): string {
  const width = termWidth();
  const langCol = Math.min(16, Math.max(8, Math.floor(width * 0.22)));
  const serverCol = width - langCol - 1;

  const rows = allLanguageStatus().map(({ lang, servers }) => ({
    lang: lang.name,
    servers: servers.map((s) => ({ id: s.id, path: s.path })),
  }));

  const header =
    c.bold(fit("Language", langCol)) + " " + c.bold(fit("Language servers", serverCol));
  const sep = "─".repeat(langCol) + " " + "─".repeat(serverCol);

  const out: string[] = [header, sep];
  for (const r of rows) {
    const langCell = fit(r.lang, langCol);
    const cell = renderServerCell(r.servers, serverCol);
    const cellLines = cell.split("\n");
    out.push(`${langCell} ${cellLines[0]}`);
    const indent = " ".repeat(langCol + 1);
    for (const line of cellLines.slice(1)) out.push(`${indent}${line}`);
  }
  return out.join("\n");
}

/** Per-language detail: Helix `--health <lang>` style. */
export function renderLanguageDetail(name: string): string {
  const lang = getLanguage(name);
  if (!lang) {
    return c.red(`Language '${name}' not found in registry.`);
  }
  const statuses = languageServerStatus(lang);
  const out: string[] = [];
  out.push(c.bold(`Configured language servers for '${c.cyan(name)}':`));
  if (statuses.length === 0) {
    out.push(c.yellow("  None configured."));
    return out.join("\n");
  }
  for (const s of statuses) {
    const glyph = statusGlyph(Boolean(s.path));
    const head = `  ${glyph} ${c.bold(s.id)}`;
    const cmd = s.server.args?.length
      ? [s.server.command, ...s.server.args].join(" ")
      : s.server.command;
    const tail = s.path
      ? c.dim(` -> ${s.path}`)
      : c.dim(` (${cmd})`) + (s.server.install ? c.dim(`  install: ${s.server.install}`) : "");
    out.push(Boolean(s.path) ? c.green(head) + tail : c.red(head) + tail);
  }
  return out.join("\n");
}

/** Top-of-page banner: Helix prints config/log/runtime paths. */
export function renderHeader(): string {
  const { installed, total } = installedCount();
  const colorOn = colorEnabled();
  const title = colorOn ? c.bold(c.magenta(`lspx ${VERSION}`)) : `lspx ${VERSION}`;
  const sub = c.dim("| language-server health");
  return [
    `${title} ${sub}`,
    c.dim(`Registry: ${registryPath()}`),
    c.dim(`Runtime:  ${LSPX_DIR}`),
    c.dim(`Servers installed: ${installed}/${total}   (PATH lookup via Bun.which)`),
    "",
  ].join("\n");
}

export function renderDoctor(arg?: string): string {
  if (arg && arg !== "all" && arg !== "all-languages") {
    return renderHeader() + "\n" + renderLanguageDetail(arg);
  }
  return renderHeader() + renderDoctorTable();
}
