# Configuration Guide

Complete guide to configuring the TidalCycles MCP Server.

## Configuration File Location

The configuration file for Claude Desktop is located at:

- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
- **Linux**: `~/.config/Claude/claude_desktop_config.json`

## Environment Variables

The MCP server supports the following environment variables:

### Required Variables

#### `TIDAL_FILE`
**Type**: String (absolute path)  
**Required**: Yes  
**Description**: Path to the TidalCycles output file where patterns will be written.

**Example**:
```json
"TIDAL_FILE": "/Users/username/Development/tidal-mcp-server/tidal-mcp-output.tidal"
```

**Notes**:
- Must be an absolute path
- File will be created if it doesn't exist
- Used in both file-based and direct GHCi modes

---

### Optional Variables

#### `TIDAL_USE_GHCI`
**Type**: Boolean (string: "true" or "false")  
**Required**: No  
**Default**: `"false"`  
**Description**: Enables direct GHCi integration mode for seamless pattern updates without restarts.

**Example**:
```json
"TIDAL_USE_GHCI": "true"
```

**Values**:
- `"true"` or `"1"` - Enable direct GHCi mode
- `"false"` or `"0"` - Use file-based mode (default)

**When to use**:
- ✅ **Use "true"** for live performance (no audio dropouts)
- ❌ **Use "false"** for more stability and easier debugging

---

#### `TIDAL_BOOT_PATH`
**Type**: String (absolute path)  
**Required**: Only if `TIDAL_USE_GHCI="true"`  
**Default**: `"BootTidal.hs"` (relative to working directory)  
**Description**: Path to the BootTidal.hs initialization file for GHCi.

**Example**:
```json
"TIDAL_BOOT_PATH": "/Users/username/Development/tidal-mcp-server/BootTidal.hs"
```

**Notes**:
- Only used in direct GHCi mode
- Must point to a valid BootTidal.hs file
- If not specified, looks for BootTidal.hs in the current directory

---

#### `GHCI_PATH`
**Type**: String (absolute path to executable)  
**Required**: Only if `TIDAL_USE_GHCI="true"` and ghci is not in system PATH  
**Default**: `"ghci"` (uses system PATH)  
**Description**: Full path to the ghci executable.

**Example**:
```json
"GHCI_PATH": "/Users/username/.ghcup/bin/ghci"
```

**Finding your ghci path**:
```bash
which ghci
# macOS/Linux example output: /usr/local/bin/ghci
# or with ghcup: /Users/username/.ghcup/bin/ghci
```

**Common locations**:
- macOS (Homebrew): `/usr/local/bin/ghci`
- macOS (ghcup): `/Users/username/.ghcup/bin/ghci`
- Linux (system): `/usr/bin/ghci`
- Linux (ghcup): `~/.ghcup/bin/ghci`
- Windows (ghcup): `C:\ghcup\bin\ghci.exe`

**Notes**:
- Only required if ghci is not in your system PATH
- Critical for direct GHCi mode to work
- If you see "spawn ghci ENOENT" errors, set this variable

---

## Complete Configuration Examples

### Example 1: File-Based Mode (Recommended for Beginners)

```json
{
  "mcpServers": {
    "tidal": {
      "command": "node",
      "args": [
        "/Users/username/Development/tidal-mcp-server/dist/index.js"
      ],
      "env": {
        "TIDAL_FILE": "/Users/username/Development/tidal-mcp-server/tidal-mcp-output.tidal"
      }
    }
  }
}
```

**Setup required**:
1. SuperCollider with SuperDirt running
2. File watcher (watchexec) monitoring the TIDAL_FILE
3. GHCi session evaluating the watched file

---

### Example 2: Direct GHCi Mode (Recommended for Live Performance)

```json
{
  "mcpServers": {
    "tidal": {
      "command": "node",
      "args": [
        "/Users/username/Development/tidal-mcp-server/dist/index.js"
      ],
      "env": {
        "TIDAL_FILE": "/Users/username/Development/tidal-mcp-server/tidal-mcp-output.tidal",
        "TIDAL_USE_GHCI": "true",
        "TIDAL_BOOT_PATH": "/Users/username/Development/tidal-mcp-server/BootTidal.hs",
        "GHCI_PATH": "/Users/username/.ghcup/bin/ghci"
      }
    }
  }
}
```

**Setup required**:
1. SuperCollider with SuperDirt running
2. ghci accessible (verify with `which ghci`)
3. BootTidal.hs file exists at specified path

---

### Example 3: Minimal Configuration (Using System Defaults)

```json
{
  "mcpServers": {
    "tidal": {
      "command": "node",
      "args": [
        "/Users/username/Development/tidal-mcp-server/dist/index.js"
      ],
      "env": {
        "TIDAL_FILE": "/Users/username/tidal-output.tidal",
        "TIDAL_USE_GHCI": "true"
      }
    }
  }
}
```

**Notes**:
- Uses default BootTidal.hs location
- Assumes ghci is in system PATH
- Minimal configuration, relies on defaults

---

## Platform-Specific Examples

### macOS with Homebrew

```json
{
  "mcpServers": {
    "tidal": {
      "command": "node",
      "args": [
        "/Users/username/Development/tidal-mcp-server/dist/index.js"
      ],
      "env": {
        "TIDAL_FILE": "/Users/username/Development/tidal-mcp-server/tidal-mcp-output.tidal",
        "TIDAL_USE_GHCI": "true",
        "TIDAL_BOOT_PATH": "/Users/username/Development/tidal-mcp-server/BootTidal.hs",
        "GHCI_PATH": "/usr/local/bin/ghci"
      }
    }
  }
}
```

### macOS with ghcup

```json
{
  "mcpServers": {
    "tidal": {
      "command": "node",
      "args": [
        "/Users/username/Development/tidal-mcp-server/dist/index.js"
      ],
      "env": {
        "TIDAL_FILE": "/Users/username/Development/tidal-mcp-server/tidal-mcp-output.tidal",
        "TIDAL_USE_GHCI": "true",
        "TIDAL_BOOT_PATH": "/Users/username/Development/tidal-mcp-server/BootTidal.hs",
        "GHCI_PATH": "/Users/username/.ghcup/bin/ghci"
      }
    }
  }
}
```

### Linux

```json
{
  "mcpServers": {
    "tidal": {
      "command": "node",
      "args": [
        "/home/username/Development/tidal-mcp-server/dist/index.js"
      ],
      "env": {
        "TIDAL_FILE": "/home/username/Development/tidal-mcp-server/tidal-mcp-output.tidal",
        "TIDAL_USE_GHCI": "true",
        "TIDAL_BOOT_PATH": "/home/username/Development/tidal-mcp-server/BootTidal.hs",
        "GHCI_PATH": "/usr/bin/ghci"
      }
    }
  }
}
```

### Windows

```json
{
  "mcpServers": {
    "tidal": {
      "command": "node",
      "args": [
        "C:\\Users\\username\\Development\\tidal-mcp-server\\dist\\index.js"
      ],
      "env": {
        "TIDAL_FILE": "C:\\Users\\username\\Development\\tidal-mcp-server\\tidal-mcp-output.tidal",
        "TIDAL_USE_GHCI": "true",
        "TIDAL_BOOT_PATH": "C:\\Users\\username\\Development\\tidal-mcp-server\\BootTidal.hs",
        "GHCI_PATH": "C:\\ghcup\\bin\\ghci.exe"
      }
    }
  }
}
```

**Note**: Use double backslashes (`\\`) in Windows paths for JSON.

---

## Configuration Troubleshooting

### Issue: "spawn ghci ENOENT"

**Solution**: Set `GHCI_PATH` explicitly:
```bash
# Find ghci location
which ghci

# Add to config
"GHCI_PATH": "/output/from/which/ghci"
```

---

### Issue: "Cannot find BootTidal.hs"

**Solution**: Verify path and set `TIDAL_BOOT_PATH`:
```bash
# Check file exists
ls -la /path/to/tidal-mcp-server/BootTidal.hs

# Add absolute path to config
"TIDAL_BOOT_PATH": "/absolute/path/to/BootTidal.hs"
```

---

### Issue: "Patterns not playing"

**Check**:
1. SuperDirt is running: `SuperDirt.start` in SuperCollider
2. Config paths are absolute (not relative)
3. TIDAL_FILE path is writable
4. For file mode: watchexec is running
5. For GHCi mode: GHCI_PATH is correct

---

### Issue: "Config changes not taking effect"

**Solution**: Restart Claude Desktop completely:
1. Quit Claude Desktop (Cmd+Q on macOS)
2. Wait 5 seconds
3. Reopen Claude Desktop
4. Start new conversation

---

## Verifying Configuration

### Check MCP Server Logs

**macOS**:
```bash
tail -f ~/Library/Logs/Claude/mcp-server-tidal.log
```

**Linux**:
```bash
tail -f ~/.config/Claude/logs/mcp-server-tidal.log
```

**Look for**:
- `"TidalCycles MCP Server running on stdio"`
- `"Mode: Direct GHCi"` or `"Mode: File-based"`
- `"GHCi/TidalCycles started and connected"` (GHCi mode only)

---

### Test Pattern Evaluation

In Claude, ask:
```
Play a simple drum beat
```

You should see:
- Pattern code in the response
- Sound output from SuperCollider
- No error messages in logs

---

## Best Practices

### Development
- Use **file-based mode** for easier debugging
- Keep `TIDAL_FILE` in project directory
- Don't commit the output file to git

### Production/Performance
- Use **direct GHCi mode** for seamless updates
- Use absolute paths for all variables
- Test configuration before live performance

### Security
- Don't share config with sensitive paths
- Use environment-specific paths
- Review generated patterns before evaluation

---

## Additional Resources

- [Quick Start Guide](QUICKSTART.md)
- [Main README](README.md)
- [Troubleshooting Guide](README.md#troubleshooting)
- [MCP Documentation](https://modelcontextprotocol.io/)

---

**Need help?** Open an issue on [GitHub](https://github.com/yourusername/tidal-mcp-server/issues)
