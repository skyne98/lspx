// Loads + exposes the curated language-server registry.
// Schema mirrors Helix's languages.toml; parsed with the mature `smol-toml`.

import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { readFileSync } from "node:fs";
import { parse } from "smol-toml";

const HERE = dirname(fileURLToPath(import.meta.url));

export interface ServerDef {
  command: string;
  args?: string[];
  install?: string;
  config?: unknown;
}

export interface LanguageDef {
  name: string;
  "file-types"?: (string | { glob: string })[];
  roots?: string[];
  "language-servers"?: string[];
}

export interface Registry {
  "language-server": Record<string, ServerDef>;
  language: LanguageDef[];
}

let _registry: Registry | null = null;

export function registryPath(): string {
  return join(HERE, "languages.toml");
}

export function loadRegistry(): Registry {
  if (_registry) return _registry;
  const text = require_text(registryPath());
  const parsed = parse(text) as unknown as Registry;
  _registry = {
    "language-server": parsed["language-server"] ?? {},
    language: parsed.language ?? [],
  };
  return _registry;
}

/** Allow tests/fixtures to inject a registry without touching disk. */
export function setRegistry(r: Registry): void {
  _registry = r;
}

/** Read a file as UTF-8 text (node:fs, sync — registry loads at startup). */
function require_text(path: string): string {
  return readFileSync(path, "utf-8");
}

export function servers(): Record<string, ServerDef> {
  return loadRegistry()["language-server"];
}

export function languages(): LanguageDef[] {
  return loadRegistry().language;
}

export function getServer(id: string): ServerDef | undefined {
  return servers()[id];
}

export function getLanguage(name: string): LanguageDef | undefined {
  return languages().find((l) => l.name === name);
}

/** Resolve a language's full server definitions (in priority order). */
export function languageServers(lang: LanguageDef): ServerDef[] {
  const ids = lang["language-servers"] ?? [];
  return ids
    .map((id) => getServer(id))
    .filter((s): s is ServerDef => Boolean(s));
}

/** Helix-style `which`: is the server's binary on PATH? */
export function whichServer(s: ServerDef): string | null {
  return Bun.which(s.command);
}

export interface ServerStatus {
  id: string;
  server: ServerDef;
  path: string | null; // null => not found in $PATH
}

/** Per-server installed/not status for a language (Helix `--health <lang>` style). */
export function languageServerStatus(lang: LanguageDef): ServerStatus[] {
  const ids = lang["language-servers"] ?? [];
  return ids.map((id) => {
    const server = getServer(id);
    if (!server) return { id, server: { command: id }, path: null };
    return { id, server, path: whichServer(server) };
  });
}

/** Flat summary across the whole registry (for the table view). */
export function allLanguageStatus(): { lang: LanguageDef; servers: ServerStatus[] }[] {
  return languages()
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((lang) => ({ lang, servers: languageServerStatus(lang) }));
}

/** Count of installed vs total servers (for the summary line). */
export function installedCount(): { installed: number; total: number } {
  const seen = new Map<string, boolean>();
  for (const s of Object.values(servers())) {
    const key = s.command;
    if (!seen.has(key)) seen.set(key, Boolean(whichServer(s)));
  }
  let installed = 0;
  for (const v of seen.values()) if (v) installed++;
  return { installed, total: seen.size };
}
