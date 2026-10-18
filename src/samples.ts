import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * The sounds SuperDirt can play: sample banks (folders of audio files) and
 * synths (SynthDefs shipped with SuperDirt). A pattern that names anything
 * else type-checks fine in Tidal but is silent, so the server warns about it.
 */

export interface SoundLibrary {
  /** Bank name → number of samples */
  banks: Map<string, number>;
  synths: Set<string>;
  /** Folders the banks were read from */
  sources: string[];
}

const AUDIO = /\.(wav|aiff?|aifc|flac|ogg)$/i;

/** Where SuperCollider puts quarks such as SuperDirt and Dirt-Samples. */
export function defaultQuarksDir(home = os.homedir(), platform = process.platform): string {
  switch (platform) {
    case "darwin":
      return path.join(home, "Library", "Application Support", "SuperCollider", "downloaded-quarks");
    case "win32":
      return path.join(process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), "SuperCollider", "downloaded-quarks");
    default:
      return path.join(home, ".local", "share", "SuperCollider", "downloaded-quarks");
  }
}

function readBanks(dir: string, banks: Map<string, number>): boolean {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    try {
      const count = fs.readdirSync(path.join(dir, entry.name)).filter((f) => AUDIO.test(f)).length;
      if (count > 0) banks.set(entry.name, count);
    } catch {
      // Unreadable folder: skip it
    }
  }
  return true;
}

function readSynths(superDirt: string, synths: Set<string>): void {
  for (const sub of ["synths", "library"]) {
    let files: string[];
    try {
      files = fs.readdirSync(path.join(superDirt, sub)).filter((f) => f.endsWith(".scd"));
    } catch {
      continue;
    }
    for (const file of files) {
      const text = fs.readFileSync(path.join(superDirt, sub, file), "utf-8");
      for (const match of text.matchAll(/SynthDef\(\s*\\([A-Za-z0-9_]+)/g)) {
        // dirt_* are SuperDirt's internal modules, not instruments
        if (!match[1].startsWith("dirt_") && match[1] !== "debug") synths.add(match[1]);
      }
    }
  }
}

export function loadSoundLibrary(options: { quarksDir?: string; extraPaths?: string[] } = {}): SoundLibrary {
  const quarksDir = options.quarksDir ?? (process.env.TIDAL_QUARKS_PATH || defaultQuarksDir());
  const banks = new Map<string, number>();
  const synths = new Set<string>();
  const sources: string[] = [];

  for (const dir of [path.join(quarksDir, "Dirt-Samples"), ...(options.extraPaths ?? [])]) {
    if (readBanks(dir, banks)) sources.push(dir);
  }
  readSynths(path.join(quarksDir, "SuperDirt"), synths);

  return { banks, synths, sources };
}

/**
 * Sound names used in `s "..."` / `sound "..."` mini-notation. `bd:3` gives
 * `bd`; rests, numbers and operators are ignored.
 */
export function extractSoundNames(pattern: string): string[] {
  const names = new Set<string>();
  for (const match of pattern.matchAll(/\b(?:s|sound)\s+"([^"]*)"/g)) {
    for (const word of match[1].matchAll(/[A-Za-z0-9_]*[A-Za-z][A-Za-z0-9_]*/g)) {
      names.add(word[0]);
    }
  }
  return [...names];
}

/** Sound names in the code that the library doesn't have. Empty if the library is unknown. */
export function unknownSounds(code: string, library: SoundLibrary): string[] {
  if (library.banks.size === 0) return [];
  return extractSoundNames(code).filter((n) => !library.banks.has(n) && !library.synths.has(n));
}

export function describeLibrary(library: SoundLibrary, filter?: string): string {
  if (library.banks.size === 0) {
    return (
      "Couldn't find any sample banks. Install Dirt-Samples in SuperCollider (Quarks.install(\"Dirt-Samples\")), " +
      "or set TIDAL_SAMPLE_PATHS to the folders your samples are in."
    );
  }
  const matches = (name: string) => !filter || name.toLowerCase().includes(filter.toLowerCase());
  const banks = [...library.banks].filter(([n]) => matches(n)).sort(([a], [b]) => a.localeCompare(b));
  const synths = [...library.synths].filter(matches).sort();

  const lines = [
    `${banks.length} sample bank${banks.length === 1 ? "" : "s"}${filter ? ` matching "${filter}"` : ""} ` +
      `(name, then how many samples; pick one with n or name:index):`,
    banks.map(([n, c]) => `${n} (${c})`).join(" · ") || "(none)",
  ];
  if (synths.length > 0) {
    lines.push("", `${synths.length} SuperDirt synth${synths.length === 1 ? "" : "s"} (use with s, and note for pitch):`, synths.join(" · "));
  }
  lines.push("", `Read from: ${library.sources.join(", ")}`);
  return lines.join("\n");
}
