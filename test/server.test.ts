import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { makeSoundFixture } from "./fixtures/sounds.js";
import { decodeMessage } from "./fixtures/osc-decode.js";
import * as dgram from "node:dgram";

// Drives the built server (dist/index.js) over stdio in file mode and checks
// the Tidal code it writes.

let client: Client;
let tmpDir: string;
let tidalFile: string;
// Stands in for Tidal's control port
let controlPort: dgram.Socket;
const controlMessages: Array<{ address: string; args: Array<string | number> }> = [];

async function call(name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as Array<{ type: string; text: string }>)[0].text;
  return { text, isError: result.isError === true };
}

async function writtenCode() {
  const content = await fs.readFile(tidalFile, "utf-8");
  return content.split("\n").filter((l) => l && !l.startsWith("--")).join("\n");
}

before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tidal-mcp-test-"));
  tidalFile = path.join(tmpDir, "out.tidal");
  // A fixture sample library, so results don't depend on what's installed
  await makeSoundFixture(path.join(tmpDir, "quarks"));
  controlPort = dgram.createSocket("udp4");
  controlPort.on("message", (msg) => controlMessages.push(decodeMessage(msg)));
  await new Promise<void>((resolve) => controlPort.bind(0, "127.0.0.1", resolve));
  client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["dist/index.js"],
      env: { ...process.env, TIDAL_FILE: tidalFile, TIDAL_QUARKS_PATH: path.join(tmpDir, "quarks"), TIDAL_SAMPLE_PATHS: "",
        TIDAL_CTRL_PORT: String(controlPort.address().port),
      } as Record<string, string>,
      stderr: "ignore",
    })
  );
});

after(async () => {
  await client.close();
  controlPort.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

test("lists all tools", async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [
    "strudel_get_state",
    "strudel_hush",
    "strudel_remove_block",
    "strudel_set_block",
    "strudel_set_tempo",
    "tidal_autopilot",
    "tidal_eval",
    "tidal_get_history",
    "tidal_get_state",
    "tidal_hush",
    "tidal_list_samples",
    "tidal_palette",
    "tidal_remove_layer",
    "tidal_set_control",
    "tidal_set_layer",
    "tidal_set_tempo",
    "tidal_silence",
    "tidal_solo",
    "tidal_status",
    "tidal_unsolo",
  ]);
});

test("tidal_eval writes the pattern and updates state", async () => {
  const res = await call("tidal_eval", { channel: "d1", pattern: 'sound "bd sd"' });
  assert.equal(res.isError, false);
  assert.equal(await writtenCode(), 'd1 $ sound "bd sd"');

  const state = await call("tidal_get_state");
  assert.match(state.text, /d1: sound "bd sd"/);
});

test("tidal_eval rejects an invalid channel", async () => {
  const res = await call("tidal_eval", { channel: "d1 $ hush; d2", pattern: "x" });
  assert.equal(res.isError, true);
  assert.match(res.text, /Invalid channel/);
});

test("tidal_eval rejects an empty pattern", async () => {
  const res = await call("tidal_eval", { channel: "d2", pattern: "  " });
  assert.equal(res.isError, true);
});

test("tidal_solo and tidal_unsolo emit valid Tidal", async () => {
  await call("tidal_solo", { channel: "d2" });
  assert.equal(await writtenCode(), "solo 2");
  await call("tidal_solo", { channel: "d4" });

  await call("tidal_unsolo");
  assert.equal(await writtenCode(), "unsolo 2 >> unsolo 4");

  const again = await call("tidal_unsolo");
  assert.match(again.text, /No channels are soloed/);
});

test("tidal_silence and tidal_hush", async () => {
  await call("tidal_silence", { channel: "d1" });
  assert.equal(await writtenCode(), "d1 silence");
  await call("tidal_hush");
  assert.equal(await writtenCode(), "hush");
  assert.match((await call("tidal_get_state")).text, /No active patterns/);
});

test("tidal_get_history numbers most recent first", async () => {
  await call("tidal_eval", { channel: "d3", pattern: 'sound "hh*8"' });
  const { text } = await call("tidal_get_history", { limit: 10 });
  const lines = text.split("\n").slice(1);
  assert.match(lines[0], /^1\. d3: sound "hh\*8"/);
  assert.match(lines[1], /^2\. d1: sound "bd sd"/);
});

test("layers build up a channel and can be removed", async () => {
  const stored = await call("tidal_set_layer", { channel: "d5", name: "stereo", kind: "transform", code: "jux rev" });
  assert.match(stored.text, /Add a source layer/);

  await call("tidal_set_layer", { channel: "d5", name: "beat", kind: "source", code: 's "bd*2 sd"' });
  assert.equal(await writtenCode(), 'd5 $ jux rev $ s "bd*2 sd"');

  await call("tidal_set_layer", { channel: "d5", name: "grit", kind: "control", code: "crush 4" });
  assert.equal(await writtenCode(), 'd5 $ jux rev $ s "bd*2 sd" # crush 4');

  const state = await call("tidal_get_state");
  assert.match(state.text, /control "grit": crush 4/);

  await call("tidal_remove_layer", { channel: "d5", name: "stereo" });
  assert.equal(await writtenCode(), 'd5 $ s "bd*2 sd" # crush 4');

  const refused = await call("tidal_remove_layer", { channel: "d5", name: "beat" });
  assert.equal(refused.isError, true);
});

test("tidal_eval replaces a channel's layers", async () => {
  await call("tidal_set_layer", { channel: "d6", name: "beat", kind: "source", code: 's "hh*4"' });
  await call("tidal_eval", { channel: "d6", pattern: 's "cp"' });
  const state = await call("tidal_get_state");
  assert.doesNotMatch(state.text, /source "beat": s "hh\*4"/);
});

test("tidal_set_layer rejects a bad kind", async () => {
  const res = await call("tidal_set_layer", { channel: "d1", name: "x", kind: "effect", code: "rev" });
  assert.equal(res.isError, true);
  assert.match(res.text, /kind must be one of/);
});

test("autopilot evolves layers until paused, and stop hushes", async () => {
  await call("tidal_set_layer", {
    channel: "d7",
    name: "beat",
    kind: "source",
    code: 's "bd*2"',
    variants: ['s "bd*3"'],
  });

  const started = await call("tidal_autopilot", { action: "start", minSeconds: 0.02, maxSeconds: 0.02, layOutChance: 0 });
  assert.match(started.text, /1 layer\(s\) changing/);
  await new Promise((r) => setTimeout(r, 200));
  await call("tidal_autopilot", { action: "pause" });

  const { text } = await call("tidal_get_history", { limit: 50 });
  assert.match(text, /d7: s "bd\*3"/);
  assert.match((await call("tidal_autopilot", { action: "status" })).text, /Autopilot paused/);

  await call("tidal_autopilot", { action: "stop" });
  assert.equal(await writtenCode(), "hush");
  assert.match((await call("tidal_get_state")).text, /No active patterns/);
});

test("tidal_palette returns the reference list", async () => {
  assert.match((await call("tidal_palette")).text, /TRANSFORMS/);
});

test("tidal_set_tempo sets cps from BPM and shows in state", async () => {
  const res = await call("tidal_set_tempo", { bpm: 128 });
  assert.equal(res.isError, false);
  assert.equal(await writtenCode(), "setcps (128/60/4)");
  assert.match((await call("tidal_get_state", { quiet: true })).text, /Tempo: 128 BPM/);

  const bad = await call("tidal_set_tempo", { bpm: 5000 });
  assert.equal(bad.isError, true);
});

test("the server reports the package version", () => {
  assert.match(client.getServerVersion()?.version ?? "", /^\d+\.\d+\.\d+/);
});

test("tidal_list_samples lists the installed banks and synths", async () => {
  const { text } = await call("tidal_list_samples", { filter: "b" });
  assert.match(text, /bd \(2\)/);
  assert.match(text, /808bd \(1\)/);
});

test("warns about sounds SuperDirt doesn't have, without failing", async () => {
  const res = await call("tidal_eval", { channel: "d8", pattern: 's "bd rim tom:2"' });
  assert.equal(res.isError, false);
  assert.match(res.text, /no sound called "rim", "tom", so they will be silent/);

  const layer = await call("tidal_set_layer", {
    channel: "d8", name: "beat", kind: "source", code: 's "bd"', variants: ['s "nope"'],
  });
  assert.match(layer.text, /no sound called "nope", so it will be silent/);

  const fine = await call("tidal_eval", { channel: "d8", pattern: 's "bd sd superpiano"' });
  assert.doesNotMatch(fine.text, /⚠/);
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("tidal_set_control sends /ctrl to Tidal's control port", async () => {
  const res = await call("tidal_set_control", { name: "cutoff", value: 1000 });
  assert.equal(res.isError, false);
  await call("tidal_set_control", { name: "vowel", value: "o" });
  await sleep(50);
  assert.deepEqual(controlMessages.slice(-2), [
    { address: "/ctrl", args: ["cutoff", 1000] },
    { address: "/ctrl", args: ["vowel", "o"] },
  ]);
  assert.match((await call("tidal_get_state")).text, /Controls: cutoff=1000, vowel="o"/);
});

test("tidal_set_control glides a number to its new value", async () => {
  const before = controlMessages.length;
  const res = await call("tidal_set_control", { name: "cutoff", value: 3000, seconds: 0.25 });
  assert.match(res.text, /gliding from 1000 to 3000/);
  await sleep(500);
  const sent = controlMessages.slice(before).map((m) => m.args[1] as number);
  assert.ok(sent.length >= 4, `expected several steps, got ${sent.length}`);
  assert.ok(sent.every((v, i) => i === 0 || v > sent[i - 1]), "values rise steadily");
  assert.equal(sent.at(-1), 3000);
});

test("tidal_set_control rejects bad names and values", async () => {
  assert.equal((await call("tidal_set_control", { name: "1x", value: 1 })).isError, true);
  assert.equal((await call("tidal_set_control", { name: "x", value: true })).isError, true);
  assert.equal((await call("tidal_set_control", { name: "x", value: 1, seconds: 9999 })).isError, true);
});

test("hush wins over autopilot changes that are still being sent", async () => {
  for (let round = 0; round < 15; round++) {
    await call("tidal_set_layer", {
      channel: "d7", name: "beat", kind: "source", code: 's "bd*2"', variants: ['s "bd*3"', 's "bd*4"'],
    });
    await call("tidal_set_layer", { channel: "d7", name: "rev", kind: "transform", code: "rev", variants: ["fast 2"] });
    await call("tidal_autopilot", { action: "start", minSeconds: 0.001, maxSeconds: 0.003, layOutChance: 0.3 });
    await new Promise((r) => setTimeout(r, round % 5));
    await call("tidal_autopilot", { action: "stop" });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(await writtenCode(), "hush", `round ${round}: the file should end on hush`);
    assert.match((await call("tidal_get_state")).text, /No active patterns/, `round ${round}`);
  }
});

test("file mode rejects code with a :} line too, and writes nothing", async () => {
  const before = await fs.readFile(tidalFile, "utf-8").catch(() => "");
  const res = await call("tidal_eval", { channel: "d5", pattern: 's "bd"\n:}' });
  assert.equal(res.isError, true);
  assert.match(res.text, /can't contain a line that is just :\{ or :\}/);
  assert.equal(await fs.readFile(tidalFile, "utf-8").catch(() => ""), before);
});
