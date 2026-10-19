import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expandPath, findGhci, pathSetting } from "../src/settings.js";

test("path settings lose stray spaces and expand ~ and ${HOME}", () => {
  const home = path.resolve("/home/me");
  assert.equal(pathSetting(" ~/x/BootTidal.hs ", home), path.join(home, "x", "BootTidal.hs"));
  assert.equal(pathSetting("${HOME}/tidal-mcp-output.tidal", home), path.join(home, "tidal-mcp-output.tidal"));
  assert.equal(pathSetting("$HOME/a.tidal", home), path.join(home, "a.tidal"));
  assert.equal(pathSetting("~", home), home);
  assert.equal(pathSetting("  ", home), undefined);
  assert.equal(pathSetting(undefined, home), undefined);
  assert.ok(path.isAbsolute(pathSetting("relative/BootTidal.hs", home)!));
  // Only a leading ~ means home
  assert.equal(expandPath("/a/~b", home), "/a/~b");
});

test("finds ghci in ghcup's folder when it isn't on PATH", { skip: process.platform === "win32" }, async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "tidal-settings-test-"));
  try {
    const empty = findGhci(undefined, { PATH: "", HOME: home }, "darwin");
    assert.equal(empty.path, undefined);
    assert.ok(empty.tried.includes(path.join(home, ".ghcup", "bin", "ghci")));

    const ghci = path.join(home, ".ghcup", "bin", "ghci");
    await fs.mkdir(path.dirname(ghci), { recursive: true });
    await fs.writeFile(ghci, "#!/bin/sh\n", { mode: 0o755 });
    assert.equal(findGhci("ghci", { PATH: "", HOME: home }, "darwin").path, ghci);
    assert.equal(findGhci(" ", { PATH: "", HOME: home }, "darwin").path, ghci);

    // PATH comes first
    const onPath = path.join(home, "bin", "ghci");
    await fs.mkdir(path.dirname(onPath));
    await fs.writeFile(onPath, "#!/bin/sh\n", { mode: 0o755 });
    assert.equal(findGhci(undefined, { PATH: path.join(home, "bin"), HOME: home }, "darwin").path, onPath);

    // A file that can't be run doesn't count
    await fs.chmod(onPath, 0o644);
    assert.equal(findGhci(undefined, { PATH: path.join(home, "bin"), HOME: home }, "darwin").path, ghci);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("a ghci path that's set is used as given, after tidying", () => {
  const home = path.resolve("/home/me");
  assert.deepEqual(findGhci(" ~/.ghcup/bin/ghci ", { HOME: home }), {
    path: path.join(home, ".ghcup/bin/ghci"),
    tried: [path.join(home, ".ghcup/bin/ghci")],
  });
});
