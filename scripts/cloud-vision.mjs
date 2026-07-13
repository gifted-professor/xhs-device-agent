import { basename } from "node:path";

function arg(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

async function main() {
  throw new Error("Standalone cloud screenshot upload is disabled; use Run-TopicResearch.ps1 so the exact image receives two local OCR privacy checks and a matching hash attestation");
}

if (process.argv[1] && basename(process.argv[1]) === basename(new URL(import.meta.url).pathname)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
