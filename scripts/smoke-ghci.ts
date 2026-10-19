/**
 * Runs the built server in direct GHCi mode against a real Tidal install and
 * checks that accepted patterns play and rejected ones come back as errors.
 *
 * Only silent patterns are used (rests, and code that doesn't type-check), on
 * d9, so it's safe to run while SuperDirt is up.
 *
 * Usage: npm run build && npm run smoke:ghci   (set GHCI_PATH if ghci isn't on PATH)
 */
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawn } from "node:child_process";
import { GhciSession, TidalError } from "../src/ghci.js";

const root = path.resolve(import.meta.dirname, "..");
const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tidal-smoke-"));

const client = new Client({ name: "smoke", version: "1.0.0" });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, "dist", "index.js")],
    env: {
      ...process.env,
      TIDAL_USE_GHCI: "true",
      // SMOKE_BOOT_PATH: a boot file with another cCtrlPort, if another Tidal has 6011
      TIDAL_BOOT_PATH: process.env.SMOKE_BOOT_PATH || path.join(root, "BootTidal.hs"),
      TIDAL_FILE: path.join(tmpDir, "out.tidal"),
      // Sharing isn't available on Windows
      TIDAL_SHARE_SESSION: process.platform === "win32" ? "false" : "true",
      TIDAL_SHARE_DIR: path.join(tmpDir, "share"),
      TIDAL_UPDATE_CHECK: "false",
    } as Record<string, string>,
    stderr: "ignore",
  })
);

let failures = 0;
async function check(label: string, name: string, args: Record<string, unknown>, expect: { error: boolean; text?: RegExp }) {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as Array<{ text: string }>)[0].text;
  const ok = (result.isError === true) === expect.error && (!expect.text || expect.text.test(text));
  if (!ok) failures++;
  console.log(`${ok ? "✓" : "✗"} ${label}${ok ? "" : `\n${text}\n`}`);
}

try {
  await check("starts Tidal and reports it", "tidal_status", {}, {
    error: false, text: /Tidal: running, version [\d.]+[\s\S]*Control port: Tidal is listening on /,
  });
  await check("plays a pattern Tidal accepts", "tidal_eval", { channel: "d9", pattern: 's "~ ~"' }, { error: false });
  await check("returns a type error", "tidal_eval", { channel: "d9", pattern: "sound 3" }, {
    error: true,
    text: /Tidal rejected the pattern[\s\S]*No instance for/,
  });
  await check("plays a source layer", "tidal_set_layer", {
    channel: "d9", name: "beat", kind: "source", code: 's "~ ~"',
  }, { error: false });
  await check("returns a scope error from a multi-line layer", "tidal_set_layer", {
    channel: "d9", name: "fx", kind: "control", code: 'nope\n  "0"',
  }, { error: true, text: /not in scope: nope/ });
  await check("kept the accepted layers", "tidal_get_state", {}, { error: false, text: /source "beat": s "~ ~"(?![\s\S]*"fx")/ });
  await check("sends a control to Tidal's control port", "tidal_set_control", { name: "smoke", value: 1 }, {
    error: false, text: /via 127\.0\.0\.1:\d+/,
  });

  // Run the ghci wrapper the way Pulsar would: boot line, highlighted code, a bad line
  if (process.platform !== "win32") {
    const editor = await new Promise<{ out: string; err: string }>((resolve) => {
      const child = spawn(path.join(tmpDir, "share", "bin", "ghci"), []);
      let out = "";
      let err = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      child.on("close", () => resolve({ out, err }));
      child.stdin.end(
        [`:script ${path.join(root, "BootTidal.hs")}`, ":{", 'd9 $ s (deltaContext 7 0 "~ ~ ~")', ":}", "d8 $ sound 3", ""].join("\n")
      );
    });
    const shared = /Connected to the Tidal session/.test(editor.out) && /No instance for/.test(editor.err);
    if (!shared) failures++;
    console.log(`${shared ? "✓" : "✗"} an editor shares the session through the ghci wrapper${shared ? "" : `\n${editor.out}\n${editor.err}`}`);
    await check("knows what the editor played", "tidal_get_state", {}, { error: false, text: /d9: s "~ ~ ~"/ });
  }

  await check("silences the channel", "tidal_silence", { channel: "d9" }, { error: false });
  await check("sets the tempo", "tidal_set_tempo", { bpm: 120 }, { error: false });

  // The session log is meant to be replayed in an editor: every code block must be valid Tidal
  const status = await client.callTool({ name: "tidal_status", arguments: {} });
  const logFile = (status.content as Array<{ text: string }>)[0].text.match(/Session log: (.*)/)![1];
  const blocks = (await fs.readFile(logFile, "utf-8")).trim().split(/\n\n/)
    .map((b) => b.split("\n").filter((l) => !l.startsWith("--")).join("\n"))
    .filter(Boolean);
  const replay = new GhciSession({
    ghciPath: process.env.GHCI_PATH || "ghci",
    bootPath: process.env.SMOKE_BOOT_PATH || path.join(root, "BootTidal.hs"),
    allowBusyCtrlPort: true, // the server's Tidal has it
    log: () => {},
  });
  await replay.start();
  const invalid: string[] = [];
  for (const block of blocks) {
    await replay.run(`:t (${block})`).catch((e) => {
      if (!(e instanceof TidalError)) throw e;
      invalid.push(`${block}\n${e.message}`);
    });
  }
  replay.stop();
  const replayable = blocks.length >= 5 && invalid.length === 0;
  if (!replayable) failures++;
  console.log(`${replayable ? "✓" : "✗"} the session log's ${blocks.length} code blocks are all valid Tidal${replayable ? "" : `\n${invalid.join("\n\n")}`}`);
} finally {
  await client.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`${failures} smoke check(s) failed.`);
  process.exit(1);
}
console.log("All smoke checks passed against real Tidal.");
