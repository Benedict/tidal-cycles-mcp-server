import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Path settings arrive from environment variables that people paste into
 * config files and app settings, so they can carry stray spaces, a ~, or a
 * ${HOME} that the app didn't expand (Claude Desktop passes it through).
 */
export function expandPath(value: string, home = os.homedir()): string {
  const trimmed = value.trim();
  if (trimmed === "~") return home;
  if (/^~[/\\]/.test(trimmed)) return path.join(home, trimmed.slice(2));
  return trimmed.replace(/^\$\{HOME\}|^\$HOME(?=[/\\]|$)/, home);
}

/** A path setting, cleaned up and made absolute, or undefined when unset or blank. */
export function pathSetting(value: string | undefined, home = os.homedir()): string | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  return path.resolve(expandPath(value, home));
}

export interface GhciLookup {
  /** The ghci to run, if one was found */
  path?: string;
  /** Every place looked, for the error message when none was */
  tried: string[];
}

interface LookupEnv {
  PATH?: string;
  HOME?: string;
}

/**
 * Finds ghci. A path in GHCI_PATH is used as given. Plain `ghci` (the default)
 * is looked up on PATH, then where ghcup and Homebrew install it, because apps
 * started from the Dock or Finder don't get the PATH your shell sets up.
 */
export function findGhci(
  setting: string | undefined,
  env: LookupEnv = process.env,
  platform: NodeJS.Platform = process.platform
): GhciLookup {
  const home = env.HOME || os.homedir();
  const wanted = setting?.trim() ? expandPath(setting, home) : "ghci";
  if (wanted !== "ghci") return { path: wanted, tried: [wanted] };

  const windows = platform === "win32";
  const names = windows ? ["ghci.exe", "ghci.cmd", "ghci.bat"] : ["ghci"];
  const join = windows ? path.win32.join : path.posix.join;
  const dirs = [
    ...(env.PATH ?? "").split(windows ? ";" : ":").filter(Boolean),
    ...(windows
      ? ["C:\\ghcup\\bin", join(home, "AppData", "Roaming", "ghcup", "bin")]
      : [join(home, ".ghcup", "bin"), "/opt/homebrew/bin", "/usr/local/bin"]),
  ];

  const tried: string[] = [];
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = join(dir, name);
      if (tried.includes(candidate)) continue;
      tried.push(candidate);
      if (isExecutable(candidate)) return { path: candidate, tried };
    }
  }
  return { tried };
}

function isExecutable(file: string): boolean {
  try {
    fs.accessSync(file, process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}
