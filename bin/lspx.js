#!/usr/bin/env bun
// lspx — LSP-powered code navigation CLI for AI agents.
// Thin entry: hand off to the Bun TypeScript implementation.
import { main } from "../src/main.ts";

main(process.argv.slice(2)).catch((err) => {
  console.error(err?.stack || String(err));
  process.exit(1);
});
