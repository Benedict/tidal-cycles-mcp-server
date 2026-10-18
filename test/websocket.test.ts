import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, ChildProcess } from "node:child_process";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import WebSocket from "ws";

// Runs the built server with the WebSocket transport and talks to it as two clients.

let tmpDir: string;
let server: ChildProcess;
let port: number;

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

async function connect(headers: Record<string, string> = {}): Promise<WebSocket> {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      return await new Promise<WebSocket>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers });
        ws.once("open", () => resolve(ws));
        ws.once("error", reject);
        ws.once("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
      });
    } catch (error) {
      if (/HTTP/.test((error as Error).message)) throw error;
      await new Promise((r) => setTimeout(r, 100)); // server still starting
    }
  }
  throw new Error("server didn't start");
}

/** Collects JSON-RPC messages a client receives (ignoring the server's own broadcasts). */
function inbox(ws: WebSocket): unknown[] {
  const messages: unknown[] = [];
  ws.on("message", (data) => {
    const message = JSON.parse(data.toString());
    if (message.jsonrpc) messages.push(message);
  });
  return messages;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tidal-ws-test-"));
  port = await freePort();
  server = spawn(process.execPath, ["dist/index.js"], {
    env: {
      ...process.env,
      TIDAL_TRANSPORT: "websocket",
      TIDAL_WS_PORT: String(port),
      TIDAL_WS_HOST: "127.0.0.1",
      TIDAL_FILE: path.join(tmpDir, "out.tidal"),
    },
    stdio: "ignore",
  });
});

after(async () => {
  server.kill();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

test("each client gets only its own replies, with its own ids", async () => {
  const a = await connect();
  const b = await connect();
  const fromA = inbox(a);
  const fromB = inbox(b);

  // Both use id 1, which used to collide
  a.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
  b.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "tidal_get_state", arguments: {} } }));
  await sleep(300);

  assert.equal(fromA.length, 1);
  assert.equal(fromB.length, 1);
  const [ra] = fromA as Array<{ id: number; result: { tools?: unknown[] } }>;
  const [rb] = fromB as Array<{ id: number; result: { content?: unknown[] } }>;
  assert.equal(ra.id, 1);
  assert.ok(Array.isArray(ra.result.tools), "A got the tool list");
  assert.equal(rb.id, 1);
  assert.ok(Array.isArray(rb.result.content), "B got the state");
  a.close();
  b.close();
});

test("refuses browser pages unless their origin is allowed", async () => {
  await assert.rejects(connect({ Origin: "https://example.com" }), /HTTP 401|HTTP 403/);
});
