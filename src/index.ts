#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import * as fs from "fs/promises";
import * as path from "path";
import { spawn, ChildProcess } from "child_process";
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
import {
  HUSH_COMMAND,
  evalCommand,
  ghciBlock,
  silenceCommand,
  soloCommand,
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
  private ghciProcess?: ChildProcess;
  private patternHistory: Array<{ channel: string; pattern: string; timestamp: number }> = [];
  private logFile: string;
  private ghciStreamAlive: boolean = false;
  private isReconnecting: boolean = false;
  private wsTransport?: WebSocketServerTransport;
  private soloedChannels: Set<string> = new Set();
  private layers: Map<string, Layer[]> = new Map();
  private autopilot: Autopilot;
  private isShuttingDown: boolean = false;

  constructor(config: TidalConfig) {
    this.config = config;
    // Set log file path - same directory as the tidal output file
    const tidalDir = path.dirname(config.tidalFile);
    this.logFile = config.logFile || path.join(tidalDir, "tidal-mcp-session.log");

    this.server = new Server(
      {
        name: "tidal-mcp-server",
        version: "1.0.0",
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
            properties: {},
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
          description: "Get a reference list of Tidal 1.9 transforms, sources and controls that combine well, grouped by layer kind.",
          inputSchema: {
            type: "object",
            properties: {},
          },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      // Log all incoming tool calls
      console.error(`[TOOL CALL] ${name}`);
      console.error(`[TOOL ARGS] ${JSON.stringify(args, null, 2)}`);

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
            const result = await this.getState();
            console.error(`[TOOL RESULT] tidal_get_state: Success`);
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
          text: `✓ Evaluated on ${channel}:\n${fullPattern}\n\nPattern is now playing.`,
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

    // Use GHCi if configured, otherwise write to file
    if (this.config.useGhci) {
      await this.sendToGhci(fullPattern);
    } else {
      await this.writeToTidalFile(fullPattern);
    }

    return fullPattern;
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

    const updated = setLayer(this.layers.get(channel) ?? [], {
      name: name.trim(),
      kind: kind as LayerKind,
      code,
      variants: variants as string[] | undefined,
    });
    this.layers.set(channel, updated);
    this.autopilot.sync();

    if (!updated.some((l) => l.kind === "source")) {
      return {
        content: [
          {
            type: "text",
            text: `✓ Stored ${kind} layer "${name}" on ${channel}. Add a source layer to start it playing.`,
          },
        ],
      };
    }

    const fullPattern = await this.play(
      channel,
      composePattern(updated),
      `Set ${kind} layer "${name}" on ${channel}`
    );
    return {
      content: [
        {
          type: "text",
          text: `✓ Set ${kind} layer "${name}" on ${channel}:\n${fullPattern}\n\nLayers:\n${describeLayers(updated)}`,
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

    this.layers.set(channel, updated);
    this.autopilot.sync();

    if (!updated.some((l) => l.kind === "source")) {
      return {
        content: [{ type: "text", text: `✓ Removed layer "${name}" from ${channel}.` }],
      };
    }

    const fullPattern = await this.play(channel, composePattern(updated), `Remove layer "${name}" from ${channel}`);
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
    // Log the action
    await this.logAction("HUSH", "Stopped all patterns");

    // Clear all channel states
    for (const state of this.channels.values()) {
      state.active = false;
      state.pattern = "";
    }
    this.soloedChannels.clear();
    this.layers.clear();
    this.autopilot.stop();

    // Broadcast to WebSocket clients
    if (this.wsTransport) {
      this.wsTransport.broadcast({
        type: 'hush',
        timestamp: Date.now()
      });
    }

    // Use GHCi if configured, otherwise write to file
    if (this.config.useGhci) {
      await this.sendToGhci(HUSH_COMMAND);
    } else {
      await this.writeToTidalFile(HUSH_COMMAND);
    }

    return {
      content: [
        {
          type: "text",
          text: "✓ All patterns stopped (hushed).",
        },
      ],
    };
  }

  private async silence(channel: unknown) {
    assertChannel(channel);
    // Log the action
    await this.logAction("SILENCE", `Silenced channel ${channel}`);

    const state = this.channels.get(channel);
    if (state) {
      state.active = false;
      state.pattern = "";
    }
    this.layers.delete(channel);
    this.autopilot.sync();

    
    // Use GHCi if configured, otherwise write to file
    if (this.config.useGhci) {
      await this.sendToGhci(silenceCommand(channel));
    } else {
      await this.writeToTidalFile(silenceCommand(channel));
    }

    return {
      content: [
        {
          type: "text",
          text: `✓ Silenced ${channel}.`,
        },
      ],
    };
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

  private async solo(channel: unknown) {
    assertChannel(channel);
    // Log the action
    await this.logAction("SOLO", `Soloed channel ${channel}`);

    const soloPattern = soloCommand(channel);
    this.soloedChannels.add(channel);
    
    // Use GHCi if configured, otherwise write to file
    if (this.config.useGhci) {
      await this.sendToGhci(soloPattern);
    } else {
      await this.writeToTidalFile(soloPattern);
    }

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

    const unsolo = unsoloCommand(Array.from(this.soloedChannels));
    this.soloedChannels.clear();

    // Use GHCi if configured, otherwise write to file
    if (this.config.useGhci) {
      await this.sendToGhci(unsolo);
    } else {
      await this.writeToTidalFile(unsolo);
    }

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

  private async writeToTidalFile(code: string) {
    console.error(`[WRITE TO FILE] Writing to ${this.config.tidalFile}`);
    console.error(`[WRITE TO FILE] Code: ${code}`);
    const content = `-- TidalCycles MCP Server\n-- Auto-generated at ${new Date().toISOString()}\n\n${code}\n`;
    await fs.writeFile(this.config.tidalFile, content, "utf-8");
    console.error(`[WRITE TO FILE] Successfully written`);
  }

  private async startGhci() {
    if (this.ghciProcess && this.ghciStreamAlive) {
      console.error("[GHCI] Already running and alive");
      return; // Already running
    }

    // Kill old process if it exists
    if (this.ghciProcess) {
      console.error("[GHCI] Cleaning up old process");
      this.ghciProcess.kill();
      this.ghciProcess = undefined;
    }

    const bootTidalPath = this.config.bootTidalPath || "BootTidal.hs";
    const ghciPath = process.env.GHCI_PATH || "ghci";

    console.error(`[GHCI] Starting GHCi with boot script: ${bootTidalPath}`);

    const ghciProcess = spawn(ghciPath, ["-ghci-script", bootTidalPath], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.ghciProcess = ghciProcess;

    // Mark stream as alive initially
    this.ghciStreamAlive = true;

    // Spawn failures (e.g. ghci not on PATH) arrive asynchronously; surface them
    // through the init promise below rather than throwing from an event handler.
    const spawnFailed = new Promise<never>((_, reject) => {
      ghciProcess.on('error', (err) => {
        console.error(`[GHCI ERROR] Failed to start: ${err.message}`);
        console.error('[GHCI ERROR] Make sure ghci is in PATH or set GHCI_PATH environment variable');
        this.ghciStreamAlive = false;
        reject(err);
      });
    });

    // Handle process exit
    this.ghciProcess.on('exit', (code, signal) => {
      console.error(`[GHCI] Process exited with code ${code}, signal ${signal}`);
      this.ghciStreamAlive = false;
      this.ghciProcess = undefined;
    });

    // Handle stdin errors (this is the "stream destroyed" error)
    this.ghciProcess.stdin?.on('error', (err) => {
      console.error(`[GHCI STDIN ERROR] ${err.message}`);
      this.ghciStreamAlive = false;
    });

    // Handle stdin close
    this.ghciProcess.stdin?.on('close', () => {
      console.error('[GHCI] stdin stream closed');
      this.ghciStreamAlive = false;
    });

    // Forward GHCi's stderr so Haskell type errors in patterns are visible
    ghciProcess.stderr?.on("data", (data: Buffer) => {
      console.error('[GHCI STDERR]', data.toString());
    });

    // Wait for TidalCycles to initialize
    let timeout: NodeJS.Timeout | undefined;
    const initialized = new Promise<void>((resolve) => {
      const checkInit = (data: Buffer) => {
        const output = data.toString();
        console.error('[GHCI OUTPUT]', output);
        if (output.includes("Connected to SuperDirt") || output.includes("tidal>")) {
          ghciProcess.stdout?.off("data", checkInit);
          console.error('[GHCI] ✓ Successfully initialized and connected to SuperDirt');
          resolve();
        }
      };
      ghciProcess.stdout?.on("data", checkInit);

      // Timeout after 10 seconds
      timeout = setTimeout(() => {
        console.error('[GHCI] Initialization timeout reached');
        resolve();
      }, 10000);
    });

    try {
      await Promise.race([initialized, spawnFailed]);
    } finally {
      clearTimeout(timeout);
    }

    console.error("[GHCI] GHCi/TidalCycles started and ready");
  }

  private async sendToGhci(code: string) {
    // Check if stream is alive, reconnect if needed
    if (!this.isGhciHealthy()) {
      console.error('[GHCI] Stream not alive, attempting reconnection...');
      
      // Prevent multiple simultaneous reconnection attempts
      if (this.isReconnecting) {
        throw new Error("GHCi is currently reconnecting, please try again in a moment");
      }

      this.isReconnecting = true;
      try {
        await this.startGhci();
        console.error('[GHCI] ✓ Reconnection successful');
      } catch (error) {
        this.isReconnecting = false;
        throw new Error(`Failed to reconnect to GHCi: ${error}`);
      }
      this.isReconnecting = false;
    }

    const ghciCode = ghciBlock(code);
    console.error(`[GHCI SEND] ${ghciCode}`);

    return new Promise<void>((resolve, reject) => {
      if (!this.ghciProcess?.stdin) {
        reject(new Error("GHCi stdin not available after reconnection"));
        return;
      }

      this.ghciProcess.stdin.write(ghciCode + "\n", (err) => {
        if (err) {
          console.error(`[GHCI SEND ERROR] ${err.message}`);
          this.ghciStreamAlive = false; // Mark as dead on write error
          reject(err);
        } else {
          console.error('[GHCI SEND] ✓ Successfully sent');
          resolve();
        }
      });
    });
  }

  /**
   * Check if GHCi connection is healthy
   */
  private isGhciHealthy(): boolean {
    return this.ghciStreamAlive && 
           !!this.ghciProcess && 
           !!this.ghciProcess.stdin && 
           !this.ghciProcess.stdin.destroyed &&
           !this.ghciProcess.killed;
  }

  private async cleanup() {
    console.error('[CLEANUP] Shutting down server...');
    this.autopilot.stop();
    
    if (this.ghciProcess) {
      console.error('[CLEANUP] Stopping GHCi process...');
      
      // Close stdin gracefully first
      if (this.ghciProcess.stdin && !this.ghciProcess.stdin.destroyed) {
        this.ghciProcess.stdin.end();
      }
      
      // Then kill the process
      this.ghciProcess.kill();
      this.ghciStreamAlive = false;
      console.error('[CLEANUP] GHCi process stopped');
    }
    
    await this.server.close();
    console.error('[CLEANUP] Server closed');
  }

  async run() {
    // Start GHCi if using direct mode
    if (this.config.useGhci) {
      await this.startGhci();
    }

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
