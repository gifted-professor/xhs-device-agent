import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { CAPABILITIES, summarizeCapabilities } from "./lib/xiaowei-capabilities.mjs";

const MAX_TEXT_FILE_BYTES = 5 * 1024 * 1024;
const TEXT_EXTENSIONS = new Set([
  ".cjs", ".html", ".ini", ".js", ".json", ".log", ".md", ".mjs", ".txt", ".yaml", ".yml",
]);
const SKIP_DIRECTORIES = new Set([".git", "data", "node_modules", "screenshots", "tmp"]);
const ACTION_CONTEXT_RE = /(?:action|invoke|request)\s*(?:\(|:|=)\s*["']([A-Za-z][A-Za-z0-9_]*)["']/g;

function parseArgs(argv) {
  const [command = "help", ...rest] = argv;
  const options = { command, json: false, root: process.cwd() };

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--json") options.json = true;
    else if (arg === "--root") options.root = rest[++index];
    else throw new Error(`unknown argument: ${arg}`);
  }

  if (!options.root) throw new Error("--root requires a path");
  return options;
}

function walkTextFiles(root) {
  const resolvedRoot = resolve(root);
  const files = [];
  const pending = [resolvedRoot];

  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory() && SKIP_DIRECTORIES.has(entry.name)) continue;
      const path = resolve(current, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) {
        const size = statSync(path).size;
        if (size <= MAX_TEXT_FILE_BYTES && TEXT_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
          files.push(path);
        }
      }
    }
  }

  return { files, root: resolvedRoot };
}

export function discoverStaticActions(root) {
  const knownActions = new Set(CAPABILITIES.flatMap((capability) => capability.vendorActions));
  const { files, root: resolvedRoot } = walkTextFiles(root);
  const hits = new Map();

  for (const path of files) {
    const text = readFileSync(path, "utf8");
    const candidates = new Set();

    for (const action of knownActions) {
      if (text.includes(action)) candidates.add(action);
    }

    ACTION_CONTEXT_RE.lastIndex = 0;
    for (let match = ACTION_CONTEXT_RE.exec(text); match; match = ACTION_CONTEXT_RE.exec(text)) {
      candidates.add(match[1]);
    }

    for (const action of candidates) {
      const filesForAction = hits.get(action) || [];
      filesForAction.push({
        file: relative(resolvedRoot, path) || basename(path),
        sha256: createHash("sha256").update(text).digest("hex"),
      });
      hits.set(action, filesForAction);
    }
  }

  return {
    rootLabel: basename(resolvedRoot),
    scannedFiles: files.length,
    actions: [...hits.entries()]
      .map(([action, sources]) => ({ action, sources }))
      .sort((left, right) => left.action.localeCompare(right.action)),
  };
}

function printHelp() {
  console.log(`Xiaowei capability discovery

node scripts/xiaowei-discover.mjs inventory [--json]
node scripts/xiaowei-discover.mjs static --root <approved-path> [--json]

The static command reads approved text resources only. It never invokes a device action.`);
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  let result;

  if (options.command === "inventory") result = summarizeCapabilities();
  else if (options.command === "static") result = discoverStaticActions(options.root);
  else if (options.command === "help") return printHelp();
  else throw new Error(`unknown command: ${options.command}`);

  console.log(JSON.stringify(result, null, options.json ? 2 : 0));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
