import type { Layer } from "./layers.js";

/**
 * Keeps layered channels changing between the agent's turns.
 *
 * Every layer that can change gets its own timer with a random interval, so
 * layers drift independently rather than all changing at once. On each tick a
 * layer either switches to another of its variants or, for transforms, may lay
 * out for a while.
 */

export interface AutopilotSettings {
  minSeconds: number;
  maxSeconds: number;
  /** Chance (0–1) that a transform layer lays out when it changes */
  layOutChance: number;
}

export const DEFAULT_AUTOPILOT_SETTINGS: AutopilotSettings = {
  minSeconds: 10,
  maxSeconds: 40,
  layOutChance: 0.3,
};

export type AutopilotStatus = "stopped" | "running" | "paused";

export function validateSettings(settings: AutopilotSettings): void {
  const { minSeconds, maxSeconds, layOutChance } = settings;
  if (!(minSeconds > 0) || !(maxSeconds >= minSeconds)) {
    throw new Error("minSeconds must be positive and maxSeconds must be at least minSeconds");
  }
  if (!(layOutChance >= 0 && layOutChance <= 1)) {
    throw new Error("layOutChance must be between 0 and 1");
  }
}

/**
 * Changes one layer in place. Returns true if anything changed.
 */
export function mutateLayer(
  layer: Layer,
  layOutChance: number,
  random: () => number = Math.random
): boolean {
  if (layer.kind === "transform" && layer.enabled && random() < layOutChance) {
    layer.enabled = false;
    return true;
  }

  const wasEnabled = layer.enabled;
  layer.enabled = true;

  const others = layer.variants.filter((v) => v !== layer.code);
  if (others.length > 0) {
    layer.code = others[Math.floor(random() * others.length)];
    return true;
  }
  return !wasEnabled;
}

function canChange(layer: Layer, layOutChance: number): boolean {
  return layer.variants.length > 1 || (layer.kind === "transform" && layOutChance > 0);
}

export class Autopilot {
  private timers = new Map<string, NodeJS.Timeout>();
  private settings: AutopilotSettings = { ...DEFAULT_AUTOPILOT_SETTINGS };
  status: AutopilotStatus = "stopped";

  constructor(
    private getLayers: () => Map<string, Layer[]>,
    private onChange: (channel: string, layer: Layer) => Promise<void>,
    private random: () => number = Math.random
  ) {}

  getSettings(): AutopilotSettings {
    return { ...this.settings };
  }

  start(overrides: Partial<AutopilotSettings> = {}): void {
    const settings = { ...this.settings, ...overrides };
    validateSettings(settings);
    this.settings = settings;
    this.clearTimers();
    this.status = "running";
    this.sync();
  }

  /** Stops changing layers; whatever is playing keeps playing. */
  pause(): void {
    this.clearTimers();
    if (this.status === "running") {
      this.status = "paused";
    }
  }

  stop(): void {
    this.clearTimers();
    this.status = "stopped";
  }

  /**
   * Starts timers for layers that have appeared and drops timers for layers
   * that have gone. Call after any change to the layers.
   */
  sync(): void {
    if (this.status !== "running") return;

    const live = new Set<string>();
    for (const [channel, layers] of this.getLayers()) {
      for (const layer of layers) {
        if (!canChange(layer, this.settings.layOutChance)) continue;
        const key = `${channel}/${layer.name}`;
        live.add(key);
        if (!this.timers.has(key)) {
          this.schedule(key, channel, layer.name);
        }
      }
    }
    for (const [key, timer] of this.timers) {
      if (!live.has(key)) {
        clearTimeout(timer);
        this.timers.delete(key);
      }
    }
  }

  activeLayerCount(): number {
    return this.timers.size;
  }

  private schedule(key: string, channel: string, name: string): void {
    const { minSeconds, maxSeconds } = this.settings;
    const delay = (minSeconds + this.random() * (maxSeconds - minSeconds)) * 1000;
    const timer = setTimeout(() => this.tick(key, channel, name), delay);
    timer.unref?.();
    this.timers.set(key, timer);
  }

  private async tick(key: string, channel: string, name: string): Promise<void> {
    this.timers.delete(key);
    if (this.status !== "running") return;

    const layer = this.getLayers().get(channel)?.find((l) => l.name === name);
    if (!layer) return;

    const before = { code: layer.code, enabled: layer.enabled };
    if (mutateLayer(layer, this.settings.layOutChance, this.random)) {
      try {
        await this.onChange(channel, layer);
      } catch (error) {
        // Put the layer back so state matches what's actually playing. If
        // Tidal rejected a variant, drop it so it isn't tried again.
        const rejected = (error as { rejected?: boolean }).rejected === true;
        if (rejected && layer.code !== before.code) {
          const bad = layer.code;
          layer.variants = layer.variants.filter((v) => v !== bad);
          console.error(`[AUTOPILOT] Dropped variant Tidal rejected on ${channel}/${name}: ${bad}`);
        }
        layer.code = before.code;
        layer.enabled = before.enabled;
        console.error(`[AUTOPILOT] Failed to update ${channel}: ${error}`);
      }
    }

    if (this.status === "running" && !this.timers.has(key)) {
      this.schedule(key, channel, name);
    }
  }

  private clearTimers(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }
}
