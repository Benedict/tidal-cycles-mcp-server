/** Decodes the subset of OSC that src/osc.ts produces (strings and 32-bit floats). */
export function decodeMessage(buf: Buffer): { address: string; args: Array<string | number> } {
  let offset = 0;
  const readString = () => {
    const end = buf.indexOf(0, offset);
    const text = buf.toString("utf-8", offset, end);
    offset = end + 1 + ((4 - ((end + 1) % 4)) % 4);
    return text;
  };
  const address = readString();
  const tags = readString().slice(1);
  const args = [...tags].map((tag) => {
    if (tag === "s") return readString();
    const value = buf.readFloatBE(offset);
    offset += 4;
    return Math.round(value * 1000) / 1000;
  });
  return { address, args };
}
