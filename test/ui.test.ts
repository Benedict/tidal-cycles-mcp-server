import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import WebSocket from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { composeStrudel } from "../src/ui.js";

// Runs the built server in file mode with the web page on, and drives it as a
// browser would: the control page's /events socket, and a stand-in Strudel page.

let tmpDir: string;
let port: number;
let client: Client;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

function get(pathname: string, host = `127.0.0.1:${port}`): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port, path: pathname, headers: { Host: host } }, (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      })
      .on("error", reject);
  });
}

type Inbox = Array<Record<string, any>>;
const inboxes = new WeakMap<WebSocket, Inbox>();

function socket(pathname: string, origin?: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${pathname}`, origin ? { headers: { Origin: origin } } : {});
    // Record from the start: the server can send before "open" reaches us
    const inbox: Inbox = [];
    inboxes.set(ws, inbox);
    ws.on("message", (data) => inbox.push(JSON.parse(data.toString())));
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
    ws.once("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
  });
}

/** Everything the socket has received since it was created. */
function messages(ws: WebSocket): Inbox {
  return inboxes.get(ws) ?? [];
}

async function call(name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  return { text: (result.content as Array<{ text: string }>)[0].text, isError: result.isError === true };
}

before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tidal-ui-test-"));
  port = await freePort();
  client = new Client({ name: "test", version: "1" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["dist/index.js"],
      env: { ...process.env, TIDAL_FILE: path.join(tmpDir, "out.tidal"), TIDAL_UI_PORT: String(port) } as Record<string, string>,
      stderr: "ignore",
    })
  );
  for (let i = 0; i < 50; i++) {
    if (await get("/").then(() => true, () => false)) break;
    await sleep(100);
  }
});

after(async () => {
  await client.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

test("composeStrudel turns blocks into $: patterns", () => {
  const blocks = new Map([["drums", 's("bd sd")'], ["keys", 'note("c e g")']]);
  assert.equal(composeStrudel(blocks), '// drums\n$: s("bd sd")\n\n// keys\n$: note("c e g")');
  assert.match(composeStrudel(blocks, 128), /^setcpm\(128\/4\)\n\n/);
});

test("serves the control and Strudel pages", async () => {
  const control = await get("/");
  assert.equal(control.status, 200);
  assert.match(control.body, /HUSH/);
  const strudel = (await get("/strudel")).body;
  assert.match(strudel, /@strudel\/web@1\.3\.0/);
  // Strudel puts its functions (including a run) in the global scope, so the page's own code must be a module
  assert.match(strudel, /<script type="module">/);
  assert.equal((await get("/nope")).status, 404);
});

test("refuses requests for other hostnames, against DNS rebinding", async () => {
  assert.equal((await get("/", `evil.example:${port}`)).status, 403);
  await assert.rejects(socket("/events", "http://evil.example"), /HTTP 403/);
});

test("the control page gets state and its Hush button works", async () => {
  await call("tidal_eval", { channel: "d1", pattern: 's "bd"' });
  const ws = await socket("/events", `http://127.0.0.1:${port}`);
  const inbox = messages(ws);
  await sleep(200);
  assert.equal(inbox[0].type, "hello");
  assert.equal(inbox[0].canControl, true);
  const state = inbox.find((m) => m.type === "state")!.state;
  assert.equal(state.channels[0].pattern, 's "bd"');

  ws.send(JSON.stringify({ action: "hush" }));
  await sleep(300);
  assert.ok(inbox.some((m) => m.type === "notice" && m.ok));
  const content = await fs.readFile(path.join(tmpDir, "out.tidal"), "utf-8");
  assert.match(content, /^hush$/m);
  ws.close();
});

test("Strudel tools explain what to do with no page open", async () => {
  const res = await call("strudel_set_block", { name: "drums", code: 's("bd")' });
  assert.equal(res.isError, true);
  assert.match(res.text, /Open http:\/\/127\.0\.0\.1:\d+\/strudel/);
});

test("Strudel blocks play on the page, and rejected code changes nothing", async () => {
  // A stand-in for strudel.html: accepts programs unless they contain BAD
  const loading = await socket("/strudel", `http://127.0.0.1:${port}`);
  const early = await call("strudel_set_block", { name: "drums", code: 's("bd")' });
  assert.equal(early.isError, true);
  assert.match(early.text, /still loading/);
  loading.close();

  const page = await socket("/strudel", `http://127.0.0.1:${port}`);
  page.send(JSON.stringify({ type: "ready" }));
  await sleep(50);
  const programs: string[] = [];
  page.on("message", (data) => {
    const message = JSON.parse(data.toString());
    if (message.type !== "program") return;
    programs.push(message.code);
    const ok = !message.code.includes("BAD");
    page.send(JSON.stringify({ type: "result", id: message.id, ok, error: ok ? undefined : "BAD is not defined" }));
  });

  const drums = await call("strudel_set_block", { name: "drums", code: 's("bd*2 sd")' });
  assert.equal(drums.isError, false);
  assert.match(drums.text, /Playing on 1 page/);
  assert.equal(programs.at(-1), '// drums\n$: s("bd*2 sd")');

  const bad = await call("strudel_set_block", { name: "keys", code: "BAD" });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /Strudel rejected the "keys" block/);
  assert.match(bad.text, /BAD is not defined/);
  const state = await call("strudel_get_state");
  assert.doesNotMatch(state.text, /keys/, "the rejected block wasn't kept");
  assert.match(state.text, /1 Strudel page open/);

  // A page that opens now gets what's playing, not the rejected program
  const late = await socket("/strudel", `http://127.0.0.1:${port}`);
  const lateInbox = messages(late);
  await sleep(200);
  assert.equal(lateInbox[0].code, '// drums\n$: s("bd*2 sd")');

  await call("strudel_hush");
  await sleep(100);
  assert.equal(lateInbox.at(-1)!.type, "hush");
  page.close();
  late.close();
});

test("viewers on another machine can watch but not press buttons", async (t) => {
  // Reach a second server through this machine's network address, so the
  // connection doesn't come from loopback
  const address = Object.values(os.networkInterfaces())
    .flat()
    .find((i) => i && i.family === "IPv4" && !i.internal)?.address;
  if (!address) {
    t.skip("no network address to test from");
    return;
  }
  const lanPort = await freePort();
  const lan = new Client({ name: "test", version: "1" });
  await lan.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["dist/index.js"],
      env: {
        ...process.env,
        TIDAL_FILE: path.join(tmpDir, "lan.tidal"),
        TIDAL_UI_PORT: String(lanPort),
        TIDAL_UI_HOST: "0.0.0.0",
      } as Record<string, string>,
      stderr: "ignore",
    })
  );
  try {
    let ws: WebSocket | undefined;
    for (let i = 0; i < 50 && !ws; i++) {
      ws = await new Promise<WebSocket | undefined>((resolve) => {
        const s = new WebSocket(`ws://${address}:${lanPort}/events`, { headers: { Origin: `http://${address}:${lanPort}` } });
        const inbox: Inbox = [];
        inboxes.set(s, inbox);
        s.on("message", (data) => inbox.push(JSON.parse(data.toString())));
        s.once("open", () => resolve(s));
        s.once("error", () => resolve(undefined));
      });
      if (!ws) await sleep(100);
    }
    assert.ok(ws, "connected over the network address");
    const inbox = messages(ws);
    await sleep(200);
    assert.equal(inbox[0].canControl, false);
    ws.send(JSON.stringify({ action: "hush" }));
    await sleep(200);
    assert.ok(inbox.some((m) => m.type === "notice" && !m.ok && /only work on the machine/.test(m.message)));
    ws.close();
  } finally {
    await lan.close();
  }
});
