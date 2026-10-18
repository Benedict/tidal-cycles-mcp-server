# TidalCycles MCP Server

An [MCP](https://modelcontextprotocol.io/) server that lets Claude (or any MCP client) play [TidalCycles](https://tidalcycles.org/) patterns. You describe what you want, Claude writes the Tidal code, and the server evaluates it on `d1`–`d9`.

It keeps track of what's playing on each channel, so you can say "make the hi-hats busier" and Claude knows what the hi-hats currently are.

## Requirements

- Node.js 22 or later
- [TidalCycles](https://tidalcycles.org/docs/getting-started/tidal-install), which includes GHCi
- SuperCollider with SuperDirt and the Dirt-Samples: in SuperCollider run `Quarks.install("SuperDirt")` and `Quarks.install("Dirt-Samples")`, then recompile the class library
- An MCP client, such as Claude Desktop or Claude Code

## Install

There's nothing to install separately: your MCP client runs the server with `npx`, which downloads it on first use. See [Configure your client](#configure-your-client).

To work on the server itself, see [Development](#development).

Start SuperDirt in SuperCollider before you use the server. Plain `SuperDirt.start` fails with "No more buffer numbers" once the full Dirt-Samples library is installed, because SuperCollider's default buffer limit is too low. Raise the limit first:

```supercollider
(
s.reboot {
    s.options.numBuffers = 1024 * 256;
    s.options.memSize = 8192 * 32;
    s.options.numWireBufs = 2048;
    s.options.maxNodes = 1024 * 32;
    s.options.numOutputBusChannels = 2;
    s.options.numInputBusChannels = 2;
    s.waitForBoot {
        ~dirt = SuperDirt(2, s);
        ~dirt.loadSoundFiles;
        s.sync;
        ~dirt.start(57120, 0 ! 12);
    };
    s.latency = 0.3;
};
)
```

To run this every time SuperCollider starts, put it in your startup file (File → Open startup file).

## Configure your client

The server has two ways of getting code to Tidal.

### Direct GHCi mode (recommended)

The server starts GHCi with `BootTidal.hs` itself and sends each command to it. If Tidal rejects a pattern, for example because it doesn't type-check, the error goes back to Claude, and the server's state stays as it was. Tidal also keeps playing whatever was on that channel before. If GHCi dies or stops responding, the server restarts it on the next call.

Claude Desktop (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS, `%APPDATA%\Claude\claude_desktop_config.json` on Windows):

```json
{
  "mcpServers": {
    "tidal": {
      "command": "npx",
      "args": ["-y", "tidal-mcp-server"],
      "env": {
        "TIDAL_USE_GHCI": "true",
        "GHCI_PATH": "/path/to/ghci"
      }
    }
  }
}
```

Claude Code:

```bash
claude mcp add tidal \
  -e TIDAL_USE_GHCI=true \
  -e GHCI_PATH="$(which ghci)" \
  -- npx -y tidal-mcp-server
```

Use `which ghci` to find `GHCI_PATH`. With ghcup it's usually `~/.ghcup/bin/ghci`.

The server boots Tidal with the `BootTidal.hs` it ships with. To use your own instead, for example the one your editor uses, set `TIDAL_BOOT_PATH`.

### File mode

Nothing runs GHCi for you. Each tool call overwrites `TIDAL_FILE` with the latest command, and you evaluate it yourself, for example from an editor with Tidal support.

```json
"env": {
  "TIDAL_FILE": "/path/to/tidal-mcp-output.tidal"
}
```

The file only ever holds the most recent command. Use file mode when you want to see and approve each command before it plays.

## Tools

| Tool | Arguments | What it does |
|------|-----------|--------------|
| `tidal_eval` | `channel` (`d1`–`d9`), `pattern` | Runs `<channel> $ <pattern>` |
| `tidal_silence` | `channel` | Runs `<channel> silence` |
| `tidal_hush` | — | Stops everything |
| `tidal_solo` | `channel` | Runs `solo <n>` |
| `tidal_unsolo` | — | Unsolos every channel that was soloed |
| `tidal_get_state` | `quiet` (optional) | Lists what's playing on each channel, when it started, and the tempo. `quiet` skips logging, for clients that poll |
| `tidal_set_tempo` | `bpm` | Sets the tempo, assuming four beats per cycle |
| `tidal_get_history` | `limit` (default 10) | Lists recent patterns, newest first |
| `tidal_set_layer` | `channel`, `name`, `kind`, `code`, `variants` (optional) | Adds or replaces one layer of a channel and re-evaluates it |
| `tidal_remove_layer` | `channel`, `name` | Removes a layer and re-evaluates the channel |
| `tidal_autopilot` | `action` (`start`, `pause`, `stop`, `status`), optional timing | Keeps layered channels changing between turns |
| `tidal_palette` | — | Lists Tidal transforms, sources and controls that combine well |

### Layers

Instead of one pattern string, a channel can be built from named layers:

```
every 3 (jux rev) $ chop 4 $ s "bd*2 [~ sd]" # crush 4 # n "0 1"
└── transform ──┘   └ tr ┘   └─── source ───┘   └ control ┘  └ control ┘
```

Claude can change one layer, such as swapping `chop 4` for `striate 8`, without rewriting the rest. Transforms apply in the order they were added, outermost first. Each channel has one source. `tidal_eval` on a channel replaces its layers.

### Autopilot

Claude can only change the music when you message it. The autopilot keeps layered channels moving in between. Each layer that has variants, and every transform layer, changes on its own random timer (10–40 seconds by default). A layer either switches to another of its variants, or, if it's a transform, sometimes drops out for a while and comes back later. `pause` freezes things as they are. `stop` also hushes everything.

Each session is also written to `tidal-mcp-session.log`, next to `TIDAL_FILE`, or wherever `TIDAL_LOG_FILE` points.

## Environment variables

| Variable | Default | |
|----------|---------|--|
| `TIDAL_USE_GHCI` | `false` | `true` for direct GHCi mode |
| `TIDAL_BOOT_PATH` | the `BootTidal.hs` in the package | Boot script passed to GHCi |
| `GHCI_PATH` | `ghci` | GHCi binary |
| `TIDAL_FILE` | `./tidal-mcp-output.tidal` | Output file in file mode |
| `TIDAL_LOG_FILE` | next to `TIDAL_FILE` | Session log |
| `TIDAL_TRANSPORT` | `stdio` | `websocket` to serve MCP over WebSocket instead |

For the WebSocket transport and its settings, see [WEBSOCKET-USAGE.md](WEBSOCKET-USAGE.md). For more configuration detail, see [CONFIGURATION.md](CONFIGURATION.md).

## Troubleshooting

**`spawn ghci ENOENT`:** GHCi isn't on the server's `PATH`. Set `GHCI_PATH` to the full path.

**Nothing plays:**
1. Check SuperDirt is running and shows `listening to Tidal on port 57120`.
2. In GHCi mode, look in the client's MCP logs for `[GHCI]` lines. Startup problems, such as Tidal not being installed, show up there.

**Sound keeps going after the server stops:** the server stops GHCi when it shuts down. If a GHCi process outlives it, run `pkill ghci`, or in SuperCollider run `s.freeAll`.

**No samples:** install Dirt-Samples (see Requirements), then restart SuperDirt.

**`ERROR: No more buffer numbers` when SuperDirt starts:** SuperCollider's buffer limit is too low for Dirt-Samples. Use the startup code under Install instead of `SuperDirt.start`.

## Limitations

- The server only knows what it has sent. If you also evaluate code by hand in the same Tidal session, `tidal_get_state` won't reflect it.
- Type errors come back to Claude, but runtime errors don't. Tidal prints those on its own while the pattern plays, so the server only logs them. File mode has no feedback at all.
- The pattern is arbitrary Haskell, run with your user's permissions. Only connect clients you trust.

## Development

```bash
git clone https://github.com/Benedict/tidal-cycles-mcp-server.git
cd tidal-cycles-mcp-server
npm install
npm run build
npm run dev     # run from source with tsx
npm test                 # build, then run the test suite against dist/
npm run typecheck:tidal  # type-check generated Tidal code against your Tidal install
npm run smoke:ghci       # run the built server in GHCi mode against your Tidal (silent patterns only)
```

The tests drive the built server over stdio in file mode, so they don't need GHCi or SuperCollider.

`typecheck:tidal` starts GHCi with `BootTidal.hs` and runs `:t` on every command the server sends and every palette entry. `:t` checks types without evaluating anything, so nothing plays. `smoke:ghci` only plays rests on `d9`, so it's safe to run with SuperDirt up. Set `GHCI_PATH` if `ghci` isn't on your `PATH`. CI runs all of these.

Design notes for possible future features are in `feature-designs.md`, `midi-input-design.md` and `websocket-design.md`.

## License

MIT
