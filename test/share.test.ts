import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fakeGhci } from "./fixtures/paths.js";
import {
  StatementBuffer,
  isBootStatement,
  parsePlayback,
  stripHighlighting,
  writeGhciWrapper,
} from "../src/share.js";

const root = path.resolve(import.meta.dirname, "..");
// Sharing uses Unix sockets and sh wrappers, so it's off on Windows
const unixOnly = { skip: process.platform === "win32" ? "sharing isn't supported on Windows" : false };

test("groups :{ :} blocks into one statement", () => {
  const buffer = new StatementBuffer();
  assert.equal(buffer.push(":{"), undefined);
  assert.equal(buffer.push('d1 $ s "bd"'), undefined);
  assert.equal(buffer.push('  # n "1"'), undefined);
  assert.equal(buffer.push(":}"), 'd1 $ s "bd"\n  # n "1"');
  assert.equal(buffer.push("hush"), "hush");
});

test("strips Pulsar's highlighting wrappers", () => {
  assert.equal(
    stripHighlighting('d1 $ s (deltaContext 7 0 "bd*2 sd") # n (deltaContext 30 1 "0 1")'),
    'd1 $ s "bd*2 sd" # n "0 1"'
  );
});

test("recognises boot statements that mustn't run twice", () => {
  assert.ok(isBootStatement(":script /Users/me/BootTidal.hs"));
  assert.ok(isBootStatement(':set prompt "tidal> "'));
  assert.ok(isBootStatement("tidal <- startTidal (superdirtTarget) defaultConfig"));
  assert.equal(isBootStatement(':set -XOverloadedStrings'), false);
  assert.equal(isBootStatement('d1 $ s "bd"'), false);
});

test("parses what a statement does to the channels", () => {
  assert.deepEqual(parsePlayback('d2 $ s (deltaContext 5 0 "hh*8")'), { kind: "eval", channel: "d2", pattern: 's "hh*8"' });
  assert.deepEqual(parsePlayback("d3 silence"), { kind: "silence", channel: "d3" });
  assert.deepEqual(parsePlayback("d3 $ silence"), { kind: "silence", channel: "d3" });
  assert.deepEqual(parsePlayback("hush"), { kind: "hush" });
  assert.equal(parsePlayback("setcps 0.5"), undefined);
});

test("writes ghci and ghc-pkg wrappers", unixOnly, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tidal-wrap-test-"));
  const bin = writeGhciWrapper({ dir, attachScript: "/pkg/dist/attach.js", realGhci: "/opt/ghc's/bin/ghci", node: "/usr/bin/node" });
  const ghci = await fs.readFile(path.join(bin, "ghci"), "utf-8");
  assert.match(ghci, /TIDAL_REAL_GHCI='\/opt\/ghc'\\''s\/bin\/ghci'/, "quotes paths for the shell");
  assert.match(ghci, /exec '\/usr\/bin\/node' '\/pkg\/dist\/attach.js' "\$@"/);
  assert.match(await fs.readFile(path.join(bin, "ghc-pkg"), "utf-8"), /exec '\/opt\/ghc'\\''s\/bin\/ghc-pkg'/);
  assert.equal((await fs.stat(path.join(bin, "ghci"))).mode & 0o111, 0o111, "executable");
  await fs.rm(dir, { recursive: true, force: true });
});

// End to end: the server shares its (fake) GHCi, and the wrapper it writes
// is run the way Pulsar runs ghci.

let tmpDir: string;
let logFile: string;
let client: Client;

function runWrapper(bin: string, lines: string[], env: Record<string, string> = {}) {
  return new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve) => {
    const child = spawn(path.join(bin, "ghci"), [], { env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ stdout, stderr, code }));
    child.stdin.end(lines.join("\n") + "\n");
  });
}

async function received(): Promise<string[]> {
  const text = await fs.readFile(logFile, "utf-8").catch(() => "");
  return text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

async function state(): Promise<string> {
  const result = await client.callTool({ name: "tidal_get_state", arguments: {} });
  return (result.content as Array<{ text: string }>).map((c) => c.text).join("\n\n");
}

before(async () => {
  if (process.platform === "win32") return;
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tidal-share-test-"));
  logFile = path.join(tmpDir, "received.log");
  await fs.writeFile(path.join(tmpDir, "BootTidal.hs"), "import Sound.Tidal.Context\n");
  client = new Client({ name: "test", version: "1" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.join(root, "dist", "index.js")],
      env: {
        ...process.env,
        TIDAL_FILE: path.join(tmpDir, "out.tidal"),
        TIDAL_USE_GHCI: "true",
        TIDAL_BOOT_PATH: path.join(tmpDir, "BootTidal.hs"),
        GHCI_PATH: fakeGhci,
        FAKE_GHCI_LOG: logFile,
        TIDAL_SHARE_SESSION: "true",
        TIDAL_SHARE_DIR: path.join(tmpDir, "share"),
      } as Record<string, string>,
      stderr: "ignore",
    })
  );
  // Sharing starts in the background once the server is connected
  for (let i = 0; i < 50; i++) {
    if (await fs.stat(path.join(tmpDir, "share", "ghci.sock")).catch(() => null)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
});

after(async () => {
  if (process.platform === "win32") return;
  await client.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

test("an editor shares the server's Tidal through the wrapper", unixOnly, async () => {
  const bin = path.join(tmpDir, "share", "bin");
  const result = await runWrapper(bin, [
    `:script ${path.join(tmpDir, "BootTidal.hs")}`,
    ":{",
    'd3 $ s (deltaContext 7 0 "bd sd")',
    ":}",
    "d4 $ BAD",
  ]);
  assert.match(result.stdout, /Connected to the Tidal session shared by tidal-mcp-server/);
  assert.match(result.stderr, /Variable not in scope: BAD/);

  const sent = await received();
  assert.ok(sent.includes('d3 $ s (deltaContext 7 0 "bd sd")'), "the editor's code reached GHCi as sent");
  assert.ok(!sent.some((c) => c.startsWith(":script")), "the boot script wasn't run again");

  const text = await state();
  assert.match(text, /d3: s "bd sd"/, "the server knows what the editor played");
  assert.doesNotMatch(text, /d4/);
});

test("a hush from the editor clears the server's state", unixOnly, async () => {
  await runWrapper(path.join(tmpDir, "share", "bin"), ["hush"]);
  assert.match(await state(), /No active patterns/);
});

test("attach falls back to the real ghci when nothing is sharing", unixOnly, async () => {
  const direct = await new Promise<string>((resolve) => {
    const child = spawn(process.execPath, [path.join(root, "dist", "attach.js")], {
      env: { ...process.env, TIDAL_SHARE_SOCKET: path.join(tmpDir, "nobody-here.sock"), TIDAL_REAL_GHCI: fakeGhci },
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("close", () => resolve(out));
    child.stdin.end(":q\n");
  });
  assert.match(direct, /Leaving GHCi/);
});
