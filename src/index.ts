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
}

interface LogEntry {
  timestamp: string;
  request: string;
  response: string;
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

    this.setupToolHandlers();

    // Error handling
    this.server.onerror = (error) => console.error("[MCP Error]", error);
    process.on("SIGINT", async () => {
      await this.cleanup();
      process.exit(0);
    });
  }

  /**
   * Logs a pattern evaluation to the human-readable log file
   */
  private async logPatternEvaluation(request: string, channel: string, pattern: string) {
    const timestamp = new Date().toISOString();
    const fullPattern = `${channel} $ ${pattern}`;

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
          description: "Evaluate a TidalCycles pattern on a specific channel (d1-d9). This is the main way to make music with Tidal.",
          inputSchema: {
            type: "object",
            properties: {
              channel: {
                type: "string",
                description: "The channel to evaluate on (d1, d2, ... d9)",
                enum: ["d1", "d2", "d3", "d4", "d5", "d6", "d7", "d8", "d9"],
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
                enum: ["d1", "d2", "d3", "d4", "d5", "d6", "d7", "d8", "d9"],
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
          description: "Solo a specific channel, muting all others temporarily.",
          inputSchema: {
            type: "object",
            properties: {
              channel: {
                type: "string",
                description: "The channel to solo",
                enum: ["d1", "d2", "d3", "d4", "d5", "d6", "d7", "d8", "d9"],
              },
            },
            required: ["channel"],
          },
        },
        {
          name: "tidal_unsolo",
          description: "Restore all channels after soloing.",
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
            const result = await this.evalPattern(args.channel as string, args.pattern as string);
            console.error(`[TOOL RESULT] tidal_eval: Success`);
            return result;
          }

          case "tidal_hush": {
            const result = await this.hush();
            console.error(`[TOOL RESULT] tidal_hush: Success`);
            return result;
          }

          case "tidal_silence": {
            const result = await this.silence(args.channel as string);
            console.error(`[TOOL RESULT] tidal_silence: Success`);
            return result;
          }

          case "tidal_get_state": {
            const result = await this.getState();
            console.error(`[TOOL RESULT] tidal_get_state: Success`);
            return result;
          }

          case "tidal_solo": {
            const result = await this.solo(args.channel as string);
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
        };
      }
    });
  }

  private async evalPattern(channel: string, pattern: string) {
    const fullPattern = `${channel} $ ${pattern}`;

    console.error(`[EVAL PATTERN] Channel: ${channel}`);
    console.error(`[EVAL PATTERN] Pattern: ${pattern}`);
    console.error(`[EVAL PATTERN] Full: ${fullPattern}`);

    // Log the pattern evaluation
    await this.logPatternEvaluation(`Evaluate pattern on ${channel}`, channel, pattern);

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

    // Use GHCi if configured, otherwise write to file
    if (this.config.useGhci) {
      await this.sendToGhci(fullPattern);
    } else {
      await this.writeToTidalFile(fullPattern);
    }

    return {
      content: [
        {
          type: "text",
          text: `✓ Evaluated on ${channel}:\n${fullPattern}\n\nPattern is now playing.`,
        },
      ],
    };
  }

  private async hush() {
    console.error(`[HUSH] Stopping all patterns`);
    // Log the action
    await this.logAction("HUSH", "Stopped all patterns");

    // Clear all channel states
    for (const [channel, state] of this.channels.entries()) {
      state.active = false;
      state.pattern = "";
    }

    // Use GHCi if configured, otherwise write to file
    if (this.config.useGhci) {
      await this.sendToGhci("hush");
    } else {
      await this.writeToTidalFile("hush");
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

  private async silence(channel: string) {
    // Log the action
    await this.logAction("SILENCE", `Silenced channel ${channel}`);

    const state = this.channels.get(channel);
    if (state) {
      state.active = false;
      state.pattern = "";
    }

    const silenceCommand = `silence ${channel}`;
    
    // Use GHCi if configured, otherwise write to file
    if (this.config.useGhci) {
      await this.sendToGhci(silenceCommand);
    } else {
      await this.writeToTidalFile(silenceCommand);
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
        return `  ${c.channel}: ${c.pattern} (${elapsed}s ago)`;
      });

    const stateText = activeChannels.length > 0
      ? `Active channels:\n${activeChannels.join("\n")}`
      : "No active patterns.";

    return {
      content: [
        {
          type: "text",
          text: stateText,
        },
      ],
    };
  }

  private async solo(channel: string) {
    // Log the action
    await this.logAction("SOLO", `Soloed channel ${channel}`);

    const soloPattern = `solo $ ${channel}`;
    
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

    const unsoloCommand = "unsolo $ d1";
    
    // Use GHCi if configured, otherwise write to file
    if (this.config.useGhci) {
      await this.sendToGhci(unsoloCommand);
    } else {
      await this.writeToTidalFile(unsoloCommand);
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
      return `${limit - idx}. ${entry.channel}: ${entry.pattern} (${elapsed}s ago)`;
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

    this.ghciProcess = spawn(ghciPath, ["-ghci-script", bootTidalPath], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Mark stream as alive initially
    this.ghciStreamAlive = true;

    // Handle spawn errors
    this.ghciProcess.on('error', (err) => {
      console.error(`[GHCI ERROR] Failed to start: ${err.message}`);
      console.error('[GHCI ERROR] Make sure ghci is in PATH or set GHCI_PATH environment variable');
      this.ghciStreamAlive = false;
      throw err;
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

    // Wait for TidalCycles to initialize
    await new Promise<void>((resolve) => {
      const checkInit = (data: Buffer) => {
        const output = data.toString();
        console.error('[GHCI OUTPUT]', output);
        if (output.includes("Connected to SuperDirt") || output.includes("tidal>")) {
          this.ghciProcess?.stdout?.off("data", checkInit);
          console.error('[GHCI] ✓ Successfully initialized and connected to SuperDirt');
          resolve();
        }
      };
      this.ghciProcess?.stdout?.on("data", checkInit);

      // Timeout after 10 seconds
      setTimeout(() => {
        console.error('[GHCI] Initialization timeout reached');
        resolve();
      }, 10000);
    });

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

    console.error(`[GHCI SEND] ${code}`);

    return new Promise<void>((resolve, reject) => {
      if (!this.ghciProcess?.stdin) {
        reject(new Error("GHCi stdin not available after reconnection"));
        return;
      }

      this.ghciProcess.stdin.write(code + "\n", (err) => {
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
Log File: ${this.logFile}
================================================================================

`;

    try {
      await fs.writeFile(this.logFile, logHeader, 'utf-8');
      console.error(`Session log: ${this.logFile}`);
    } catch (error) {
      console.error(`Failed to create log file: ${error}`);
    }

    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error("TidalCycles MCP Server running on stdio");
    console.error(`Mode: ${this.config.useGhci ? 'Direct GHCi' : 'File-based'}`);
  }
}

// Main execution
const tidalFile = process.env.TIDAL_FILE || path.join(process.cwd(), "tidal-mcp-output.tidal");
const useGhci = process.env.TIDAL_USE_GHCI === "true" || process.env.TIDAL_USE_GHCI === "1";
const bootTidalPath = process.env.TIDAL_BOOT_PATH;
const logFile = process.env.TIDAL_LOG_FILE; // Optional: custom log file path

const config: TidalConfig = {
  tidalFile,
  bootTidalPath,
  useGhci,
  logFile,
};

const server = new TidalMCPServer(config);
server.run().catch(console.error);
