import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SessionLog, sessionLogName } from "../src/session-log.js";

test("the session log is Tidal code under -- comments, and only comments otherwise", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tidal-log-test-"));
  try {
    const file = path.join(dir, "sessions", "one.tidal");
    const log = new SessionLog(file, ["header line"]);
    // Nothing is created until there's something to log
    await assert.rejects(fs.stat(file));

    await log.code("Evaluate pattern on d1", 'd1 $ s "bd"');
    await log.code("Multi-line", 'd2 $ every 2 (fast 2)\n\n  $ s "hh"');
    await log.note("Tidal rejected: d3", "d3 $ BAD\n\nVariable not in scope: BAD");
    const text = await fs.readFile(file, "utf-8");

    const blocks = text.trim().split(/\n\n/);
    assert.equal(blocks[0], "-- header line");
    assert.match(blocks[1], /^-- \d{4}-\d\d-\d\dT[\d:.]+Z Evaluate pattern on d1\nd1 \$ s "bd"$/);
    // Blank lines inside code would split the block for an editor
    assert.match(blocks[2], /Multi-line\nd2 \$ every 2 \(fast 2\)\n  \$ s "hh"$/);
    assert.ok(blocks[3].split("\n").every((line) => line.startsWith("--")), blocks[3]);
    assert.match(blocks[3], /--   d3 \$ BAD/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("the session log is added to, never erased", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tidal-log-test-"));
  try {
    const file = path.join(dir, "kept.tidal");
    await new SessionLog(file, ["first session"]).code("one", "hush");
    await new SessionLog(file, ["second session"]).code("two", "hush");
    const text = await fs.readFile(file, "utf-8");
    assert.match(text, /first session[\s\S]*one\nhush[\s\S]*second session[\s\S]*two\nhush/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("each session gets its own file name, safe on Windows", () => {
  const name = sessionLogName(new Date("2026-10-19T22:54:42.123Z"), 4242);
  assert.equal(name, "session-2026-10-19T22-54-42-4242.tidal");
  assert.notEqual(sessionLogName(new Date(0), 1), sessionLogName(new Date(0), 2));
});
