/**
 * Type-checks the Tidal code this server generates against a real Tidal install.
 *
 * Starts GHCi with BootTidal.hs (through GhciSession, as the server does) and
 * runs `:t` on every command builder, every palette entry, and every statement
 * in examples.tidal. `:t` only checks
 * types, so nothing is played even if SuperDirt is running.
 *
 * Usage: npm run typecheck:tidal   (set GHCI_PATH if ghci isn't on PATH)
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { GhciSession, TidalError } from "../src/ghci.js";
import {
  HUSH_COMMAND,
  controlCommand,
  evalCommand,
  silenceCommand,
  soloCommand,
  tempoCommand,
  unsoloCommand,
} from "../src/commands.js";
import { composePattern, setLayer, Layer } from "../src/layers.js";
import { PALETTE_CONTROLS, PALETTE_SOURCES, PALETTE_TRANSFORMS } from "../src/palette.js";
import { loadSoundLibrary, unknownSounds } from "../src/samples.js";

interface Check {
  label: string;
  expression: string;
  type: string;
}

const io = (label: string, expression: string): Check => ({ label, expression, type: "IO ()" });

let layered: Layer[] = [];
layered = setLayer(layered, { name: "src", kind: "source", code: 'slow 2 $ s "bd sd"' });
layered = setLayer(layered, { name: "t1", kind: "transform", code: "every 3 (jux rev)" });
layered = setLayer(layered, { name: "t2", kind: "transform", code: "chop 4" });
layered = setLayer(layered, { name: "c1", kind: "control", code: "crush 4" });
layered = setLayer(layered, { name: "c2", kind: "control", code: "pan $ slow 4 sine" });

const checks: Check[] = [
  io("eval", evalCommand("d1", 's "bd sd"')),
  io("silence", silenceCommand("d1")),
  io("solo", soloCommand("d2")),
  io("unsolo", unsoloCommand(["d2", "d4"])),
  io("hush", HUSH_COMMAND),
  io("tempo", tempoCommand(128.5)),
  io("control (number)", controlCommand("cutoff", -0.25)),
  io("control (string)", controlCommand("bank", 'say "hi"')),
  io("composed layers", evalCommand("d1", composePattern(layered))),
  io("multi-line eval", evalCommand("d1", 'every 2 (fast 2)\n  $ s "bd sd"')),
  ...Object.entries(PALETTE_TRANSFORMS).flatMap(([group, entries]) =>
    entries.map((e) => ({ label: `transform/${group}`, expression: e, type: "ControlPattern -> ControlPattern" }))
  ),
  ...Object.entries(PALETTE_SOURCES).flatMap(([group, entries]) =>
    entries.map((e) => ({ label: `source/${group}`, expression: e, type: "ControlPattern" }))
  ),
  ...Object.entries(PALETTE_CONTROLS).flatMap(([group, entries]) =>
    entries.map((e) => ({ label: `control/${group}`, expression: e, type: "ControlPattern" }))
  ),
];

// examples.tidal, one statement per line plus indented continuation lines,
// with comments removed (outside quotes), the way an editor evaluates lines
function exampleStatements(text: string): string[] {
  const stripComment = (line: string) => {
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '"') quoted = !quoted;
      if (!quoted && line.startsWith("--", i)) return line.slice(0, i);
    }
    return line;
  };
  const statements: string[] = [];
  for (const raw of text.split("\n")) {
    const line = stripComment(raw).replace(/\s+$/, "");
    if (!line.trim()) continue;
    if (/^\s/.test(line) && statements.length) statements[statements.length - 1] += "\n" + line;
    else statements.push(line);
  }
  return statements;
}
const examples = fs.readFileSync(path.resolve(import.meta.dirname, "..", "examples.tidal"), "utf-8");
for (const statement of exampleStatements(examples)) {
  // No type annotation: statements are a mix of patterns and IO actions
  checks.push({ label: "examples.tidal", expression: statement, type: "" });
}

const ghci = new GhciSession({
  ghciPath: process.env.GHCI_PATH || "ghci",
  bootPath: path.resolve(import.meta.dirname, "..", "BootTidal.hs"),
  // Only :t runs, so another Tidal on the control port (e.g. Claude Desktop's) doesn't matter
  allowBusyCtrlPort: true,
  log: () => {},
});

try {
  await ghci.start();
} catch (error) {
  console.error(`Couldn't start Tidal: ${(error as Error).message}`);
  process.exit(2);
}

// Tidal reports its version when it boots; ask for it rather than parse the banner
const version = (await ghci.run("putStrLn tidal_version").catch(() => "")) || "unknown";

const failures: string[] = [];
for (const check of checks) {
  try {
    await ghci.run(check.type ? `:t (${check.expression}) :: ${check.type}` : `:t (${check.expression})`);
  } catch (error) {
    if (!(error instanceof TidalError)) throw error;
    failures.push(`✗ ${check.label}: ${check.expression}\n${error.message}\n`);
  }
}
ghci.stop();

// Palette entries must only use sounds that exist. Skipped without Dirt-Samples (e.g. in CI).
const library = loadSoundLibrary();
if (library.banks.size > 0) {
  for (const check of checks.filter((c) => c.label.startsWith("source/") || c.label.startsWith("control/"))) {
    const missing = unknownSounds(check.expression, library);
    if (missing.length > 0) {
      failures.push(`✗ ${check.label}: ${check.expression}\nNo such sound in Dirt-Samples: ${missing.join(", ")}\n`);
    }
  }
} else {
  console.log("Dirt-Samples not found; skipping the sample-name check.");
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  console.error(`${failures.length} of ${checks.length} checks failed against Tidal ${version}.`);
  process.exit(1);
}
console.log(`All ${checks.length} checks passed against Tidal ${version}.`);
