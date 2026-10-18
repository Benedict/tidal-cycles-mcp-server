import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fakeGhci } from "./fixtures/paths.js";
import { GhciSession, TidalError, extractError } from "../src/ghci.js";


let tmpDir: string;
let logFile: string;
let session: GhciSession | undefined;
const logs: string[] = [];

function makeSession(boot = "BootTidal.hs", commandTimeoutMs = 2000) {
  session = new GhciSession({
    ghciPath: fakeGhci,
    bootPath: path.join(tmpDir, boot),
    commandTimeoutMs,
    log: (m) => logs.push(m),
  });
  return session;
}

async function received(): Promise<string[]> {
  const text = await fs.readFile(logFile, "utf-8").catch(() => "");
  return text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tidal-ghci-test-"));
  logFile = path.join(tmpDir, "received.log");
  process.env.FAKE_GHCI_LOG = logFile;
  logs.length = 0;
});

afterEach(async () => {
  session?.stop();
  session = undefined;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

test("extractError keeps the first error and drops GHCi's location prefix", () => {
  const output =
    "<interactive>:3:12: error: [GHC-39999]\n    • No instance for ‘Num [Char]’\n\n" +
    "<interactive>:3:20: error: [GHC-88464]\n    Variable not in scope: x\n";
  assert.equal(extractError(output), "error: [GHC-39999]\n    • No instance for ‘Num [Char]’");
  assert.equal(extractError("all fine"), undefined);
  assert.match(extractError("*** Exception: divide by zero")!, /divide by zero/);
});

test("starts, sets the prompt marker and runs commands", async () => {
  const s = makeSession();
  await s.start();
  assert.equal(s.alive, true);
  assert.equal(await s.run('d1 $ s "bd"'), "");
  const sent = await received();
  assert.deepEqual(sent.slice(0, 2), [':set prompt-cont ""', ':set prompt "<<tidal-mcp-ready>>\\n"']);
  assert.equal(sent[2], 'd1 $ s "bd"');
});

test("returns GHC errors as TidalError", async () => {
  const s = makeSession();
  await s.start();
  await assert.rejects(s.run("d1 $ BAD"), (err: Error) => {
    assert.ok(err instanceof TidalError);
    assert.match(err.message, /Variable not in scope: BAD/);
    assert.doesNotMatch(err.message, /<interactive>/);
    return true;
  });
  // The session is still usable afterwards
  assert.equal(await s.run('d1 $ s "sn"'), "");
});

test("understands Windows line endings", async () => {
  process.env.FAKE_GHCI_CRLF = "1";
  try {
    const s = makeSession();
    await s.start();
    assert.equal(await s.run('d1 $ s "bd"'), "");
    await assert.rejects(s.run("d1 $ BAD"), /Variable not in scope: BAD/);
  } finally {
    delete process.env.FAKE_GHCI_CRLF;
  }
});

test("sends multi-line code as one :{ :} block", async () => {
  const s = makeSession();
  await s.start();
  await s.run('d1 $ s "bd"\n  # n "1"');
  assert.equal((await received()).at(-1), 'd1 $ s "bd"\n  # n "1"');
});

test("queues concurrent commands in order", async () => {
  const s = makeSession();
  await s.start();
  await Promise.all([s.run("d1 $ a"), s.run("d2 $ b"), s.run("d3 $ c")]);
  assert.deepEqual((await received()).slice(-3), ["d1 $ a", "d2 $ b", "d3 $ c"]);
});

test("logs unprompted output instead of attributing it to the next command", async () => {
  const s = makeSession();
  await s.start();
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(await s.run("d1 $ a"), "");
  assert.ok(logs.some((l) => l.includes("Waiting for SuperDirt")));
});

test("fails to start when BootTidal.hs doesn't load", async () => {
  const s = makeSession("broken-BootTidal.hs");
  await assert.rejects(s.start(), /BootTidal.hs failed to load:[\s\S]*Could not find module/);
  assert.equal(s.alive, false);
});

test("fails to start when ghci doesn't exist", async () => {
  session = new GhciSession({
    ghciPath: path.join(tmpDir, "no-such-ghci"),
    bootPath: "BootTidal.hs",
    log: () => {},
  });
  await assert.rejects(session.start(), /Couldn't run .*no-such-ghci\. Set GHCI_PATH/);
});

test("a command that never finishes times out and stops the session", async () => {
  const s = makeSession("BootTidal.hs", 200);
  await s.start();
  await assert.rejects(s.run("HANG"), /didn't respond/);
  assert.equal(s.alive, false);
  await assert.rejects(s.run("d1 $ a"), /isn't running/);
});

test("reports a crash to the waiting command", async () => {
  const s = makeSession();
  await s.start();
  await assert.rejects(s.run("CRASH"), /GHCi exited \(code 1\)/);
  assert.equal(s.alive, false);
});
