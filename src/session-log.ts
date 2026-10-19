import * as fs from "node:fs/promises";
import * as path from "node:path";

/**
 * The session log, written as a .tidal file: each entry is the Tidal code the
 * server ran, under a `-- time what` comment, with a blank line between
 * entries. Open it in your editor and evaluate any block to replay that moment.
 * Anything that isn't Tidal code (rejected code, Strudel, autopilot settings)
 * is commented out, so the whole file stays safe to evaluate.
 *
 * The file is appended to, never truncated, and only created with the first
 * entry, so a server that's never used leaves nothing behind.
 */
export class SessionLog {
  private writes: Promise<void> = Promise.resolve();
  private started = false;

  constructor(
    readonly file: string,
    private readonly header: string[],
    private readonly onError: (error: unknown) => void = (e) => console.error(`Failed to write to log file: ${e}`)
  ) {}

  /** Tidal code that ran, so it can be replayed. */
  code(what: string, code: string): Promise<void> {
    // A blank line would split the entry in two for editors that evaluate blocks
    const body = code.split(/\r?\n/).filter((line) => line.trim() !== "").join("\n");
    return this.append(`${stamp(what)}\n${body}\n\n`);
  }

  /** Something that isn't code to replay; every line is a comment. */
  note(what: string, details?: string): Promise<void> {
    const lines = details ? details.split(/\r?\n/).map((line) => `--   ${line}`.trimEnd()) : [];
    return this.append([stamp(what), ...lines].join("\n") + "\n\n");
  }

  private append(entry: string): Promise<void> {
    const write = this.writes.then(async () => {
      if (!this.started) {
        await fs.mkdir(path.dirname(this.file), { recursive: true });
        const header = this.header.map((line) => `-- ${line}`).join("\n");
        await fs.appendFile(this.file, `${header}\n\n`, "utf-8");
        this.started = true;
      }
      await fs.appendFile(this.file, entry, "utf-8");
    });
    this.writes = write.catch(this.onError);
    return this.writes;
  }
}

function stamp(what: string): string {
  return `-- ${new Date().toISOString()} ${what.replace(/\s*\r?\n\s*/g, " ")}`;
}

/** A file name for a new session's log: the start time (and process, as two can start together). */
export function sessionLogName(start = new Date(), pid = process.pid): string {
  // No colons, for Windows
  return `session-${start.toISOString().slice(0, 19).replace(/:/g, "-")}-${pid}.tidal`;
}
