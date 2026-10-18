/**
 * Type-checks the Tidal code this server generates against a real Tidal install.
 *
 * Starts GHCi with BootTidal.hs and runs `:t` on every command builder and every
 * palette entry. `:t` only checks types, so nothing is played even if SuperDirt
 * is running.
 *
 * Usage: npm run typecheck:tidal   (set GHCI_PATH if ghci isn't on PATH)
 */
import { spawn } from "node:child_process";
import * as path from "node:path";
import {
  HUSH_COMMAND,
  evalCommand,
  ghciBlock,
  silenceCommand,
  soloCommand,
  tempoCommand,
  unsoloCommand,
} from "../src/commands.js";
import { composePattern, setLayer, Layer } from "../src/layers.js";
import { PALETTE_CONTROLS, PALETTE_SOURCES, PALETTE_TRANSFORMS } from "../src/palette.js";

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

const marker = (i: number) => `<<check ${i}>>`;

const input =
  checks
    .map((c, i) => `putStrLn "${marker(i)}"\n${ghciBlock(`:t (${c.expression}) :: ${c.type}`)}`)
    .join("\n") + `\nputStrLn "${marker(checks.length)}"\n:q\n`;

const ghci = process.env.GHCI_PATH || "ghci";
const bootTidal = path.resolve(import.meta.dirname, "..", "BootTidal.hs");
const child = spawn(ghci, ["-ghci-script", bootTidal], { stdio: ["pipe", "pipe", "pipe"] });

let output = "";
child.stdout.on("data", (d) => (output += d));
child.stderr.on("data", (d) => (output += d));
child.on("error", (err) => {
  console.error(`Couldn't start ${ghci}: ${err.message}. Set GHCI_PATH or put ghci on PATH.`);
  process.exit(2);
});
child.stdin.end(input);

child.on("close", () => {
  const first = output.indexOf(marker(0));
  if (first === -1) {
    console.error("Tidal didn't boot. GHCi output:\n" + output);
    process.exit(1);
  }
  const boot = output.slice(0, first);
  if (/error/i.test(boot) && /Could not (find|load) module/.test(boot)) {
    console.error("BootTidal.hs failed to load. Is Tidal installed?\n" + boot);
    process.exit(1);
  }

  const failures: string[] = [];
  checks.forEach((check, i) => {
    const start = output.indexOf(marker(i));
    const end = output.indexOf(marker(i + 1));
    const segment = output.slice(start + marker(i).length, end === -1 ? undefined : end);
    if (end === -1 || /error/.test(segment)) {
      failures.push(`✗ ${check.label}: ${check.expression}\n${segment.trim()}\n`);
    }
  });

  const version = output.match(/TidalCycles version ([\d.]+)/)?.[1] ?? "unknown";
  if (failures.length > 0) {
    console.error(failures.join("\n"));
    console.error(`${failures.length} of ${checks.length} checks failed against Tidal ${version}.`);
    process.exit(1);
  }
  console.log(`All ${checks.length} checks passed against Tidal ${version}.`);
});
