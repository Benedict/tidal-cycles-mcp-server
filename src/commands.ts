/**
 * The Tidal code the server sends. Kept in one place so it can be
 * type-checked against real Tidal in CI (scripts/typecheck-tidal.ts).
 */

// BootTidal.hs binds d1..d9 to pattern IDs 1..9
function channelId(channel: string): string {
  return channel.slice(1);
}

export function evalCommand(channel: string, pattern: string): string {
  return `${channel} $ ${pattern}`;
}

export function silenceCommand(channel: string): string {
  return `${channel} silence`;
}

export function soloCommand(channel: string): string {
  return `solo ${channelId(channel)}`;
}

export function unsoloCommand(channels: string[]): string {
  return channels.map((c) => `unsolo ${channelId(c)}`).join(" >> ");
}

export const HUSH_COMMAND = "hush";

// GHCi reads one line per statement; multi-line code needs a :{ ... :} block
export function ghciBlock(code: string): string {
  return code.includes("\n") ? `:{\n${code}\n:}` : code;
}

// Tidal measures tempo in cycles per second; this assumes four beats per cycle
export function tempoCommand(bpm: number): string {
  return `setcps (${bpm}/60/4)`;
}
