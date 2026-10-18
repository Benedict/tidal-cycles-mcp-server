import { spawn, ChildProcess } from "node:child_process";
import { ghciBlock } from "./commands.js";

/**
 * A two-way connection to a GHCi process running Tidal.
 *
 * GHCi's prompt is set to a unique marker, so everything printed between
 * sending a command and the next marker is that command's response. stderr is
 * merged into stdout at the OS level, which keeps GHC's error messages in order
 * with the prompt. Commands are queued so only one is in flight at a time.
 */

const MARKER = "<<tidal-mcp-ready>>";
const MARKER_LINE = `${MARKER}\n`;

/** Tidal (GHC) rejected the code. Nothing was changed. */
export class TidalError extends Error {
  readonly rejected = true;
  constructor(message: string) {
    super(message);
    this.name = "TidalError";
  }
}

const ERROR_START = /^(?:<interactive>|.*?\.hs):\d+:\d+(?:-\d+)?: error:.*$|^\*\*\* Exception:.*$/gm;

/**
 * Pulls the first GHC error or exception out of GHCi output, without the
 * `<interactive>:3:12:` location prefix (which refers to GHCi's own line count).
 * Only the first error is kept: one missing import can cascade into dozens.
 */
export function extractError(output: string): string | undefined {
  const starts = Array.from(output.matchAll(ERROR_START), (m) => m.index!);
  if (starts.length === 0) return undefined;
  return output
    .slice(starts[0], starts[1])
    .replace(/^<interactive>:\d+:\d+(?:-\d+)?: /, "")
    .trim();
}

export interface GhciOptions {
  ghciPath: string;
  bootPath: string;
  startupTimeoutMs?: number;
  commandTimeoutMs?: number;
  log?: (message: string) => void;
}

interface Pending {
  resolve: (output: string) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class GhciSession {
  private child?: ChildProcess;
  private buffer = "";
  private pending?: Pending;
  private booting?: Pending;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly startupTimeoutMs: number;
  private readonly commandTimeoutMs: number;
  private readonly log: (message: string) => void;
  alive = false;

  constructor(private options: GhciOptions) {
    this.startupTimeoutMs = options.startupTimeoutMs ?? 60_000;
    this.commandTimeoutMs = options.commandTimeoutMs ?? 10_000;
    this.log = options.log ?? ((m) => console.error(m));
  }

  /** Starts GHCi and resolves once BootTidal.hs has loaded. */
  start(): Promise<void> {
    this.stop();
    this.buffer = "";

    const { ghciPath, bootPath } = this.options;
    this.log(`[GHCI] Starting ${ghciPath} with ${bootPath}`);

    // Merge stderr into stdout in the shell, so GHC's errors stay in order with the prompt
    const child = process.platform === "win32"
      ? spawn(`"${ghciPath}" -ghci-script "${bootPath}" 2>&1`, {
          shell: true,
          windowsHide: true,
          stdio: ["pipe", "pipe", "inherit"],
        })
      : spawn("/bin/sh", ["-c", 'exec "$0" "$@" 2>&1', ghciPath, "-ghci-script", bootPath], {
          stdio: ["pipe", "pipe", "inherit"],
        });
    this.child = child;

    const ready = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`GHCi didn't finish starting within ${this.startupTimeoutMs / 1000}s`)),
        this.startupTimeoutMs
      );
      this.booting = { resolve, reject, timer };
    });

    child.stdout!.on("data", (data: Buffer) => this.onData(data.toString()));
    child.stdin!.on("error", (err) => {
      // Usually the process is exiting (e.g. ghci wasn't found), and its exit
      // code says more than EPIPE does, so give the exit event a moment first.
      this.log(`[GHCI] Input closed: ${err.message}`);
      setTimeout(() => {
        if (this.child === child) this.fail(new Error(`GHCi input closed: ${err.message}`));
      }, 500).unref();
    });
    child.on("error", (err) => this.fail(new Error(`Couldn't start GHCi (${ghciPath}): ${err.message}`)));
    child.on("exit", (code, signal) => {
      this.log(`[GHCI] Exited with code ${code}, signal ${signal}`);
      const output = this.buffer.trim();
      // The shell exits with 126 or 127 when it can't find or run the program; cmd on
      // Windows uses 9009 or 1, and says the program "is not recognized"
      const notFound =
        code === 126 || code === 127 || code === 9009 || /is not recognized as an internal or external command/.test(output);
      const message = notFound
        ? `Couldn't run ${ghciPath}. Set GHCI_PATH to the full path of ghci.`
        : `GHCi exited (code ${code}${signal ? `, signal ${signal}` : ""})${output ? `:\n${output}` : ""}`;
      this.fail(new Error(message));
      if (this.child === child) this.child = undefined;
    });

    // Each :set prints a prompt when it completes. Setting prompt-cont first
    // means exactly one marker appears once GHCi is ready.
    child.stdin!.write(':set prompt-cont ""\n');
    child.stdin!.write(`:set prompt "${MARKER}\\n"\n`);

    return ready.then((bootOutput) => {
      const error = extractError(bootOutput);
      if (error) {
        this.stop();
        throw new Error(`BootTidal.hs failed to load:\n${error}`);
      }
      this.alive = true;
      this.log("[GHCI] Ready");
    });
  }

  /**
   * Runs code in GHCi and returns what it printed. Throws TidalError if GHC
   * rejected the code.
   */
  run(code: string): Promise<string> {
    const result = this.queue.then(() => this.exec(code));
    this.queue = result.catch(() => undefined);
    return result;
  }

  stop(): void {
    const child = this.child;
    this.child = undefined;
    this.alive = false;
    if (child) {
      if (child.stdin && !child.stdin.destroyed) {
        child.stdin.end();
      }
      if (process.platform === "win32" && child.pid) {
        // Killing the shell would leave ghci running; /T ends its children too
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      } else {
        child.kill();
      }
    }
  }

  private exec(code: string): Promise<string> {
    const child = this.child;
    if (!this.alive || !child?.stdin || child.stdin.destroyed) {
      return Promise.reject(new Error("GHCi isn't running"));
    }

    const block = ghciBlock(code);
    this.log(`[GHCI SEND] ${block}`);

    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        // The marker for this command may still arrive later and would be
        // misattributed, so treat the session as lost.
        this.pending = undefined;
        this.stop();
        reject(new Error(`GHCi didn't respond within ${this.commandTimeoutMs / 1000}s; restarting it`));
      }, this.commandTimeoutMs);

      this.pending = {
        resolve: (output) => {
          const error = extractError(output);
          if (error) {
            reject(new TidalError(error));
          } else {
            resolve(output.trim());
          }
        },
        reject,
        timer,
      };
      child.stdin!.write(`${block}\n`);
    });
  }

  private onData(chunk: string): void {
    // GHCi on Windows ends lines with \r\n
    chunk = chunk.replace(/\r\n/g, "\n");
    // Output that arrives while nothing is waiting is Tidal talking on its own
    // (e.g. "Waiting for SuperDirt"). Log it rather than attribute it to the
    // next command.
    if (!this.pending && !this.booting && !chunk.includes(MARKER)) {
      if (chunk.trim()) this.log(`[GHCI OUTPUT] ${chunk.trim()}`);
      return;
    }

    // A \r\n split across two chunks only joins up here
    this.buffer = (this.buffer + chunk).replace(/\r\n/g, "\n");
    let index: number;
    while ((index = this.buffer.indexOf(MARKER_LINE)) !== -1) {
      const segment = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + MARKER_LINE.length);
      this.complete(segment);
    }
  }

  private complete(segment: string): void {
    const waiter = this.booting ?? this.pending;
    if (this.booting) {
      this.booting = undefined;
    } else {
      this.pending = undefined;
    }
    if (!waiter) {
      if (segment.trim()) this.log(`[GHCI OUTPUT] ${segment.trim()}`);
      return;
    }
    clearTimeout(waiter.timer);
    if (segment.trim()) this.log(`[GHCI OUTPUT] ${segment.trim()}`);
    waiter.resolve(segment);
  }

  private fail(error: Error): void {
    this.alive = false;
    for (const waiter of [this.booting, this.pending]) {
      if (waiter) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
    }
    this.booting = undefined;
    this.pending = undefined;
  }
}
