/**
 * A reference list of Tidal idioms that combine well, returned by the
 * tidal_palette tool. Written for the layer model: transforms go before `$`,
 * controls go after `#`.
 *
 * Every entry is type-checked against real Tidal in CI (scripts/typecheck-tidal.ts).
 */

type Groups = Record<string, string[]>;

export const PALETTE_TRANSFORMS: Groups = {
  Time: ["fast 2", "slow 2", "hurry 2", "(1/8) ~>", "(1/4) <~", "swingBy (1/3) 4", 'rot "<1 2>"'],
  Order: ["rev", "palindrome", "iter 4", "shuffle 4", "scramble 4", "linger 0.25", "trunc 0.75"],
  Repetition: ["ply 2", "echo 3 0.2 0.5", "stutWith 3 (1/8) (# speed 2)", "off 0.25 (# crush 4)"],
  Stereo: ["jux rev", "jux (hurry 2)", "superimpose (fast 2)"],
  Density: ["degrade", "degradeBy 0.3", "sometimes (# speed 2)", "rarely (fast 2)", "often (# crush 4)"],
  Slicing: ["chop 4", "striate 8", "chunk 4 (hurry 2)", "inside 2 rev"],
  Conditional: ["every 3 (jux rev)", "every 4 (0.25 <~)", "whenmod 8 6 (rev)", "whenmod 7 5 (# speed 2)"],
};

export const PALETTE_SOURCES: Groups = {
  Rhythm: ['s "bd*2 [~ sd] hh*3"', 's "bd(3,8) sn(5,8,2)"', 's "<bd*2 bd(3,8)>"', 's "amencutup*8" # n (irand 32)'],
  Pitched: ['n "0 .. 7" # s "arpy"', 'note "c\'maj e\'min" # s "superpiano"', 'note (scale "dorian" "0 2 4 <6 7>") # s "arpy"'],
  Techno: ['stack [s "bd*4", s "hh*8" # gain 0.5, s "~ cp" # gain 0.7]'],
  House: ['stack [s "bd*4", s "~ hh ~ hh" # gain 0.6, s "~ cp ~ cp" # gain 0.7]'],
  "Drum & bass": ['stack [s "bd ~ ~ bd ~ ~ bd ~", s "~ sn ~ sn" # gain 0.9, s "hh*16" # gain 0.4]'],
  Trap: ['stack [s "808bd(3,8)", s "~ 808sd", s "808hc*8" # gain 0.5]'],
  Jazz: ['stack [s "bd ~ ~ bd", s "rs(3,8)" # gain 0.6, s "hh(5,8)" # gain 0.4]'],
  Bass: ['s "bass3(3,8)" # speed 0.5 # lpf 1000', 's "bass3*4" # speed "<0.5 0.75 0.5 1>" # lpf 1200 # resonance 0.3'],
};

export const PALETTE_CONTROLS: Groups = {
  Sample: ['n "0 1 2 3"', "n (irand 8)", 'speed "1 2 -1"', "begin 0.25", "end 0.5", "cut 1", "legato 1"],
  Tone: ["lpf 2000", "hpf 300", "resonance 0.2", 'vowel "a e o"', "crush 4", 'coarse "1 4"', "shape 0.5"],
  Space: ["pan sine", "pan rand", "room 0.3 # size 0.8", "delay 0.25 # delaytime (1/8) # delayfeedback 0.5"],
  Level: ["gain 1.1", "gain (range 0.8 1.2 sine)"],
  Movement: ["lpf (range 200 4000 $ slow 8 sine)", "speed (range 0.5 2 rand)"],
  // Read values set with tidal_set_control (the number is the default until it's set)
  External: ['lpf (cF 1000 "cutoff")', 'gain (cF 1 "level")', 'speed (cF 1 "pitch")', 'vowel (cS "a" "vowel")'],
};

function renderGroups(groups: Groups): string {
  const width = Math.max(...Object.keys(groups).map((k) => k.length)) + 2;
  return Object.entries(groups)
    .map(([name, entries]) => `  ${`${name}:`.padEnd(width)}${entries.join(" · ")}`)
    .join("\n");
}

export const PALETTE = `Tidal palette (checked against Tidal 1.10).

TRANSFORMS (layer kind "transform"; each is applied as "<code> $")
${renderGroups(PALETTE_TRANSFORMS)}

SOURCES (layer kind "source"; exactly one per channel)
${renderGroups(PALETTE_SOURCES)}

CONTROLS (layer kind "control"; each is applied as "# <code>")
${renderGroups(PALETTE_CONTROLS)}

NOTES
  - Don't set orbit: BootTidal.hs gives each channel its own.
  - room, size and delay are per orbit, so they affect everything on that channel.
  - Variants work best when they keep the same shape, such as one transform swapped
    for another or a different rhythm in the same source.`;
