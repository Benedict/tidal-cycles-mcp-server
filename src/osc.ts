import * as dgram from "node:dgram";
import * as fs from "node:fs";

/**
 * Just enough OSC to talk to Tidal's control port (see Sound.Tidal.Stream.Listen).
 * Numbers are sent as 32-bit floats, which `/ctrl` stores for cF to read.
 */

export type OscArg = number | string;

function padded(text: string): Buffer {
  const bytes = Buffer.from(`${text}\0`, "utf-8");
  return Buffer.concat([bytes, Buffer.alloc((4 - (bytes.length % 4)) % 4)]);
}

export function encodeMessage(address: string, args: OscArg[]): Buffer {
  const tags = "," + args.map((a) => (typeof a === "number" ? "f" : "s")).join("");
  const data = args.map((a) => {
    if (typeof a === "string") return padded(a);
    const b = Buffer.alloc(4);
    b.writeFloatBE(a);
    return b;
  });
  return Buffer.concat([padded(address), padded(tags), ...data]);
}

export class OscSender {
  private socket = dgram.createSocket("udp4");

  constructor(private host: string, private port: number) {
    this.socket.unref();
  }

  send(address: string, args: OscArg[]): Promise<void> {
    const message = encodeMessage(address, args);
    return new Promise((resolve, reject) => {
      this.socket.send(message, this.port, this.host, (err) => (err ? reject(err) : resolve()));
    });
  }

  close(): void {
    this.socket.close();
  }

  get target(): string {
    return `${this.host}:${this.port}`;
  }
}

/** Tidal's default control port, used when the boot file doesn't set one */
export const TIDAL_DEFAULT_CTRL_PORT = 6010;

/** The control port a boot file configures with cCtrlPort, if any. */
export function ctrlPortFromBootFile(bootPath: string): number | undefined {
  try {
    const match = fs.readFileSync(bootPath, "utf-8").match(/cCtrlPort\s*=\s*(\d+)/);
    return match ? Number(match[1]) : undefined;
  } catch {
    return undefined;
  }
}
