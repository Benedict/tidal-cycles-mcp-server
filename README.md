# 🌀 TidalCycles MCP Server

**Conversational live coding with Claude AI + TidalCycles**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node Version](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen)](https://nodejs.org/)

This MCP (Model Context Protocol) server enables Claude to control TidalCycles through natural conversation, creating a powerful AI-assisted live coding experience for algorithmic music composition.

## ✨ Features

- 🎵 **Evaluate TidalCycles patterns** through conversational AI
- 📊 **State awareness** - Claude knows what's currently playing
- 🕰️ **Pattern history** - Track and recall previous patterns
- 🎛️ **Channel management** - Solo, silence, or hush specific channels
- 💬 **Natural conversation** - Talk to Claude about your music in plain English
- 🔄 **Real-time feedback** - Immediate pattern evaluation
- 🚀 **Dual transport modes**: stdio for Claude Desktop + WebSocket for external clients
- 🌐 **Network accessible** - Web UIs and remote clients can connect via WebSocket
- 🔄 **Auto-recovery** - Robust GHCi process management with automatic reconnection

## 📋 Prerequisites

Before installing, ensure you have:

1. **TidalCycles** - Install from [tidalcycles.org](https://tidalcycles.org/docs/getting-started/tidal-install)
   - Includes GHCi (Glasgow Haskell Compiler Interactive)
   - Haskell Stack or Cabal
   
2. **SuperCollider + SuperDirt** - Required for audio output
   - Download from [supercollider.github.io](https://supercollider.github.io/downloads)
   - Install SuperDirt: In SuperCollider, run `Quarks.install("SuperDirt")`
   - Install samples: `Quarks.install("Dirt-Samples")`
   
3. **Claude Desktop** - Get from [claude.ai](https://claude.ai/download)

4. **Node.js 18+** - For running the MCP server
   - Download from [nodejs.org](https://nodejs.org/)
   - Verify: `node --version`

## 🚀 Quick Start

### 1. Installation

```bash
# Clone the repository
git clone https://github.com/yourusername/tidal-mcp-server.git
cd tidal-mcp-server

# Install dependencies
npm install

# Build the server
npm run build
```

### 2. Start SuperCollider

Open SuperCollider and run:

```supercollider
// Start SuperDirt
SuperDirt.start;

// Verify it's listening
// Should see: "SuperDirt: listening to Tidal on port 57120"
```

### 3. Configure Claude Desktop

Add this to your Claude Desktop configuration file:

**macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`  
**Windows**: `%APPDATA%\Claude\claude_desktop_config.json`  
**Linux**: `~/.config/Claude/claude_desktop_config.json`

#### File-based Mode (Recommended for stability):

```json
{
  "mcpServers": {
    "tidal": {
      "command": "node",
      "args": [
        "/absolute/path/to/tidal-mcp-server/dist/index.js"
      ],
      "env": {
        "TIDAL_FILE": "/absolute/path/to/tidal-mcp-server/tidal-mcp-output.tidal"
      }
    }
  }
}
```

#### Direct GHCi Mode (Experimental - no restarts):

```json
{
  "mcpServers": {
    "tidal": {
      "command": "node",
      "args": [
        "/absolute/path/to/tidal-mcp-server/dist/index.js"
      ],
      "env": {
        "TIDAL_FILE": "/absolute/path/to/tidal-mcp-server/tidal-mcp-output.tidal",
        "TIDAL_USE_GHCI": "true",
        "TIDAL_BOOT_PATH": "/absolute/path/to/tidal-mcp-server/BootTidal.hs",
        "GHCI_PATH": "/usr/local/bin/ghci"
      }
    }
  }
}
```

**Finding your ghci path:**
```bash
which ghci
# Use this path for GHCI_PATH
```

Replace `/absolute/path/to/` with the actual path to your installation.

### 4. File Watching Setup (File-based mode only)

For file-based mode, you need to watch the output file and evaluate it in TidalCycles:

**Option A: Using watchexec (recommended)**

```bash
# Install watchexec
brew install watchexec  # macOS
# or
cargo install watchexec-cli  # Any OS with Rust

# Watch and auto-reload patterns
cd /path/to/tidal-mcp-server
watchexec --restart -w tidal-mcp-output.tidal \
  "ghci -ghci-script BootTidal.hs -ghci-script tidal-mcp-output.tidal"
```

**Option B: Using your editor**

Open `tidal-mcp-output.tidal` in your preferred editor with TidalCycles support and manually evaluate patterns when Claude writes them.

### 5. Start Using

1. **Restart Claude Desktop** to load the MCP server
2. **Start a new conversation**
3. **Make music!**

```
You: Create a funky drum pattern

Claude: [calls tidal_eval]
       I'll create a syncopated funk groove:
       d1 $ sound "bd ~ bd ~ bd ~ ~ ~"

You: Add a bassline

Claude: [calls tidal_eval on d2]
       Added a groovy bassline:
       d2 $ sound "bass2*8" # n "0 3 5 7"
```

## 🎹 Usage Examples

### Basic Patterns

```
You: Play a simple drum beat
You: Make it faster
You: Add some hi-hats
You: What's playing right now?
```

### Advanced Composition

```
You: Create a glitchy breakbeat with euclidean rhythms
You: Add a wobbling bassline with filter sweeps
You: Layer some atmospheric pads over the top
You: Make the whole thing more sparse
```

### Live Performance

```
You: Solo channel d2
You: Bring back everything
You: Hush
You: Show me the last 5 patterns I evaluated
```

## 🛠️ Available Tools

The MCP server exposes these tools to Claude:

### `tidal_eval`
Evaluate a TidalCycles pattern on a specific channel (d1-d9).

**Parameters:**
- `channel`: String (d1-d9)
- `pattern`: String (TidalCycles code without the `d1 $` prefix)

**Example:**
```javascript
{
  "channel": "d1",
  "pattern": "sound \"bd sd bd sd\" # gain \"1.2\""
}
```

### `tidal_hush`
Stop all currently playing patterns immediately.

### `tidal_silence`
Stop a specific channel gracefully.

**Parameters:**
- `channel`: String (d1-d9)

### `tidal_get_state`
Get current state of all channels - what's playing and when it started.

### `tidal_solo`
Solo a specific channel, muting all others.

**Parameters:**
- `channel`: String (d1-d9)

### `tidal_unsolo`
Restore all channels after soloing.

### `tidal_get_history`
Get pattern history from the current session.

**Parameters:**
- `limit`: Number (optional, default: 10)

## 📁 Project Structure

```
tidal-mcp-server/
├── src/
│   ├── index.ts              # Main MCP server implementation
│   └── websocket-transport.ts # WebSocket transport layer
├── dist/                     # Compiled JavaScript output
├── BootTidal.hs             # TidalCycles initialization
├── tidal-mcp-output.tidal   # Generated pattern output file
├── start-websocket.sh       # WebSocket server startup script
├── test-websocket-client.js # WebSocket connection test
├── examples.tidal            # Example patterns
├── WEBSOCKET-USAGE.md       # WebSocket setup and usage guide
├── package.json             # Node.js dependencies
├── tsconfig.json            # TypeScript configuration
├── README.md                # This file
├── QUICKSTART.md            # Quick reference guide
├── CONTRIBUTING.md          # Contribution guidelines
└── LICENSE                  # MIT License

```

## 🎨 Use Cases

### Live Performance
- Generate patterns on the fly during algoraves
- Quick iterations and experimentation
- Emergency pattern generation when stuck
- AI-assisted improvisation

### Learning & Exploration
- Ask Claude to explain TidalCycles concepts
- Generate example patterns for specific techniques
- Explore new rhythmic and harmonic ideas
- Learn by conversation

### Composition
- Rapid prototyping of musical ideas
- Generate pattern variations
- Collaborative composition with AI
- Build complex layered arrangements

## 🔧 Architecture

```
┌─────────┐         ┌──────────────┐         ┌──────────────┐
│ Claude  │ ◄─MCP─► │  MCP Server  │ ◄─────► │ TidalCycles  │
│   AI    │         │  (Node.js)   │         │    (GHCi)    │
└─────────┘         └──────────────┘         └──────────────┘
                            │                         │
                            │ (File mode)             │
                            ▼                         ▼
                    ┌──────────────┐         ┌──────────────┐
                    │ .tidal file  │         │ SuperCollider│
                    │   (watch)    │         │  SuperDirt   │
                    └──────────────┘         └──────────────┘
```

**Flow:**
1. You talk to Claude in natural language
2. Claude uses MCP tools to generate Tidal code
3. MCP server either:
   - **File mode**: Writes code to `.tidal` file → File watcher evaluates it
   - **Direct mode**: Sends directly to running GHCi process
4. TidalCycles/GHCi sends OSC messages to SuperDirt
5. SuperCollider/SuperDirt plays the audio

## 🐛 Troubleshooting

### "MCP server not connecting"
- Check the path in `claude_desktop_config.json` is absolute
- Restart Claude Desktop after config changes
- Check Node.js version: `node --version` (need 18+)
- Check MCP server logs in Claude Desktop

### "Patterns not playing" (File mode)
- Ensure SuperCollider is running: `SuperDirt.start`
- Verify file watcher (watchexec) is running
- Check the TIDAL_FILE path is correct
- Try manually evaluating the file in your editor

### "Patterns not playing" (Direct GHCi mode)
- Check ghci is in PATH: `which ghci`
- Verify GHCI_PATH in config matches `which ghci`
- Check MCP server logs for "GHCi/TidalCycles started and connected"
- Ensure only one GHCi instance is running

### "spawn ghci ENOENT"
- GHCi not found in PATH
- Set GHCI_PATH environment variable with full path
- On macOS with ghcup: usually `/Users/username/.ghcup/bin/ghci`

### "No samples found" / Empty sound library
- Install Dirt-Samples in SuperCollider:
  ```supercollider
  Quarks.install("Dirt-Samples");
  // Recompile (Cmd+K)
  SuperDirt.start;
  ```
- Verify: `~dirt.soundLibrary.buffers.keys.do({|x| x.postln});`

### "Late" messages in SuperCollider
- Normal at fast tempos (jungle/DnB)
- If severe (>1 second), restart SuperDirt
- Check system audio settings
- Reduce pattern complexity

### Music continues after stopping MCP server
- Patterns run in SuperCollider, independent of MCP server
- Stop in SuperCollider: `s.freeAll;`
- Or in any GHCi/Tidal session: `hush`
- Kill all ghci processes: `pkill -9 ghci`

## 🚧 Known Limitations

- **File mode**: Restarts GHCi on every change (causes brief audio dropout)
- **Direct GHCi mode**: Experimental, may have edge cases
- **No visual feedback**: Pattern changes aren't visible in editor (file mode)
- **Single instance**: Can't run multiple MCP servers simultaneously
- **No undo**: Pattern changes are immediate and can't be undone

## 🗺️ Roadmap

### ✅ Completed Features

- **Direct GHCi integration** - Real-time pattern evaluation without file watching
- **WebSocket transport** - Network-accessible server for web UIs and collaboration
- **Robust error handling** - GHCi process recovery and connection monitoring
- **Session logging** - Complete pattern history with timestamps

### 🚀 Next Up (Priority Features)

- **MIDI Controller Input** - Physical knobs/faders control Tidal parameters
  - MIDI learn mode for easy mapping
  - Support for popular controllers (Push, Launchpad, etc.)
  - Macro controls for complex parameter automation

- **Pattern Version Control** - Git-like history for your patterns
  - Undo/redo system with branching
  - Save/restore snapshots
  - Compare pattern versions

- **Browser-based UI** - Real-time pattern visualization
  - Live waveform display
  - Channel timeline view
  - WebSocket integration for multiple UIs

### 🌟 Advanced Features

- **Real-time Audio Analysis** - AI gets audio feedback
  - Frequency analysis to inform pattern choices
  - Beat detection for tempo sync
  - Amplitude monitoring for mix balance

- **AI Pattern Suggestions** - Context-aware recommendations
  - ML-based pattern generation
  - Style-specific suggestions (techno, ambient, breaks)
  - Automatic complementary pattern creation

- **Multi-user Collaboration** - Live coding sessions
  - Multiple users control different channels
  - Turn-based jamming modes
  - Shared pattern library

### 🎨 Creative Integrations

- **Hydra Visual Integration** - Reactive visuals
  - Auto-generate visuals from audio patterns
  - Synchronized visual effects with beat events
  - Live visual coding alongside audio

- **DAW Integration** - Professional workflow
  - MIDI output to hardware synths
  - Audio recording of Tidal sessions
  - Timeline sync with Ableton Live/Logic

- **AI Composition Tools** - Advanced creativity
  - Generate full track structures
  - Style transfer between genres
  - Harmony analysis and suggestions

## 🤝 Contributing

Contributions are welcome! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

Quick start for contributors:

```bash
# Clone and setup
git clone https://github.com/yourusername/tidal-mcp-server.git
cd tidal-mcp-server
npm install

# Development mode (with auto-rebuild)
npm run dev

# Run tests
npm test

# Build for production
npm run build
```

## 📚 Resources

- [TidalCycles Documentation](https://tidalcycles.org/docs/)
- [Model Context Protocol](https://modelcontextprotocol.io/)
- [SuperCollider Documentation](https://doc.sccode.org/)
- [Algorave Community](https://algorave.com/)
- [TOPLAP - Live Coding](https://toplap.org/)

## 📄 License

MIT License - see [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- **Alex McLean (yaxu)** for creating TidalCycles
- **The TOPLAP and algorave communities** for live coding culture
- **Anthropic** for the Model Context Protocol and Claude
- **Everyone who live codes and makes weird music with computers**

## 📞 Support

- **Issues**: [GitHub Issues](https://github.com/yourusername/tidal-mcp-server/issues)
- **Discussions**: [GitHub Discussions](https://github.com/yourusername/tidal-mcp-server/discussions)
- **TidalCycles Community**: [Discord](https://discord.gg/CqWhZEfNbq)

---

**Made with 🌀 for the live coding community**

*Go forth and make some algorithmic noise!*
