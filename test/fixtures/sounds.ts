import * as fs from "node:fs/promises";
import * as path from "node:path";

/** A minimal downloaded-quarks folder: a few Dirt-Samples banks and SuperDirt synths. */
export async function makeSoundFixture(quarksDir: string): Promise<void> {
  const samples = path.join(quarksDir, "Dirt-Samples");
  for (const [bank, files] of Object.entries({
    bd: ["BT0A0A7.wav", "BT0A0D0.WAV"],
    sd: ["rytm-01.aif"],
    "808bd": ["BD0000.wav"],
    empty: ["readme.txt"],
    ".git": ["HEAD.wav"],
  })) {
    await fs.mkdir(path.join(samples, bank), { recursive: true });
    for (const file of files) await fs.writeFile(path.join(samples, bank, file), "");
  }
  const library = path.join(quarksDir, "SuperDirt", "library");
  await fs.mkdir(library, { recursive: true });
  await fs.writeFile(
    path.join(library, "default-synths-extra.scd"),
    "SynthDef(\\superpiano,{|out| }).add;\nSynthDef(\\dirt_gate, {}).add;\n"
  );
}
