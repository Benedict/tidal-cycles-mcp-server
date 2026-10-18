#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import * as fs from "fs/promises";
import { readFileSync } from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { WebSocketServerTransport } from "./websocket-transport.js";
import {
  Layer,
  LayerKind,
  LAYER_KINDS,
  composePattern,
  describeLayers,
  removeLayer,
  setLayer,
} from "./layers.js";
import { Autopilot, AutopilotSettings } from "./autopilot.js";
import { PALETTE } from "./palette.js";
import { GhciSession, TidalError } from "./ghci.js";
import { SoundLibrary, describeLibrary, loadSoundLibrary, unknownSounds } from "./samples.js";
import { OscSender, TIDAL_DEFAULT_CTRL_PORT, ctrlPortFromBootFile } from "./osc.js";
import {
  ShareResponse,
  ShareServer,
  defaultShareDir,
  isBootStatement,
  parsePlayback,
  socketPathIn,
  stripHighlighting,
  writeGhciWrapper,
} from "./share.js";
import {
  HUSH_COMMAND,
  evalCommand,
  ghciBlock,
  silenceCommand,
  soloCommand,
  tempoCommand,
  unsoloCommand,
} from "./commands.js";

/**
 * TidalCycles MCP Server
 *
 * Enables Claude to control TidalCycles through structured tool calls.
 * Provides conversational live coding with state awareness.
 */

interface ChannelState {
  channel: string;
  pattern: string;
  timestamp: number;
  active: boolean;
}

interface TidalConfig {
  tidalFile: string;
  bootTidalPath?: string;
  useGhci: boolean;
  logFile?: string;
  transport: 'stdio' | 'websocket';
  websocketPort?: number;
  websocketHost?: string;
  websocketAllowedOrigins?: string[];
}

// The package root, for files that ship with it (package.json, BootTidal.hs)
const PACKAGE_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const VERSION: string = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf-8")).version;
const DEFAULT_BOOT_PATH = path.join(PACKAGE_ROOT, "BootTidal.hs");

const CONTROL_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_RAMP_SECONDS = 300;
const RAMP_STEPS_PER_SECOND = 20;

const CHANNELS = ["d1", "d2", "d3", "d4", "d5", "d6", "d7", "d8", "d9"];
const MAX_HISTORY = 500;

function assertChannel(channel: unknown): asserts channel is string {
  if (typeof channel !== "string" || !CHANNELS.includes(channel)) {
    throw new Error(`Invalid channel: ${channel}. Must be one of ${CHANNELS.join(", ")}`);
  }
}

class TidalMCPServer {
  private server: Server;
  private channels: Map<string, ChannelState> = new Map();
  private config: TidalConfig;
  private ghci?: GhciSession;
  private ghciStarting?: Promise<void>;
  private patternHistory: Array<{ channel: string; pattern: string; timestamp: number }> = [];
  private logFile: string;
  private wsTransport?: WebSocketServerTransport;
  private soloedChannels: Set<string> = new Set();
  private layers: Map<string, Layer[]> = new Map();
  private autopilot: Autopilot;
  private isShuttingDown: boolean = false;
  private bpm?: number;
  private soundLibrary?: SoundLibrary;
  private osc?: OscSender;
  private controls: Map<string, number | string> = new Map();
  private ramps: Map<string, NodeJS.Timeout> = new Map();
  /** Counts hushes, so a pattern still being sent when one happens isn't recorded as playing */
  private hushes = 0;
  private fileWrites: Promise<void> = Promise.resolve();
  private share?: ShareServer;

  constructor(config: TidalConfig) {
    this.config = config;
    // Set log file path - same directory as the tidal output file
    const tidalDir = path.dirname(config.tidalFile);
    this.logFile = config.logFile || path.join(tidalDir, "tidal-mcp-session.log");

    this.server = new Server(
      {
        name: "tidal-mcp-server",
        version: VERSION,
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    // Initialize all channels as inactive
    for (let i = 1; i <= 9; i++) {
      this.channels.set(`d${i}`, {
        channel: `d${i}`,
        pattern: "",
        timestamp: 0,
        active: false,
      });
    }

    this.autopilot = new Autopilot(
      () => this.layers,
      async (channel, layer) => {
        const layers = this.layers.get(channel)!;
        if (!layers.some((l) => l.kind === "source")) return;
        const change = layer.enabled ? `${layer.name} → ${layer.code}` : `${layer.name} laid out`;
        await this.play(channel, composePattern(layers), `Autopilot: ${change}`);
      }
    );

    this.setupToolHandlers();

    // Error handling
    this.server.onerror = (error) => console.error("[MCP Error]", error);
    const shutdown = async () => {
      if (this.isShuttingDown) return;
      this.isShuttingDown = true;
      await this.cleanup();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    process.on("SIGHUP", shutdown);
    // The MCP client closing stdin means it has gone away; don't orphan GHCi
    if (config.transport === "stdio") {
      process.stdin.on("end", shutdown);
    }
  }

  /**
   * Logs a pattern evaluation to the human-readable log file
   */
  private async logPatternEvaluation(request: string, channel: string, pattern: string) {
    const timestamp = new Date().toISOString();
    const fullPattern = evalCommand(channel, pattern);

    const logEntry = `${timestamp}
REQUEST: ${request}
RESPONSE: ${fullPattern}
---

`;

    try {
      await fs.appendFile(this.logFile, logEntry, 'utf-8');
    } catch (error) {
      console.error(`Failed to write to log file: ${error}`);
    }
  }

  /**
   * Logs other actions (hush, silence, etc.) to the log file
   */
  private async logAction(action: string, details?: string) {
    const timestamp = new Date().toISOString();

    const logEntry = `${timestamp}
ACTION: ${action}${details ? '\nDETAILS: ' + details : ''}
---

`;

    try {
      await fs.appendFile(this.logFile, logEntry, 'utf-8');
    } catch (error) {
      console.error(`Failed to write to log file: ${error}`);
    }
  }

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "tidal_eval",
          description: "Evaluate a TidalCycles pattern on a specific channel (d1-d9). Replaces anything on that channel, including its layers. To build a channel you can edit piece by piece, use tidal_set_layer instead.",
          inputSchema: {
            type: "object",
            properties: {
              channel: {
                type: "string",
                description: "The channel to evaluate on (d1, d2, ... d9)",
                enum: CHANNELS,
              },
              pattern: {
                type: "string",
                description: "The TidalCycles pattern to evaluate (without the 'd1 $' prefix)",
              },
            },
            required: ["channel", "pattern"],
          },
        },
        {
          name: "tidal_hush",
          description: "Stop all currently playing patterns immediately. Use this to clear everything.",
          inputSchema: {
            type: "object",
            properties: {},
          },
        },
        {
          name: "tidal_silence",
          description: "Stop a specific channel. More graceful than hush for single channels.",
          inputSchema: {
            type: "object",
            properties: {
              channel: {
                type: "string",
                description: "The channel to silence (d1-d9)",
                enum: CHANNELS,
              },
            },
            required: ["channel"],
          },
        },
        {
          name: "tidal_get_state",
          description: "Get the current state of all channels - what patterns are playing and when they started.",
          inputSchema: {
            type: "object",
            properties: {
              quiet: {
                type: "boolean",
                description: "Don't log this call. For clients that poll the state often.",
              },
            },
          },
        },
        {
          name: "tidal_set_tempo",
          description: "Set the tempo in beats per minute, assuming four beats per cycle (setcps (bpm/60/4)).",
          inputSchema: {
            type: "object",
            properties: {
              bpm: {
                type: "number",
                description: "Beats per minute, from 20 to 999",
              },
            },
            required: ["bpm"],
          },
        },
        {
          name: "tidal_solo",
          description: "Solo a specific channel, muting all others until tidal_unsolo is called.",
          inputSchema: {
            type: "object",
            properties: {
              channel: {
                type: "string",
                description: "The channel to solo",
                enum: CHANNELS,
              },
            },
            required: ["channel"],
          },
        },
        {
          name: "tidal_unsolo",
          description: "Restore all channels after soloing (unsolos every soloed channel).",
          inputSchema: {
            type: "object",
            properties: {},
          },
        },
        {
          name: "tidal_get_history",
          description: "Get the history of patterns evaluated in this session.",
          inputSchema: {
            type: "object",
            properties: {
              limit: {
                type: "number",
                description: "Maximum number of history items to return (default: 10)",
              },
            },
          },
        },
        {
          name: "tidal_set_layer",
          description:
            "Add or replace one named layer of a channel, then re-evaluate that channel. A channel's pattern is " +
            "built as: <transform> $ <transform> $ ... <source> # <control> # <control>. Transforms apply in the " +
            "order they were added, outermost first. Each channel has one source; setting a new one replaces the old. " +
            "Give variants to let tidal_autopilot switch between them. Call tidal_palette for idioms that work.",
          inputSchema: {
            type: "object",
            properties: {
              channel: {
                type: "string",
                description: "The channel (d1-d9)",
                enum: CHANNELS,
              },
              name: {
                type: "string",
                description: "Layer name, e.g. \"rhythm\", \"stereo\", \"filter\". Reusing a name replaces that layer.",
              },
              kind: {
                type: "string",
                enum: LAYER_KINDS,
                description: "transform: a function applied with $ (e.g. \"every 3 (jux rev)\"). source: the base pattern (e.g. 's \"bd*2 sd\"'). control: an effect applied with # (e.g. \"crush 4\").",
              },
              code: {
                type: "string",
                description: "The layer's code, without the $ or # that joins it",
              },
              variants: {
                type: "array",
                items: { type: "string" },
                description: "Optional alternatives the autopilot may switch to. Keep them the same shape as code.",
              },
            },
            required: ["channel", "name", "kind", "code"],
          },
        },
        {
          name: "tidal_remove_layer",
          description: "Remove a named layer from a channel and re-evaluate it. Removing the last layer silences the channel.",
          inputSchema: {
            type: "object",
            properties: {
              channel: {
                type: "string",
                description: "The channel (d1-d9)",
                enum: CHANNELS,
              },
              name: {
                type: "string",
                description: "The layer to remove",
              },
            },
            required: ["channel", "name"],
          },
        },
        {
          name: "tidal_autopilot",
          description:
            "Keep layered channels evolving between turns. While running, each layer changes on its own random " +
            "timer: it switches to another of its variants, and transform layers sometimes lay out for a while. " +
            "start: begin or resume, optionally with new settings. pause: stop changing, keep playing. " +
            "stop: stop changing and hush everything. status: report settings and how many layers are moving.",
          inputSchema: {
            type: "object",
            properties: {
              action: {
                type: "string",
                enum: ["start", "pause", "stop", "status"],
              },
              minSeconds: {
                type: "number",
                description: "Shortest time between changes to a layer (default 10)",
              },
              maxSeconds: {
                type: "number",
                description: "Longest time between changes to a layer (default 40)",
              },
              layOutChance: {
                type: "number",
                description: "Chance from 0 to 1 that a transform layer lays out when it changes (default 0.3)",
              },
            },
            required: ["action"],
          },
        },
        {
          name: "tidal_palette",
          description: "Get a reference list of Tidal transforms, sources and controls that combine well, grouped by layer kind.",
          inputSchema: {
            type: "object",
            properties: {},
          },
        },
        {
          name: "tidal_set_control",
          description:
            "Change a named value in Tidal without re-evaluating any pattern, through Tidal's control port. " +
            "Patterns read it with cF (numbers) or cS (strings), e.g. tidal_eval d1 's \"bd*4\" # lpf (cF 1000 \"cutoff\")', " +
            "then set cutoff here. With seconds, a number glides from its current value, for sweeps and fades.",
          inputSchema: {
            type: "object",
            properties: {
              name: {
                type: "string",
                description: "The control name used in cF/cS, e.g. \"cutoff\"",
              },
              value: {
                type: ["number", "string"],
                description: "The new value",
              },
              seconds: {
                type: "number",
                description: `Optional: glide to the value over this many seconds (numbers only, up to ${MAX_RAMP_SECONDS})`,
              },
            },
            required: ["name", "value"],
          },
        },
        {
          name: "tidal_list_samples",
          description:
            "List the sample banks and synths SuperDirt has installed. Use these names with s or sound; " +
            "any other name is silent. Check here before using a sample you aren't sure exists.",
          inputSchema: {
            type: "object",
            properties: {
              filter: {
                type: "string",
                description: "Only list names containing this, e.g. \"808\" or \"bass\"",
              },
              refresh: {
                type: "boolean",
                description: "Re-read the sample folders, e.g. after installing new samples",
              },
            },
          },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      // Log all incoming tool calls
      // Clients that poll the state can ask not to fill the log
      const quiet = name === "tidal_get_state" && args?.quiet === true;
      if (!quiet) {
        console.error(`[TOOL CALL] ${name}`);
        console.error(`[TOOL ARGS] ${JSON.stringify(args, null, 2)}`);
      }

      try {
        if (!args) {
          throw new Error("Missing arguments");
        }

        switch (name) {
          case "tidal_eval": {
            const result = await this.evalPattern(args.channel, args.pattern);
            console.error(`[TOOL RESULT] tidal_eval: Success`);
            return result;
          }

          case "tidal_hush": {
            const result = await this.hush();
            console.error(`[TOOL RESULT] tidal_hush: Success`);
            return result;
          }

          case "tidal_silence": {
            const result = await this.silence(args.channel);
            console.error(`[TOOL RESULT] tidal_silence: Success`);
            return result;
          }

          case "tidal_get_state": {
            return await this.getState();
          }

          case "tidal_set_tempo": {
            const result = await this.setTempo(args.bpm);
            console.error(`[TOOL RESULT] tidal_set_tempo: Success`);
            return result;
          }

          case "tidal_solo": {
            const result = await this.solo(args.channel);
            console.error(`[TOOL RESULT] tidal_solo: Success`);
            return result;
          }

          case "tidal_unsolo": {
            const result = await this.unsolo();
            console.error(`[TOOL RESULT] tidal_unsolo: Success`);
            return result;
          }

          case "tidal_get_history": {
            const result = await this.getHistory(args.limit as number | undefined);
            console.error(`[TOOL RESULT] tidal_get_history: Success`);
            return result;
          }

          case "tidal_set_layer": {
            const result = await this.setChannelLayer(args);
            console.error(`[TOOL RESULT] tidal_set_layer: Success`);
            return result;
          }

          case "tidal_remove_layer": {
            const result = await this.removeChannelLayer(args.channel, args.name);
            console.error(`[TOOL RESULT] tidal_remove_layer: Success`);
            return result;
          }

          case "tidal_autopilot": {
            const result = await this.controlAutopilot(args);
            console.error(`[TOOL RESULT] tidal_autopilot: Success`);
            return result;
          }

          case "tidal_set_control": {
            const result = await this.setControl(args.name, args.value, args.seconds);
            console.error(`[TOOL RESULT] tidal_set_control: Success`);
            return result;
          }

          case "tidal_list_samples": {
            if (args.refresh === true) this.soundLibrary = undefined;
            const filter = typeof args.filter === "string" ? args.filter : undefined;
            return { content: [{ type: "text", text: describeLibrary(this.getSoundLibrary(), filter) }] };
          }

          case "tidal_palette": {
            return { content: [{ type: "text", text: PALETTE }] };
          }

          default:
            throw new Error(`Unknown tool: ${name}`);
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`[TOOL ERROR] ${name}: ${errorMessage}`);
        console.error(`[TOOL ERROR] Stack:`, error instanceof Error ? error.stack : 'No stack trace');
        return {
          content: [
            {
              type: "text",
              text: `Error: ${errorMessage}`,
            },
          ],
          isError: true,
        };
      }
    });
  }

  private async evalPattern(channel: unknown, pattern: unknown) {
    assertChannel(channel);
    if (typeof pattern !== "string" || pattern.trim() === "") {
      throw new Error("Pattern must be a non-empty string");
    }

    // A raw pattern replaces the channel's layers
    this.layers.delete(channel);
    this.autopilot.sync();

    const fullPattern = await this.play(channel, pattern, `Evaluate pattern on ${channel}`);

    return {
      content: [
        {
          type: "text",
          text: `✓ Evaluated on ${channel}:\n${fullPattern}\n\nPattern is now playing.${this.soundWarning(pattern)}`,
        },
      ],
    };
  }

  /**
   * Sends a pattern to Tidal on a channel and records it in state, history,
   * the session log and any WebSocket clients. Returns the full line sent.
   */
  private async play(channel: string, pattern: string, request: string): Promise<string> {
    const fullPattern = evalCommand(channel, pattern);

    console.error(`[EVAL PATTERN] ${request}`);
    console.error(`[EVAL PATTERN] Full: ${fullPattern}`);

    // Send first: if Tidal rejects the pattern, nothing below should record it
    const hushesBefore = this.hushes;
    try {
      await this.send(fullPattern);
    } catch (error) {
      if (error instanceof TidalError) {
        await this.logAction("REJECTED", `${request}\n${fullPattern}\n${error.message}`);
        const still = this.channels.get(channel)?.active
          ? `The previous pattern on ${channel} is still playing.`
          : `Nothing changed on ${channel}.`;
        throw new TidalError(`Tidal rejected the pattern. ${still}\n\n${error.message}`);
      }
      throw error;
    }

    // A hush sent while this was in flight comes after it, so this pattern isn't playing
    if (this.hushes !== hushesBefore) {
      console.error(`[EVAL PATTERN] Hushed while sending; not recording ${fullPattern}`);
      return fullPattern;
    }

    await this.recordPlayed(channel, pattern, request);
    return fullPattern;
  }

  /** Records a pattern Tidal has accepted: state, history, log and WebSocket clients. */
  private async recordPlayed(channel: string, pattern: string, request: string): Promise<void> {
    const fullPattern = evalCommand(channel, pattern);

    // Log the pattern evaluation
    await this.logPatternEvaluation(request, channel, pattern);

    // Update state
    this.channels.set(channel, {
      channel,
      pattern,
      timestamp: Date.now(),
      active: true,
    });

    // Add to history
    this.patternHistory.push({
      channel,
      pattern,
      timestamp: Date.now(),
    });
    if (this.patternHistory.length > MAX_HISTORY) {
      this.patternHistory.splice(0, this.patternHistory.length - MAX_HISTORY);
    }

    // Broadcast to WebSocket clients if using WebSocket transport
    if (this.wsTransport) {
      this.wsTransport.broadcast({
        type: 'pattern_update',
        channel,
        pattern,
        fullPattern,
        timestamp: Date.now()
      });
    }
  }

  private async setChannelLayer(args: Record<string, unknown>) {
    const { channel, name, kind, code, variants } = args;
    assertChannel(channel);
    if (typeof name !== "string" || name.trim() === "") {
      throw new Error("Layer name must be a non-empty string");
    }
    if (typeof kind !== "string" || !LAYER_KINDS.includes(kind as LayerKind)) {
      throw new Error(`Layer kind must be one of ${LAYER_KINDS.join(", ")}`);
    }
    if (typeof code !== "string") {
      throw new Error("Layer code must be a non-empty string");
    }
    if (variants !== undefined && (!Array.isArray(variants) || !variants.every((v) => typeof v === "string"))) {
      throw new Error("Variants must be an array of strings");
    }

    const previous = this.layers.get(channel);
    const updated = setLayer(previous ?? [], {
      name: name.trim(),
      kind: kind as LayerKind,
      code,
      variants: variants as string[] | undefined,
    });

    if (!updated.some((l) => l.kind === "source")) {
      this.layers.set(channel, updated);
      this.autopilot.sync();
      return {
        content: [
          {
            type: "text",
            text: `✓ Stored ${kind} layer "${name}" on ${channel}. Add a source layer to start it playing.` +
              this.soundWarning([code, ...((variants as string[] | undefined) ?? [])].join("\n")),
          },
        ],
      };
    }

    // Only keep the new layers if Tidal accepts the result
    const fullPattern = await this.play(
      channel,
      composePattern(updated),
      `Set ${kind} layer "${name}" on ${channel}`
    );
    this.layers.set(channel, updated);
    this.autopilot.sync();
    return {
      content: [
        {
          type: "text",
          text: `✓ Set ${kind} layer "${name}" on ${channel}:\n${fullPattern}\n\nLayers:\n${describeLayers(updated)}` +
            this.soundWarning([code, ...((variants as string[] | undefined) ?? [])].join("\n")),
        },
      ],
    };
  }

  private async removeChannelLayer(channel: unknown, name: unknown) {
    assertChannel(channel);
    if (typeof name !== "string") {
      throw new Error("Layer name must be a string");
    }

    const updated = removeLayer(this.layers.get(channel) ?? [], name);
    if (updated.length === 0) {
      // silence() clears the channel's layers
      await this.silence(channel);
      return {
        content: [{ type: "text", text: `✓ Removed layer "${name}". ${channel} has no layers left and is silenced.` }],
      };
    }

    if (!updated.some((l) => l.kind === "source")) {
      this.layers.set(channel, updated);
      this.autopilot.sync();
      return {
        content: [{ type: "text", text: `✓ Removed layer "${name}" from ${channel}.` }],
      };
    }

    const fullPattern = await this.play(channel, composePattern(updated), `Remove layer "${name}" from ${channel}`);
    this.layers.set(channel, updated);
    this.autopilot.sync();
    return {
      content: [
        {
          type: "text",
          text: `✓ Removed layer "${name}" from ${channel}:\n${fullPattern}\n\nLayers:\n${describeLayers(updated)}`,
        },
      ],
    };
  }

  private async controlAutopilot(args: Record<string, unknown>) {
    const { action } = args;
    const overrides: Partial<AutopilotSettings> = {};
    for (const key of ["minSeconds", "maxSeconds", "layOutChance"] as const) {
      if (args[key] !== undefined) {
        if (typeof args[key] !== "number") {
          throw new Error(`${key} must be a number`);
        }
        overrides[key] = args[key] as number;
      }
    }

    switch (action) {
      case "start": {
        this.autopilot.start(overrides);
        const s = this.autopilot.getSettings();
        await this.logAction("AUTOPILOT START", JSON.stringify(s));
        const moving = this.autopilot.activeLayerCount();
        const note = moving === 0
          ? " No layers can change yet: give layers variants, or add transform layers."
          : "";
        return {
          content: [
            {
              type: "text",
              text: `✓ Autopilot running: ${moving} layer(s) changing every ${s.minSeconds}–${s.maxSeconds}s, ` +
                `lay-out chance ${s.layOutChance}.${note}`,
            },
          ],
        };
      }
      case "pause": {
        this.autopilot.pause();
        await this.logAction("AUTOPILOT PAUSE");
        return { content: [{ type: "text", text: "✓ Autopilot paused. Patterns keep playing." }] };
      }
      case "stop": {
        this.autopilot.stop();
        await this.logAction("AUTOPILOT STOP");
        await this.hush();
        return { content: [{ type: "text", text: "✓ Autopilot stopped and everything hushed." }] };
      }
      case "status": {
        const s = this.autopilot.getSettings();
        return {
          content: [
            {
              type: "text",
              text: `Autopilot ${this.autopilot.status}: ${this.autopilot.activeLayerCount()} layer(s) changing, ` +
                `every ${s.minSeconds}–${s.maxSeconds}s, lay-out chance ${s.layOutChance}.`,
            },
          ],
        };
      }
      default:
        throw new Error("Action must be one of start, pause, stop, status");
    }
  }

  private async hush() {
    console.error(`[HUSH] Stopping all patterns`);
    this.autopilot.stop();
    this.hushes++;
    await this.send(HUSH_COMMAND);
    await this.recordHush();

    return {
      content: [
        {
          type: "text",
          text: "✓ All patterns stopped (hushed).",
        },
      ],
    };
  }

  private async recordHush(): Promise<void> {
    this.autopilot.stop();
    // Log the action
    await this.logAction("HUSH", "Stopped all patterns");

    // Clear all channel states
    for (const state of this.channels.values()) {
      state.active = false;
      state.pattern = "";
    }
    this.soloedChannels.clear();
    this.layers.clear();

    // Broadcast to WebSocket clients
    if (this.wsTransport) {
      this.wsTransport.broadcast({
        type: 'hush',
        timestamp: Date.now()
      });
    }
  }

  private async silence(channel: unknown) {
    assertChannel(channel);
    await this.send(silenceCommand(channel));
    await this.recordSilence(channel);

    return {
      content: [
        {
          type: "text",
          text: `✓ Silenced ${channel}.`,
        },
      ],
    };
  }

  private async recordSilence(channel: string): Promise<void> {
    // Log the action
    await this.logAction("SILENCE", `Silenced channel ${channel}`);

    const state = this.channels.get(channel);
    if (state) {
      state.active = false;
      state.pattern = "";
    }
    this.layers.delete(channel);
    this.autopilot.sync();
  }

  /**
   * Runs a statement from an editor sharing the session (see share.ts), and
   * keeps the server's state in step with what it played.
   */
  private async runShared(code: string): Promise<ShareResponse> {
    if (isBootStatement(code)) {
      return { output: "" };
    }
    try {
      await this.ensureGhci();
    } catch (error) {
      return { output: "", error: `Tidal isn't running: ${(error as Error).message}` };
    }

    let output: string;
    try {
      output = await this.ghci!.run(code);
    } catch (error) {
      return { output: "", error: (error as Error).message };
    }

    const playback = parsePlayback(code);
    if (playback?.kind === "eval") {
      this.layers.delete(playback.channel);
      this.autopilot.sync();
      await this.recordPlayed(playback.channel, stripHighlighting(playback.pattern), `From the editor on ${playback.channel}`);
    } else if (playback?.kind === "silence") {
      await this.recordSilence(playback.channel);
    } else if (playback?.kind === "hush") {
      this.soloedChannels.clear();
      await this.recordHush();
    }
    return { output };
  }

  /** With TIDAL_SHARE_SESSION=true, lets an editor use this server's Tidal (see share.ts). */
  private async startSharing(): Promise<void> {
    if (process.platform === "win32") {
      console.error("[SHARE] Sharing the session isn't supported on Windows");
      return;
    }
    const dir = defaultShareDir();
    const share = new ShareServer(socketPathIn(dir), (code) => this.runShared(code));
    if (!(await share.start())) return;
    this.share = share;
    const bin = writeGhciWrapper({
      dir,
      attachScript: path.join(PACKAGE_ROOT, "dist", "attach.js"),
      realGhci: process.env.GHCI_PATH || "ghci",
    });
    console.error(`[SHARE] Point your editor's ghci path at ${bin} to share this Tidal session`);
  }

  private async getState() {
    const activeChannels = Array.from(this.channels.values())
      .filter((c) => c.active)
      .map((c) => {
        const elapsed = Math.floor((Date.now() - c.timestamp) / 1000);
        const layers = this.layers.get(c.channel);
        const layerText = layers ? `\n${describeLayers(layers)}` : "";
        return `  ${c.channel}: ${c.pattern} (${elapsed}s ago)${layerText}`;
      });

    let stateText = activeChannels.length > 0
      ? `Active channels:\n${activeChannels.join("\n")}`
      : "No active patterns.";
    if (this.bpm !== undefined) {
      stateText += `\n\nTempo: ${this.bpm} BPM.`;
    }
    if (this.controls.size > 0) {
      const values = [...this.controls].map(([k, v]) => `${k}=${typeof v === "string" ? `"${v}"` : v}`);
      stateText += `\n\nControls: ${values.join(", ")}`;
    }
    if (this.autopilot.status !== "stopped") {
      stateText += `\n\nAutopilot ${this.autopilot.status}.`;
    }

    return {
      content: [
        {
          type: "text",
          text: stateText,
        },
      ],
    };
  }

  /** Tidal's control port: TIDAL_CTRL_PORT, else the boot file's cCtrlPort, else Tidal's default. */
  private getOsc(): OscSender {
    if (!this.osc) {
      const bootPath = this.config.bootTidalPath ?? (this.config.useGhci ? DEFAULT_BOOT_PATH : undefined);
      const port =
        Number(process.env.TIDAL_CTRL_PORT) ||
        (bootPath ? ctrlPortFromBootFile(bootPath) : undefined) ||
        TIDAL_DEFAULT_CTRL_PORT;
      this.osc = new OscSender(process.env.TIDAL_CTRL_HOST || "127.0.0.1", port);
    }
    return this.osc;
  }

  private async setControl(name: unknown, value: unknown, seconds: unknown) {
    if (typeof name !== "string" || !CONTROL_NAME.test(name)) {
      throw new Error("Control name must be letters, digits and underscores, starting with a letter");
    }
    if (typeof value !== "number" && typeof value !== "string") {
      throw new Error("Value must be a number or a string");
    }
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error("Value must be a finite number");
    }
    if (seconds !== undefined && (typeof seconds !== "number" || !(seconds >= 0 && seconds <= MAX_RAMP_SECONDS))) {
      throw new Error(`seconds must be a number from 0 to ${MAX_RAMP_SECONDS}`);
    }

    // In GHCi mode the control port belongs to the server's own Tidal
    if (this.config.useGhci) await this.ensureGhci();
    const osc = this.getOsc();

    clearInterval(this.ramps.get(name));
    this.ramps.delete(name);

    const from = this.controls.get(name);
    if (typeof value === "number" && typeof from === "number" && seconds) {
      const steps = Math.max(1, Math.round(seconds * RAMP_STEPS_PER_SECOND));
      let step = 0;
      const timer = setInterval(() => {
        step++;
        const current = step >= steps ? value : from + ((value - from) * step) / steps;
        this.controls.set(name, current);
        osc.send("/ctrl", [name, current]).catch((e) => console.error(`[OSC] ${e}`));
        if (step >= steps) {
          clearInterval(timer);
          this.ramps.delete(name);
        }
      }, 1000 / RAMP_STEPS_PER_SECOND);
      timer.unref();
      this.ramps.set(name, timer);
      await this.logAction("CONTROL", `${name}: ${from} → ${value} over ${seconds}s`);
      return {
        content: [{ type: "text", text: `✓ ${name} gliding from ${from} to ${value} over ${seconds}s (via ${osc.target}).` }],
      };
    }

    await osc.send("/ctrl", [name, value]);
    this.controls.set(name, value);
    await this.logAction("CONTROL", `${name} = ${value}`);
    const note = seconds && typeof from !== "number"
      ? ` It had no previous number to glide from, so it jumped.`
      : "";
    return {
      content: [
        {
          type: "text",
          text: `✓ Set ${name} to ${typeof value === "string" ? `"${value}"` : value} (via ${osc.target}).${note} ` +
            `Patterns only hear it if they read it with cF or cS.`,
        },
      ],
    };
  }

  private getSoundLibrary(): SoundLibrary {
    this.soundLibrary ??= loadSoundLibrary({
      extraPaths: (process.env.TIDAL_SAMPLE_PATHS ?? "").split(path.delimiter).filter(Boolean),
    });
    return this.soundLibrary;
  }

  /**
   * A warning for sound names SuperDirt doesn't have. Tidal accepts them, but
   * they play nothing, so this is the only way the client finds out.
   */
  private soundWarning(code: string): string {
    const unknown = unknownSounds(code, this.getSoundLibrary());
    if (unknown.length === 0) return "";
    return (
      `\n\n⚠ SuperDirt has no sound called ${unknown.map((n) => `"${n}"`).join(", ")}, so ` +
      `${unknown.length === 1 ? "it" : "they"} will be silent. Use tidal_list_samples to see what's installed.`
    );
  }

  private async setTempo(bpm: unknown) {
    if (typeof bpm !== "number" || !(bpm >= 20 && bpm <= 999)) {
      throw new Error("bpm must be a number from 20 to 999");
    }
    await this.send(tempoCommand(bpm));
    this.bpm = bpm;
    await this.logAction("TEMPO", `${bpm} BPM`);
    return {
      content: [{ type: "text", text: `✓ Tempo set to ${bpm} BPM.` }],
    };
  }

  private async solo(channel: unknown) {
    assertChannel(channel);
    // Log the action
    await this.logAction("SOLO", `Soloed channel ${channel}`);

    await this.send(soloCommand(channel));
    this.soloedChannels.add(channel);

    return {
      content: [
        {
          type: "text",
          text: `✓ Soloed ${channel}. All other channels are muted.`,
        },
      ],
    };
  }

  private async unsolo() {
    // Log the action
    await this.logAction("UNSOLO", "Restored all channels");

    if (this.soloedChannels.size === 0) {
      return {
        content: [{ type: "text", text: "No channels are soloed." }],
      };
    }

    await this.send(unsoloCommand(Array.from(this.soloedChannels)));
    this.soloedChannels.clear();

    return {
      content: [
        {
          type: "text",
          text: "✓ Unsolo applied. All channels restored.",
        },
      ],
    };
  }

  private async getHistory(limit: number = 10) {
    const recent = this.patternHistory.slice(-limit).reverse();

    if (recent.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: "No pattern history yet.",
          },
        ],
      };
    }

    const historyText = recent.map((entry, idx) => {
      const elapsed = Math.floor((Date.now() - entry.timestamp) / 1000);
      return `${idx + 1}. ${entry.channel}: ${entry.pattern} (${elapsed}s ago)`;
    }).join("\n");

    return {
      content: [
        {
          type: "text",
          text: `Recent patterns:\n${historyText}`,
        },
      ],
    };
  }

  /** Writes one at a time, so the file always ends up holding the last command sent. */
  private writeToTidalFile(code: string): Promise<void> {
    const write = this.fileWrites.then(async () => {
      console.error(`[WRITE TO FILE] Writing to ${this.config.tidalFile}`);
      console.error(`[WRITE TO FILE] Code: ${code}`);
      const content = `-- TidalCycles MCP Server\n-- Auto-generated at ${new Date().toISOString()}\n\n${code}\n`;
      await fs.writeFile(this.config.tidalFile, content, "utf-8");
      console.error(`[WRITE TO FILE] Successfully written`);
    });
    this.fileWrites = write.catch(() => undefined);
    return write;
  }

  /** Sends code to Tidal: through GHCi in direct mode, otherwise to the output file. */
  private async send(code: string): Promise<void> {
    if (this.config.useGhci) {
      await this.sendToGhci(code);
    } else {
      await this.writeToTidalFile(code);
    }
  }

  /** Starts GHCi if it isn't running. Concurrent callers share one start. */
  private ensureGhci(): Promise<void> {
    if (this.ghci?.alive) return Promise.resolve();
    if (!this.ghciStarting) {
      this.ghci ??= new GhciSession({
        ghciPath: process.env.GHCI_PATH || "ghci",
        bootPath: this.config.bootTidalPath || DEFAULT_BOOT_PATH,
      });
      this.ghciStarting = this.ghci.start().finally(() => {
        this.ghciStarting = undefined;
      });
    }
    return this.ghciStarting;
  }

  private async sendToGhci(code: string): Promise<void> {
    try {
      await this.ensureGhci();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Couldn't start Tidal: ${message}\nCheck GHCI_PATH and TIDAL_BOOT_PATH.`);
    }
    await this.ghci!.run(code);
  }

  private async cleanup() {
    console.error('[CLEANUP] Shutting down server...');
    this.autopilot.stop();
    for (const timer of this.ramps.values()) clearInterval(timer);
    this.share?.stop();
    this.osc?.close();
    
    if (this.ghci) {
      console.error('[CLEANUP] Stopping GHCi process...');
      this.ghci.stop();
      console.error('[CLEANUP] GHCi process stopped');
    }
    
    await this.server.close();
    console.error('[CLEANUP] Server closed');
  }

  async run() {
    // Initialize log file with header
    const logHeader = `TidalCycles MCP Server - Session Log
Started: ${new Date().toISOString()}
Mode: ${this.config.useGhci ? 'Direct GHCi' : 'File-based'}
Transport: ${this.config.transport}
Log File: ${this.logFile}
================================================================================

`;

    try {
      await fs.writeFile(this.logFile, logHeader, 'utf-8');
      console.error(`Session log: ${this.logFile}`);
    } catch (error) {
      console.error(`Failed to create log file: ${error}`);
    }

    // Choose transport based on configuration
    if (this.config.transport === 'websocket') {
      const port = this.config.websocketPort || 8080;
      const host = this.config.websocketHost || 'localhost';

      this.wsTransport = new WebSocketServerTransport({
        port,
        host,
        allowedOrigins: this.config.websocketAllowedOrigins,
      });
      await this.server.connect(this.wsTransport);

      console.error(`TidalCycles MCP Server running on WebSocket ws://${host}:${port}`);
      console.error(`Mode: ${this.config.useGhci ? 'Direct GHCi' : 'File-based'}`);
      console.error(`Clients can connect to: ws://${host}:${port}`);
    } else {
      const transport = new StdioServerTransport();
      await this.server.connect(transport);
      console.error("TidalCycles MCP Server running on stdio");
      console.error(`Mode: ${this.config.useGhci ? 'Direct GHCi' : 'File-based'}`);
    }

    // Start Tidal in the background once the client can reach us. If it fails,
    // the next tool call retries and reports why.
    if (this.config.useGhci) {
      this.ensureGhci().catch((error) => console.error(`[GHCI] Startup failed: ${error.message}`));
      if (process.env.TIDAL_SHARE_SESSION === "true" || process.env.TIDAL_SHARE_SESSION === "1") {
        this.startSharing().catch((error) => console.error(`[SHARE] Couldn't share the session: ${error.message}`));
      }
    }
  }
}

// Main execution
const tidalFile = process.env.TIDAL_FILE || path.join(process.cwd(), "tidal-mcp-output.tidal");
const useGhci = process.env.TIDAL_USE_GHCI === "true" || process.env.TIDAL_USE_GHCI === "1";
const bootTidalPath = process.env.TIDAL_BOOT_PATH;
const logFile = process.env.TIDAL_LOG_FILE; // Optional: custom log file path

// Transport configuration
const transport = (process.env.TIDAL_TRANSPORT as 'stdio' | 'websocket') || 'stdio';
const websocketPort = process.env.TIDAL_WS_PORT ? parseInt(process.env.TIDAL_WS_PORT) : 8080;
const websocketHost = process.env.TIDAL_WS_HOST || 'localhost';
const websocketAllowedOrigins = (process.env.TIDAL_WS_ALLOWED_ORIGINS || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

const config: TidalConfig = {
  tidalFile,
  bootTidalPath,
  useGhci,
  logFile,
  transport,
  websocketPort,
  websocketHost,
  websocketAllowedOrigins,
};

const server = new TidalMCPServer(config);
server.run().catch(console.error);
