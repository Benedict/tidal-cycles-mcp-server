/**
 * Type-checks the Tidal code this server generates against a real Tidal install.
 *
 * Starts GHCi with BootTidal.hs (through GhciSession, as the server does) and
 * runs `:t` on every command builder and every palette entry. `:t` only checks
 * types, so nothing is played even if SuperDirt is running.
 *
 * Usage: npm run typecheck:tidal   (set GHCI_PATH if ghci isn't on PATH)
 */
import * as path from "node:path";
import { GhciSession, TidalError } from "../src/ghci.js";
import {
  HUSH_COMMAND,
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

const ghci = new GhciSession({
  ghciPath: process.env.GHCI_PATH || "ghci",
  bootPath: path.resolve(import.meta.dirname, "..", "BootTidal.hs"),
  log: () => {},
});

try {
  await ghci.start();
} catch (error) {
  console.error(`Couldn't start Tidal: ${(error as Error).message}\nSet GHCI_PATH or put ghci on PATH.`);
  process.exit(2);
}

// Tidal reports its version when it boots; ask for it rather than parse the banner
const version = (await ghci.run("putStrLn tidal_version").catch(() => "")) || "unknown";

const failures: string[] = [];
for (const check of checks) {
  try {
    await ghci.run(`:t (${check.expression}) :: ${check.type}`);
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
