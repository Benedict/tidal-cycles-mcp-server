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
      TIDAL_BOOT_PATH: path.join(root, "BootTidal.hs"),
      TIDAL_FILE: path.join(tmpDir, "out.tidal"),
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
  await check("silences the channel", "tidal_silence", { channel: "d9" }, { error: false });
} finally {
  await client.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`${failures} smoke check(s) failed.`);
  process.exit(1);
}
console.log("All smoke checks passed against real Tidal.");
