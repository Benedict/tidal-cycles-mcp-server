import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ctrlPortFromBootFile, encodeMessage } from "../src/osc.js";
import { decodeMessage } from "./fixtures/osc-decode.js";

test("encodes /ctrl messages as Tidal expects", () => {
  const bytes = encodeMessage("/ctrl", ["cutoff", 2000]);
  assert.equal(
    bytes.toString("hex"),
    "2f6374726c000000" + "2c736600" + "6375746f66660000" + "44fa0000"
  );
  assert.deepEqual(decodeMessage(encodeMessage("/ctrl", ["vowel", "o"])), { address: "/ctrl", args: ["vowel", "o"] });
});

test("reads the control port from a boot file", async () => {
  assert.equal(ctrlPortFromBootFile(path.resolve(import.meta.dirname, "..", "BootTidal.hs")), 6011);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tidal-osc-test-"));
  await fs.writeFile(path.join(dir, "Boot.hs"), "tidal <- startTidal superdirtTarget defaultConfig");
  assert.equal(ctrlPortFromBootFile(path.join(dir, "Boot.hs")), undefined);
  assert.equal(ctrlPortFromBootFile(path.join(dir, "missing.hs")), undefined);
  await fs.rm(dir, { recursive: true, force: true });
});
