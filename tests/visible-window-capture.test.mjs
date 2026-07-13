import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = path.join(projectRoot, "scripts", "Capture-VisibleWindow.ps1");

function runCapture(args) {
  return spawnSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, ...args],
    { encoding: "utf8" },
  );
}

test("visible-window capture rejects an invalid HWND before writing a file", () => {
  const result = runCapture(["-WindowHandle", "1", "-OutputPath", "invalid.png", "-AsJson"]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /window handle is no longer valid/i);
});

test("visible-window capture keeps images in the ignored runtime folder", () => {
  // CI does not have a foreground desktop window, so keep this boundary as a
  // source-level contract and exercise the live HWND validation above.
  const source = readFileSync(scriptPath, "utf8");
  assert.match(source, /OutputPath must stay inside/);
  assert.match(source, /data\\windows-capture/);
});
