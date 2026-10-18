import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  defaultQuarksDir,
  describeLibrary,
  extractSoundNames,
  loadSoundLibrary,
  unknownSounds,
} from "../src/samples.js";
import { makeSoundFixture } from "./fixtures/sounds.js";

let tmpDir: string;

before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tidal-samples-test-"));
  await makeSoundFixture(path.join(tmpDir, "quarks"));
  await fs.mkdir(path.join(tmpDir, "mine", "voice"), { recursive: true });
  await fs.writeFile(path.join(tmpDir, "mine", "voice", "hello.flac"), "");
});

after(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

test("finds the quarks folder for each platform", () => {
  assert.equal(
    defaultQuarksDir("/h", "darwin"),
    path.join("/h", "Library", "Application Support", "SuperCollider", "downloaded-quarks")
  );
  assert.equal(defaultQuarksDir("/h", "linux"), path.join("/h", ".local", "share", "SuperCollider", "downloaded-quarks"));
});

test("reads banks, sample counts and synths", () => {
  const lib = loadSoundLibrary({ quarksDir: path.join(tmpDir, "quarks"), extraPaths: [path.join(tmpDir, "mine")] });
  assert.equal(lib.banks.get("bd"), 2);
  assert.equal(lib.banks.get("808bd"), 1);
  assert.equal(lib.banks.get("voice"), 1);
  assert.equal(lib.banks.has("empty"), false, "folders with no audio aren't banks");
  assert.equal(lib.banks.has(".git"), false);
  assert.ok(lib.synths.has("superpiano"));
  assert.equal(lib.synths.has("dirt_gate"), false, "internal modules aren't instruments");
  assert.equal(lib.sources.length, 2);
});

test("extracts sound names from s and sound strings only", () => {
  assert.deepEqual(
    extractSoundNames('stack [s "bd*2 [~ sd:3] hh(3,8)", sound "<808bd superpiano>" # n "1 2" # vowel "a"]'),
    ["bd", "sd", "hh", "808bd", "superpiano"]
  );
  assert.deepEqual(extractSoundNames('n "0 .. 7" # s "~ ~"'), []);
});

test("unknownSounds flags names SuperDirt doesn't have", () => {
  const lib = loadSoundLibrary({ quarksDir: path.join(tmpDir, "quarks") });
  assert.deepEqual(unknownSounds('stack [s "bd rim", s "tom:1 superpiano"]', lib), ["rim", "tom"]);
});

test("unknownSounds says nothing when the library can't be found", () => {
  const lib = loadSoundLibrary({ quarksDir: path.join(tmpDir, "nowhere") });
  assert.deepEqual(unknownSounds('s "anything"', lib), []);
  assert.match(describeLibrary(lib), /Couldn't find any sample banks/);
});

test("describeLibrary lists and filters", () => {
  const lib = loadSoundLibrary({ quarksDir: path.join(tmpDir, "quarks") });
  const all = describeLibrary(lib);
  assert.match(all, /3 sample banks/);
  assert.match(all, /bd \(2\)/);
  assert.match(all, /superpiano/);
  const filtered = describeLibrary(lib, "808");
  assert.match(filtered, /1 sample bank matching "808"/);
  assert.doesNotMatch(filtered, /superpiano/);
});
