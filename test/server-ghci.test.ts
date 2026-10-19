import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fakeGhci } from "./fixtures/paths.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Drives the built server in direct GHCi mode against test/fixtures/fake-ghci.mjs.


let tmpDir: string;
let logFile: string;
const clients: Client[] = [];

async function connect(env: Record<string, string>): Promise<Client> {
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["dist/index.js"],
      env: {
        ...process.env,
        TIDAL_FILE: path.join(tmpDir, "out.tidal"),
        TIDAL_USE_GHCI: "true",
        TIDAL_BOOT_PATH: path.join(tmpDir, "BootTidal.hs"),
        GHCI_PATH: fakeGhci,
        FAKE_GHCI_LOG: logFile,
        ...env,
      } as Record<string, string>,
      stderr: "ignore",
    })
  );
  clients.push(client);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as Array<{ type: string; text: string }>)[0].text;
  return { text, isError: result.isError === true };
}

async function received(): Promise<string[]> {
  const text = await fs.readFile(logFile, "utf-8").catch(() => "");
  return text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

let client: Client;

before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tidal-mcp-ghci-test-"));
  logFile = path.join(tmpDir, "received.log");
  await fs.writeFile(path.join(tmpDir, "BootTidal.hs"), "import Sound.Tidal.Context\n");
  client = await connect({});
});

after(async () => {
  await Promise.all(clients.map((c) => c.close()));
  await fs.rm(tmpDir, { recursive: true, force: true });
});

test("a pattern Tidal accepts is sent and recorded", async () => {
  const res = await call(client, "tidal_eval", { channel: "d1", pattern: 's "bd sd"' });
  assert.equal(res.isError, false);
  assert.ok((await received()).includes('d1 $ s "bd sd"'));
  assert.match((await call(client, "tidal_get_state")).text, /d1: s "bd sd"/);
});

test("a pattern Tidal rejects returns the error and changes nothing", async () => {
  const res = await call(client, "tidal_eval", { channel: "d1", pattern: "BAD" });
  assert.equal(res.isError, true);
  assert.match(res.text, /Tidal rejected the pattern\. The previous pattern on d1 is still playing\./);
  assert.match(res.text, /Variable not in scope: BAD/);

  assert.match((await call(client, "tidal_get_state")).text, /d1: s "bd sd"/);
  assert.doesNotMatch((await call(client, "tidal_get_history")).text, /BAD/);
});

test("a rejected layer leaves the channel's layers as they were", async () => {
  await call(client, "tidal_set_layer", { channel: "d2", name: "beat", kind: "source", code: 's "hh*4"' });
  const res = await call(client, "tidal_set_layer", { channel: "d2", name: "fx", kind: "control", code: "BAD" });
  assert.equal(res.isError, true);

  const state = (await call(client, "tidal_get_state")).text;
  assert.match(state, /d2: s "hh\*4"/);
  assert.doesNotMatch(state, /"fx"/);
});

test("silence and hush go to GHCi", async () => {
  await call(client, "tidal_silence", { channel: "d2" });
  await call(client, "tidal_hush");
  const sent = await received();
  assert.ok(sent.includes("d2 silence"));
  assert.equal(sent.at(-1), "hush");
});

test("reports why Tidal couldn't start", async () => {
  const broken = await connect({ GHCI_PATH: path.join(tmpDir, "no-such-ghci") });
  const res = await call(broken, "tidal_eval", { channel: "d1", pattern: 's "bd"' });
  assert.equal(res.isError, true);
  assert.match(res.text, /Couldn't start Tidal: Couldn't run .*no-such-ghci/);
});

test("finds ghci and the boot file without PATH, despite stray spaces", { skip: process.platform === "win32" }, async () => {
  // Like an app started from the Dock: no PATH, ghci where ghcup installs it
  const home = path.join(tmpDir, "home");
  const ghci = path.join(home, ".ghcup", "bin", "ghci");
  await fs.mkdir(path.dirname(ghci), { recursive: true });
  await fs.writeFile(ghci, `#!/bin/sh\nexec "${process.execPath}" "${fakeGhci}" "$@"\n`, { mode: 0o755 });
  await fs.writeFile(path.join(home, "BootTidal.hs"), "import Sound.Tidal.Context\n");

  const app = await connect({ PATH: "", HOME: home, GHCI_PATH: "", TIDAL_BOOT_PATH: " ~/BootTidal.hs " });
  const res = await call(app, "tidal_eval", { channel: "d3", pattern: 's "cp"' });
  assert.equal(res.isError, false, res.text);
  assert.ok((await received()).includes('d3 $ s "cp"'));
});

test("says where it looked when it can't find ghci", { skip: process.platform === "win32" }, async () => {
  const lost = await connect({ PATH: "", HOME: path.join(tmpDir, "empty-home"), GHCI_PATH: "ghci" });
  const res = await call(lost, "tidal_eval", { channel: "d1", pattern: 's "bd"' });
  assert.equal(res.isError, true);
  assert.match(res.text, /Couldn't find ghci\. Looked in:/);
  assert.match(res.text, /empty-home\/\.ghcup\/bin\/ghci/);
});

test("Tidal starts on first use, not when the server starts", async () => {
  const quietLog = path.join(tmpDir, "quiet.log");
  const idle = await connect({ FAKE_GHCI_LOG: quietLog });
  await idle.listTools();
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(await fs.readFile(quietLog, "utf-8").catch(() => ""), "");

  await call(idle, "tidal_eval", { channel: "d1", pattern: 's "bd"' });
  assert.match(await fs.readFile(quietLog, "utf-8"), /d1 \$ s \\"bd\\"/);
});

test("tidal_status reports the resolved settings and that Tidal is running", async () => {
  const { text } = await call(client, "tidal_status");
  assert.match(text, /Mode: GHCi/);
  assert.ok(text.includes(`ghci: ${fakeGhci}`), text);
  assert.ok(text.includes(`Boot file: ${path.join(tmpDir, "BootTidal.hs")}\n`), text);
  assert.match(text, /Tidal: running, version 1\.10\.3 \(GHCi process \d+\)/);
  assert.match(text, /Control port: Tidal is listening on 127\.0\.0\.1:6011/);
  assert.match(text, /Session log: /);
});

test("tidal_status shows why Tidal didn't start, with the paths as resolved", async () => {
  await fs.writeFile(path.join(tmpDir, "notidal-BootTidal.hs"), "-- nothing\n");
  const broken = await connect({ TIDAL_BOOT_PATH: ` ${path.join(tmpDir, "notidal-BootTidal.hs")} ` });
  const { text } = await call(broken, "tidal_status");
  assert.ok(text.includes(`Boot file: ${path.join(tmpDir, "notidal-BootTidal.hs")}\n`), text);
  assert.match(text, /Tidal: not running\. Tidal didn't load: setcps isn't defined/);

  const missing = await connect({ TIDAL_BOOT_PATH: path.join(tmpDir, "Nowhere.hs") });
  const status = (await call(missing, "tidal_status")).text;
  assert.match(status, /Boot file: .*Nowhere\.hs \(not found\)/);
  assert.match(status, /Tidal: not running\. Boot file not found: .*Nowhere\.hs/);
});

test("a second Tidal on the same control port fails instead of playing too", async () => {
  await fs.writeFile(path.join(tmpDir, "portbusy-BootTidal.hs"), "import Sound.Tidal.Context\n");
  const second = await connect({ TIDAL_BOOT_PATH: path.join(tmpDir, "portbusy-BootTidal.hs") });
  const res = await call(second, "tidal_eval", { channel: "d1", pattern: 's "bd"' });
  assert.equal(res.isError, true);
  assert.match(res.text, /control port \(127\.0\.0\.1:6011\) is in use/);
});

test("code with a :} line is rejected before it reaches GHCi", async () => {
  const before = (await received()).length;
  const escape = await call(client, "tidal_eval", { channel: "d4", pattern: 's "bd"\n:}\n:! touch pwned' });
  assert.equal(escape.isError, true);
  assert.match(escape.text, /can't contain a line that is just :\{ or :\}/);

  const layer = await call(client, "tidal_set_layer", {
    channel: "d4", name: "beat", kind: "source", code: 's "bd"', variants: ['s "sn"\n  :{  '],
  });
  assert.equal(layer.isError, true);
  assert.equal((await received()).length, before);
  assert.doesNotMatch((await call(client, "tidal_get_state")).text, /d4/);
});
