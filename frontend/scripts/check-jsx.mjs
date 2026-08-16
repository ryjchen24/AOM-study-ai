/**
 * Syntax-check every .jsx file in public/.
 *
 * Why this exists: these files are NOT compiled at build time. index.html loads
 * them as <script type="text/babel"> and @babel/standalone transpiles them in
 * the browser, and `vite build` only copies public/ into dist/ verbatim. So a
 * stray syntax error passes the build, deploys, and only surfaces as a blank
 * page for a real user. This parses each file with the same Babel version the
 * browser runs, which is the closest thing this frontend has to a compiler.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { parse } from "@babel/parser";

const FRONTEND_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const SOURCE_DIR = join(FRONTEND_DIR, "public");

const files = readdirSync(SOURCE_DIR).filter((f) => f.endsWith(".jsx")).sort();

if (files.length === 0) {
  console.error(`No .jsx files found in ${SOURCE_DIR} — did the layout change?`);
  process.exit(1);
}

let failed = 0;

for (const file of files) {
  const path = join(SOURCE_DIR, file);
  try {
    // Matches how @babel/standalone is invoked from a <script type="text/babel">
    // tag: script goals (no ESM), JSX enabled.
    parse(readFileSync(path, "utf8"), {
      sourceType: "script",
      plugins: ["jsx"],
      errorRecovery: false,
    });
    console.log(`  ok  ${relative(FRONTEND_DIR, path)}`);
  } catch (err) {
    failed += 1;
    const where = err.loc ? `${err.loc.line}:${err.loc.column}` : "?";
    console.error(`FAIL  ${relative(FRONTEND_DIR, path)}:${where}  ${err.message}`);
  }
}

console.log(`\n${files.length - failed}/${files.length} files parsed cleanly.`);
process.exit(failed > 0 ? 1 : 0);
