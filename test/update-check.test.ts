import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { checkForUpdate, compareVersions } from "../src/update-check.js";

async function fakeRegistry(version: string) {
  let requests = 0;
  const server = http.createServer((_req, res) => {
    requests++;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ name: "tidal-mcp-server", version }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}/latest`, requests: () => requests, close: () => server.close() };
}

test("compares versions, with pre-releases before their release", () => {
  assert.equal(compareVersions("1.10.0", "1.9.9"), 1);
  assert.equal(compareVersions("1.2.0", "1.2.0"), 0);
  assert.equal(compareVersions("1.2.0", "2.0.0"), -1);
  assert.equal(compareVersions("1.2.0-beta.1", "1.2.0"), -1);
  assert.equal(compareVersions("1.2.0", "1.2.0-beta.1"), 1);
});

test("finds a newer release, and asks the registry at most once a day", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tidal-update-test-"));
  const registry = await fakeRegistry("1.3.0");
  try {
    const cacheFile = path.join(dir, "cache", "update-check.json");
    const now = Date.now();
    assert.deepEqual(await checkForUpdate({ current: "1.2.0", cacheFile, url: registry.url, now }), { latest: "1.3.0", newer: true });
    assert.deepEqual(await checkForUpdate({ current: "1.3.0", cacheFile, url: registry.url, now: now + 1000 }), { latest: "1.3.0", newer: false });
    assert.equal(registry.requests(), 1);

    await checkForUpdate({ current: "1.2.0", cacheFile, url: registry.url, now: now + 25 * 60 * 60 * 1000 });
    assert.equal(registry.requests(), 2);
  } finally {
    registry.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("says nothing, quickly, when the registry can't be reached", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tidal-update-test-"));
  try {
    const registry = await fakeRegistry("9.9.9");
    const url = registry.url;
    registry.close();
    const started = Date.now();
    assert.equal(await checkForUpdate({ current: "1.2.0", cacheFile: path.join(dir, "c.json"), url, timeoutMs: 500 }), undefined);
    assert.ok(Date.now() - started < 2000);
    await assert.rejects(fs.stat(path.join(dir, "c.json")));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
