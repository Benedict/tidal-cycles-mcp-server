import * as fs from "node:fs/promises";
import * as path from "node:path";

/**
 * Whether a newer release is on npm. A Claude Desktop bundle never updates
 * itself, so tidal_status says when there's something newer. Checks at most
 * once a day (the answer is cached), and gives up quickly when offline.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
export const REGISTRY_URL = "https://registry.npmjs.org/tidal-mcp-server/latest";

export interface UpdateCheckOptions {
  current: string;
  cacheFile: string;
  url?: string;
  timeoutMs?: number;
  now?: number;
}

export interface UpdateInfo {
  latest: string;
  newer: boolean;
}

interface Cache {
  checkedAt: number;
  latest: string;
}

/** The latest release, or undefined if it couldn't be found out. Never throws. */
export async function checkForUpdate(options: UpdateCheckOptions): Promise<UpdateInfo | undefined> {
  const { current, cacheFile, url = REGISTRY_URL, timeoutMs = 3000, now = Date.now() } = options;

  let latest: string | undefined;
  try {
    const cache = JSON.parse(await fs.readFile(cacheFile, "utf-8")) as Cache;
    if (now - cache.checkedAt < DAY_MS && typeof cache.latest === "string") latest = cache.latest;
  } catch {
    // No cache yet, or unreadable: ask the registry
  }

  if (!latest) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) return undefined;
      const body = (await response.json()) as { version?: unknown };
      if (typeof body.version !== "string") return undefined;
      latest = body.version;
      await fs.mkdir(path.dirname(cacheFile), { recursive: true });
      await fs.writeFile(cacheFile, JSON.stringify({ checkedAt: now, latest } satisfies Cache));
    } catch {
      return undefined;
    }
  }

  return { latest, newer: compareVersions(latest, current) > 0 };
}

/** Compares x.y.z versions; a pre-release (1.2.0-beta) counts as older than its release. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [main, pre] = v.split("-", 2);
    return { parts: main.split(".").map((n) => Number(n) || 0), pre };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (x.parts[i] ?? 0) - (y.parts[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  if (x.pre && !y.pre) return -1;
  if (!x.pre && y.pre) return 1;
  return 0;
}
