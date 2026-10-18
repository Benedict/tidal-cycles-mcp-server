import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Lets an editor share the server's Tidal session.
 *
 * The server listens on a Unix socket that only the current user can open.
 * The editor runs a `ghci` wrapper (written by writeGhciWrapper) instead of
 * the real ghci; the wrapper runs dist/attach.js, which forwards each GHCi
 * statement over the socket and prints the response. Messages are one JSON
 * object per line: {"code"} from the editor, {"output", "error"?} back.
 */

export interface ShareResponse {
  output: string;
  error?: string;
}

export function defaultShareDir(): string {
  return process.env.TIDAL_SHARE_DIR || path.join(os.homedir(), ".tidal-mcp");
}

export function socketPathIn(dir: string): string {
  return path.join(dir, "ghci.sock");
}

/**
 * Groups GHCi input lines into statements: `:{ ... :}` is one statement,
 * any other line is one on its own.
 */
export class StatementBuffer {
  private block: string[] | null = null;

  /** Returns a complete statement, or undefined while inside a block. */
  push(line: string): string | undefined {
    if (this.block) {
      if (line.trim() === ":}") {
        const code = this.block.join("\n");
        this.block = null;
        return code;
      }
      this.block.push(line);
      return undefined;
    }
    if (line.trim() === ":{") {
      this.block = [];
      return undefined;
    }
    return line;
  }
}

/** Pulsar's event highlighting wraps strings as (deltaContext offset id "…"). */
export function stripHighlighting(code: string): string {
  return code.replace(/\(deltaContext\s+-?\d+\s+-?\d+\s+("(?:[^"\\]|\\.)*")\)/g, "$1");
}

/**
 * Statements an editor sends while booting that must not run again: the
 * server has already loaded BootTidal.hs, and a second startTidal would
 * start a second Tidal.
 */
export function isBootStatement(code: string): boolean {
  const trimmed = code.trim();
  return /^:script\b/.test(trimmed) || /^:set\s+prompt/.test(trimmed) || /\b(startTidal|mkTidal)\b/.test(code);
}

export type Playback =
  | { kind: "eval"; channel: string; pattern: string }
  | { kind: "silence"; channel: string }
  | { kind: "hush" };

/** What a statement does to the channels, if it's one the server can track. */
export function parsePlayback(code: string): Playback | undefined {
  const text = stripHighlighting(code).trim();
  if (/^hush$/.test(text)) return { kind: "hush" };
  const silence = text.match(/^(d[1-9])\s*(?:\$\s*)?silence$/);
  if (silence) return { kind: "silence", channel: silence[1] };
  const evaluated = text.match(/^(d[1-9])\s*\$\s*([\s\S]+)$/);
  if (evaluated) return { kind: "eval", channel: evaluated[1], pattern: evaluated[2].trim() };
  return undefined;
}

export class ShareServer {
  private server?: net.Server;

  constructor(
    private socketPath: string,
    private handle: (code: string) => Promise<ShareResponse>,
    private log: (message: string) => void = (m) => console.error(m)
  ) {}

  /** Starts listening. Returns false if another server already owns the socket. */
  async start(): Promise<boolean> {
    fs.mkdirSync(path.dirname(this.socketPath), { recursive: true, mode: 0o700 });

    if (fs.existsSync(this.socketPath)) {
      if (await isListening(this.socketPath)) {
        this.log(`[SHARE] ${this.socketPath} is in use by another server; not sharing`);
        return false;
      }
      fs.unlinkSync(this.socketPath); // left over from a server that didn't shut down cleanly
    }

    const server = net.createServer((socket) => this.serve(socket));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.socketPath, () => resolve());
    });
    fs.chmodSync(this.socketPath, 0o600);
    server.unref();
    this.server = server;
    this.log(`[SHARE] Sharing the Tidal session on ${this.socketPath}`);
    return true;
  }

  stop(): void {
    this.server?.close();
    this.server = undefined;
    try {
      fs.unlinkSync(this.socketPath);
    } catch {
      // already gone
    }
  }

  private serve(socket: net.Socket): void {
    let buffered = "";
    // Responses go back in the order statements arrived
    let queue: Promise<unknown> = Promise.resolve();

    socket.on("data", (data) => {
      buffered += data.toString();
      let index: number;
      while ((index = buffered.indexOf("\n")) !== -1) {
        const line = buffered.slice(0, index);
        buffered = buffered.slice(index + 1);
        if (!line.trim()) continue;
        let code: string;
        try {
          code = JSON.parse(line).code;
        } catch {
          continue;
        }
        queue = queue.then(async () => {
          const response = await this.handle(code).catch((e: Error) => ({ output: "", error: e.message }));
          if (!socket.destroyed) socket.write(JSON.stringify(response) + "\n");
        });
      }
    });
    socket.on("error", (err) => this.log(`[SHARE] Connection error: ${err.message}`));
  }
}

function isListening(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.connect(socketPath);
    probe.once("connect", () => {
      probe.destroy();
      resolve(true);
    });
    probe.once("error", () => resolve(false));
  });
}

function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/** Finds a program on PATH, skipping one directory (our own wrapper's). */
export function findOnPath(program: string, skipDir?: string): string | undefined {
  if (path.isAbsolute(program)) return program;
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir || (skipDir && path.resolve(dir) === path.resolve(skipDir))) continue;
    const candidate = path.join(dir, program);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // not here
    }
  }
  return undefined;
}

/**
 * Writes `ghci` and `ghc-pkg` wrappers into <dir>/bin. An editor pointed at
 * that folder shares the server's session, or gets the real ghci when the
 * server isn't running. Returns the bin folder.
 */
export function writeGhciWrapper(options: {
  dir: string;
  attachScript: string;
  realGhci: string;
  node?: string;
}): string {
  const bin = path.join(options.dir, "bin");
  fs.mkdirSync(bin, { recursive: true, mode: 0o700 });
  const realGhci = findOnPath(options.realGhci, bin) ?? options.realGhci;
  const node = options.node ?? process.execPath;

  const header = "#!/bin/sh\n# Written by tidal-mcp-server; rewritten each time it starts with TIDAL_SHARE_SESSION=true.\n";
  const ghci =
    header +
    "# Shares the server's Tidal session, or runs the real ghci when the server isn't running.\n" +
    `TIDAL_SHARE_SOCKET=${shellQuote(socketPathIn(options.dir))} TIDAL_REAL_GHCI=${shellQuote(realGhci)} ` +
    `exec ${shellQuote(node)} ${shellQuote(options.attachScript)} "$@"\n`;
  // Editors also run ghc-pkg from the same folder, e.g. to find Tidal's install
  const ghcPkg = header + `exec ${shellQuote(path.join(path.dirname(realGhci), "ghc-pkg"))} "$@"\n`;

  for (const [name, text] of [["ghci", ghci], ["ghc-pkg", ghcPkg]]) {
    fs.writeFileSync(path.join(bin, name), text, { mode: 0o755 });
    fs.chmodSync(path.join(bin, name), 0o755);
  }
  return bin;
}
