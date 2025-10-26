# 🚀 Quick Start Guide

## 5-Minute Setup

### 1. Prerequisites Check

```bash
# Check Node.js (need 18+)
node --version

# Check if TidalCycles is installed
ghci
> :m Sound.Tidal.Context
> :quit

# Check SuperCollider
# Open SuperCollider and run: SuperDirt.start
```

### 2. Install MCP Server

```bash
cd tidal-mcp-server
npm install
npm run build
```

### 3. Configure Claude Desktop

**Find your config file:**
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- Linux: `~/.config/Claude/claude_desktop_config.json`

**Add this (replace paths with yours):**

```json
{
  "mcpServers": {
    "tidal": {
      "command": "node",
      "args": [
        "/Users/yourname/tidal-mcp-server/dist/index.js"
      ],
      "env": {
        "TIDAL_FILE": "/Users/yourname/tidal-output.tidal"
      }
    }
  }
}
```

### 4. Set Up TidalCycles to Watch the File

**Option A: VS Code**
1. Install TidalCycles extension
2. Open `tidal-output.tidal`
3. It will auto-evaluate on save

**Option B: Auto-watch Script**
```bash
# Install watchexec: brew install watchexec (macOS)
watchexec -w tidal-output.tidal "cat tidal-output.tidal | ghci -ghci-script BootTidal.hs"
```

**Option C: Vim/Neovim**
Add to your config:
```vim
autocmd BufWritePost tidal-output.tidal silent !cat % | ghci -ghci-script BootTidal.hs &
```

### 5. Start Making Music!

1. Open SuperCollider and run `SuperDirt.start`
2. Start your file watcher (if using Option B/C above)
3. Restart Claude Desktop
4. Start chatting!

## First Conversation

```
You: "Create a simple drum pattern in TidalCycles"

Claude: [Uses tidal_eval tool]
        "I'll create a classic house beat:
         d1 $ sound "bd sd bd sd""

You: "Add hi-hats"

Claude: [Uses tidal_eval on d2]
        "Added 16th note hi-hats:
         d2 $ sound "hh*16""

You: "What's playing?"

Claude: [Uses tidal_get_state]
        "Active channels:
         - d1: sound "bd sd bd sd" (15s ago)
         - d2: sound "hh*16" (5s ago)"
```

## Troubleshooting

### Nothing plays
- Is SuperCollider running with SuperDirt started?
- Is your file watcher running?
- Check the TIDAL_FILE path in config

### MCP not connecting
- Check Node.js path: `which node`
- Use absolute paths in config
- Restart Claude Desktop after config changes

### Patterns evaluate but no sound
- Check SuperCollider output for errors
- Try manually: `d1 $ sound "bd"` in TidalCycles
- Check audio output settings in SuperCollider

## Tips

1. **Keep SuperCollider's post window visible** to see what's happening
2. **Start simple** - get one sound working before building complexity
3. **Use `tidal_hush`** to stop everything if it gets chaotic
4. **Check history** - use `tidal_get_history` to see what you've tried
5. **Ask Claude to explain** - it can teach you Tidal while you code

## Next Steps

- Read the full README.md
- Explore TidalCycles documentation
- Join the TOPLAP/Algorave community
- Share your AI-assisted live coding sessions!

---

**Happy live coding! 🌀**
