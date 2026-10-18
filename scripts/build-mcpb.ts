/**
 * Builds tidal-mcp-server.mcpb, a one-click install for Claude Desktop.
 *
 * Copies the built server, the web pages, BootTidal.hs and the production
 * dependencies into .mcpb-build/, writes manifest.json (version from
 * package.json; tools from the built server itself, so it can't drift), then
 * validates and packs it with the official mcpb CLI.
 *
 * Usage: npm run build && npm run bundle
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Run with npx rather than a devDependency: its interactive `init` pulls in
// packages npm audit flags, and we only need validate and pack.
const MCPB = "@anthropic-ai/mcpb@2.1.2";

const root = path.resolve(import.meta.dirname, "..");
const stage = path.join(root, ".mcpb-build");
const output = path.join(root, "tidal-mcp-server.mcpb");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8"));
const npx = process.platform === "win32" ? "npx.cmd" : "npx";
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const run = (cmd: string, args: string[], cwd = root) =>
  execFileSync(cmd, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });

if (!fs.existsSync(path.join(root, "dist", "index.js"))) {
  console.error("dist/ is missing; run npm run build first.");
  process.exit(1);
}

fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage);
for (const item of ["dist", "ui", "BootTidal.hs", "examples.tidal", "LICENSE", "README.md", "package.json", "package-lock.json"]) {
  fs.cpSync(path.join(root, item), path.join(stage, item), { recursive: true });
}
// Declaration files aren't needed at runtime
for (const file of fs.readdirSync(path.join(stage, "dist"))) {
  if (file.endsWith(".d.ts")) fs.rmSync(path.join(stage, "dist", file));
}
run(npm, ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error"], stage);

// Ask the built server what tools it has
const client = new Client({ name: "build-mcpb", version: "1" });
await client.connect(
  new StdioClientTransport({ command: process.execPath, args: [path.join(stage, "dist", "index.js")], stderr: "ignore" })
);
const { tools } = await client.listTools();
await client.close();
const firstSentence = (text = "") => text.split(/(?<=\.)\s/)[0];

const manifest = {
  manifest_version: "0.3",
  name: pkg.name,
  display_name: "TidalCycles",
  version: pkg.version,
  description: "Play TidalCycles (and Strudel) from Claude. Tidal's errors come back to Claude, so it can fix its own patterns.",
  long_description:
    "Claude writes Tidal code and this server plays it, keeping track of each channel. In GHCi mode it runs Tidal for you and " +
    "returns GHC's errors. Build channels from layers, let an autopilot evolve them, change values smoothly through Tidal's " +
    "control port, check samples exist, and share the session with your editor. Needs TidalCycles and SuperCollider with SuperDirt.",
  author: { name: "Benedict Steele", url: "https://github.com/Benedict" },
  repository: { type: "git", url: "https://github.com/Benedict/tidal-cycles-mcp-server" },
  homepage: "https://github.com/Benedict/tidal-cycles-mcp-server#readme",
  documentation: "https://github.com/Benedict/tidal-cycles-mcp-server#readme",
  support: "https://github.com/Benedict/tidal-cycles-mcp-server/issues",
  license: pkg.license,
  keywords: ["tidalcycles", "strudel", "live-coding", "music", "algorave", "supercollider"],
  server: {
    type: "node",
    entry_point: "dist/index.js",
    mcp_config: {
      command: "node",
      args: ["${__dirname}/dist/index.js"],
      env: {
        TIDAL_USE_GHCI: "${user_config.use_ghci}",
        GHCI_PATH: "${user_config.ghci_path}",
        TIDAL_BOOT_PATH: "${user_config.boot_path}",
        TIDAL_FILE: "${user_config.tidal_file}",
        TIDAL_UI_PORT: "${user_config.ui_port}",
        TIDAL_SHARE_SESSION: "${user_config.share_session}",
      },
    },
  },
  tools: tools.map((t) => ({ name: t.name, description: firstSentence(t.description) })),
  compatibility: { platforms: ["darwin", "win32", "linux"], runtimes: { node: pkg.engines?.node ?? ">=22.0.0" } },
  // Every setting has a default, so no ${user_config.…} is ever left unfilled
  user_config: {
    use_ghci: {
      type: "boolean",
      title: "Run Tidal for me",
      description: "Start Tidal (GHCi) inside the server, so Claude gets Tidal's errors back. Turn off to only write code to a file for your editor to run.",
      default: true,
    },
    ghci_path: {
      type: "string",
      title: "ghci",
      description: "Path to ghci. With ghcup it's usually ~/.ghcup/bin/ghci (C:\\ghcup\\bin\\ghci.exe on Windows). Leave as ghci if it's on your PATH.",
      default: "ghci",
    },
    boot_path: {
      type: "string",
      title: "Boot file",
      description: "BootTidal.hs to start Tidal with. The default is the one that comes with the server.",
      default: "${__dirname}/BootTidal.hs",
    },
    tidal_file: {
      type: "string",
      title: "Output file",
      description: "Where to write code in file mode. The session log goes next to it.",
      default: "${HOME}/tidal-mcp-output.tidal",
    },
    ui_port: {
      type: "string",
      title: "Web page port",
      description: "Set a port (e.g. 7070) for the control page and the Strudel page. Leave empty for none.",
      default: "",
    },
    share_session: {
      type: "boolean",
      title: "Share the session with my editor",
      description: "Let your editor use this server's Tidal (point its ghci path at ~/.tidal-mcp/bin). macOS and Linux.",
      default: false,
    },
  },
};
fs.writeFileSync(path.join(stage, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

fs.rmSync(output, { force: true });
run(npx, ["-y", MCPB, "validate", path.join(stage, "manifest.json")]);
run(npx, ["-y", MCPB, "pack", stage, output]);
console.log(`Built ${path.relative(root, output)} (${manifest.tools.length} tools, version ${manifest.version}).`);
