import * as path from "node:path";

/** The fake ghci, runnable on every platform (Windows can't run a .mjs directly). */
export const fakeGhci = path.resolve(
  import.meta.dirname,
  process.platform === "win32" ? "fake-ghci.cmd" : "fake-ghci.mjs"
);
