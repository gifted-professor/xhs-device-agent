import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createAdbResearchProvider } from "./adb-research-provider.mjs";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
}

function parseJsonLines(text) {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line));
}

async function main() {
  const taskPath = argument("--task");
  const candidatesPath = argument("--candidates");
  const candidateId = argument("--candidate-id");
  const deviceAlias = argument("--device-alias");
  const providerConfigPath = argument("--provider-config");
  if (!taskPath || !candidatesPath || !candidateId || !deviceAlias || !providerConfigPath) {
    throw new Error("--task, --candidates, --candidate-id, --device-alias and --provider-config are required");
  }
  const [task, candidates, providerConfig] = await Promise.all([
    readFile(path.resolve(taskPath), "utf8").then(JSON.parse),
    readFile(path.resolve(candidatesPath), "utf8").then(parseJsonLines),
    readFile(path.resolve(providerConfigPath), "utf8").then(JSON.parse),
  ]);
  if (!Array.isArray(providerConfig.devices) || providerConfig.devices.length !== 1 || providerConfig.devices[0].alias !== deviceAlias) {
    throw new Error("Handoff provider must contain exactly the selected device alias");
  }
  const candidate = candidates.find((value) => value.candidateId === candidateId || value.noteId === candidateId);
  if (!candidate) throw new Error("Candidate was not found in the local task artifact");
  const provider = createAdbResearchProvider(providerConfig);
  const result = await provider.navigateToCandidate({ task, candidate, deviceAlias });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ error: error.code ?? error.name, message: error.message })}\n`);
    process.exitCode = 1;
  });
}
