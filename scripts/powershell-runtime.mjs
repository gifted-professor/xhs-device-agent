import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

function canRun(executable) {
  const result = spawnSync(executable, [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "exit 0",
  ], {
    windowsHide: true,
    stdio: "ignore",
    timeout: 5_000,
  });
  return !result.error && result.status === 0;
}

function isPathLike(value) {
  return path.isAbsolute(value) || value.includes("\\") || value.includes("/");
}

export function resolvePowerShellExecutable(options = {}) {
  const env = options.env ?? process.env;
  const fileExists = options.fileExists ?? existsSync;
  const probe = options.probe ?? canRun;
  const explicit = String(env.XHS_POWERSHELL_PATH ?? "").trim();

  if (explicit) {
    const available = isPathLike(explicit) ? fileExists(explicit) : probe(explicit);
    if (!available) throw new Error("XHS_POWERSHELL_PATH does not identify an available PowerShell executable");
    return explicit;
  }

  const candidates = [
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Microsoft", "WindowsApps", "pwsh.exe"),
    env.ProgramFiles && path.join(env.ProgramFiles, "PowerShell", "7", "pwsh.exe"),
    env.ProgramW6432 && path.join(env.ProgramW6432, "PowerShell", "7", "pwsh.exe"),
  ].filter(Boolean);
  const installed = candidates.find((candidate) => fileExists(candidate));
  if (installed) return installed;
  if (probe("pwsh.exe")) return "pwsh.exe";
  return "powershell.exe";
}

export const POWERSHELL_EXECUTABLE = resolvePowerShellExecutable();
