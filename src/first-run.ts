import * as fs from "node:fs/promises";
import * as path from "node:path";

/**
 * Said once, in the first reply after installing: in GHCi mode the code Claude
 * writes runs on this computer. Patterns are Haskell, and GHCi will run any
 * Haskell, including code that reads or changes your files.
 */
export const FIRST_RUN_NOTICE =
  "Note (shown once): this server runs Tidal in GHCi on this computer, so the code Claude sends runs here, " +
  "with your permissions, as if you'd typed it into Tidal yourself. Tidal code is Haskell, and GHCi will run any Haskell, " +
  "not only patterns. To check code before it runs, turn off \"Run Tidal for me\" (TIDAL_USE_GHCI=false): " +
  "the server then only writes code to a file for you to evaluate in your editor.";

/**
 * True the first time it's called for this marker file, and never again: the
 * marker is created then, and its existence means the notice has been shown.
 * Creating it with "wx" means two servers starting together can't both say it.
 */
export async function claimFirstRun(markerFile: string): Promise<boolean> {
  try {
    await fs.mkdir(path.dirname(markerFile), { recursive: true });
    await fs.writeFile(markerFile, `${new Date().toISOString()}\n`, { flag: "wx" });
    return true;
  } catch {
    // Already shown, or the folder isn't writable: don't nag on every call
    return false;
  }
}
