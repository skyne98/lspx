// ANSI color helpers. Respects NO_COLOR and CLICOLOR=0.
// Never hardcode ANSI codes elsewhere — route through this module.

let _enabled: boolean | null = null;

export function colorEnabled(): boolean {
  if (_enabled !== null) return _enabled;
  if (process.env.NO_COLOR) return (_enabled = false);
  if (process.env.CLICOLOR === "0") return (_enabled = false);
  if (!process.stdout.isTTY && process.env.CLICOLOR_FORCE !== "1") return (_enabled = false);
  return (_enabled = true);
}

/** Force-enable/disable colors (used by tests and --color flag). */
export function setColorEnabled(v: boolean): void {
  _enabled = v;
}

function wrap(open: string, close: string): (s: unknown) => string {
  return (s) => {
    const str = String(s);
    if (!colorEnabled()) return str;
    // Strip nested closing sequences so colors reset correctly mid-string.
    return `\x1b[${open}m${str.replace(new RegExp(`\\x1b\\[${close}m`, "g"), `\x1b[${open}m`)}\x1b[${close}m`;
  };
}

export const c = {
  reset: wrap("0", "0"),
  bold: wrap("1", "22"),
  dim: wrap("2", "22"),
  italic: wrap("3", "23"),
  underline: wrap("4", "24"),
  red: wrap("31", "39"),
  green: wrap("32", "39"),
  yellow: wrap("33", "39"),
  blue: wrap("34", "39"),
  magenta: wrap("35", "39"),
  cyan: wrap("36", "39"),
  gray: wrap("90", "39"),
  brightBlue: wrap("94", "39"),
};

// Semantic symbols used across lspx output (Unicode, not emoji).
export const sym = {
  ok: colorEnabled() ? "\u2713" : "+", // ✓
  fail: colorEnabled() ? "\u2717" : "x", // ✗
  arrow: colorEnabled() ? "\u2192" : "->", // →
  bull: colorEnabled() ? "\u00b7" : ".", // ·
  darrow: colorEnabled() ? "\u2193" : "v", // ↓
  uarrow: colorEnabled() ? "\u2191" : "^", // ↑
  diamond: colorEnabled() ? "\u25c6" : "*", // ◆
};
