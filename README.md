# TidalCycles MCP Server

An [MCP](https://modelcontextprotocol.io/) server that lets Claude (or any MCP client) play [TidalCycles](https://tidalcycles.org/) patterns. You describe what you want, Claude writes the Tidal code, and the server evaluates it on `d1`–`d9`.

It keeps track of what's playing on each channel, so you can say "make the hi-hats busier" and Claude knows what the hi-hats currently are.

## How it works

The server doesn't make music itself, and there's no AI inside it. It gives an MCP client a set of tools, such as "evaluate this pattern on `d2`" or "hush". The language model in the client decides what to call and writes the Tidal code.

What comes back keeps the model honest:

- **Tidal's own errors.** In GHCi mode, each pattern runs in a real Tidal session. If it doesn't type-check, the model gets GHC's error message and can fix it. Nothing changes on that channel in the meantime.
- **What's actually installed.** `tidal_list_samples` lists your sample banks and synths, and the server warns when a pattern uses one that doesn't exist. Tidal accepts those patterns, but they're silent.
- **What's playing.** `tidal_get_state` shows each channel's code, including anything you've played yourself in a shared session.
- **Idioms that work.** `tidal_palette` lists transforms and effects that are checked against real Tidal.

Everything the model sends is ordinary Tidal code, and it appears in the conversation and in the session log. You can read it, copy it into your own editor, or learn from it.

It works with any MCP client, not only Claude, including clients that run local models.

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

Use `which ghci` to find `GHCI_PATH`. With ghcup it's usually `~/.ghcup/bin/ghci`. On Windows, use `where ghci` (with ghcup, usually `C:\ghcup\bin\ghci.exe`).

The server boots Tidal with the `BootTidal.hs` it ships with. To use your own instead, for example the one your editor uses, set `TIDAL_BOOT_PATH`.

### Playing alongside Claude in your editor

By default, the server's Tidal and your editor's Tidal are separate. You hear both, but `hush` only stops one of them, and Claude can't see what you're playing. To share one Tidal session instead, set `TIDAL_SHARE_SESSION=true`. It needs GHCi mode, and it isn't available on Windows yet.

When sharing is on, the server writes a stand-in `ghci` into `~/.tidal-mcp/bin`. Point your editor at that folder; in Pulsar, set the TidalCycles package's **Ghci Path** to `~/.tidal-mcp/bin`. Then:

- Your code runs in the server's Tidal, so there's one `hush` and one clock.
- What you play shows up in `tidal_get_state`, so Claude can play along with it.
- Your errors appear in your editor's console, and Claude's go back to Claude.
- Your editor's `:script BootTidal.hs` is skipped, because the server has already booted Tidal. Use `TIDAL_BOOT_PATH` to make the server use your boot file instead.
- When the server isn't running, the stand-in runs your real `ghci`, so your editor still works on its own.

The connection is a socket in `~/.tidal-mcp` that only your user can open.

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
| `tidal_set_control` | `name`, `value`, `seconds` (optional) | Changes a value that patterns read with `cF`/`cS`, without re-evaluating; `seconds` glides to it |
| `tidal_list_samples` | `filter`, `refresh` (both optional) | Lists the sample banks and synths SuperDirt has installed |

### Layers

Instead of one pattern string, a channel can be built from named layers:

```
every 3 (jux rev) $ chop 4 $ s "bd*2 [~ sd]" # crush 4 # n "0 1"
└── transform ──┘   └ tr ┘   └─── source ───┘   └ control ┘  └ control ┘
```

Claude can change one layer, such as swapping `chop 4` for `striate 8`, without rewriting the rest. Transforms apply in the order they were added, outermost first. Each channel has one source. `tidal_eval` on a channel replaces its layers.

### Changing values while a pattern plays

Re-evaluating a pattern swaps it in all at once. For smooth changes, a pattern can read a named value with `cF` (numbers) or `cS` (strings):

```
d1 $ s "bd*4 hh*8" # lpf (cF 1000 "cutoff")
```

`tidal_set_control` then changes `cutoff` through Tidal's control port, with no re-evaluation. With `seconds`, the value glides there, for example a filter sweep over 16 seconds. The value number in `cF` is what's used until the control has been set. The server sends to the `cCtrlPort` set in the boot file (6011 in the bundled `BootTidal.hs`), or to Tidal's default 6010 in file mode.

### Autopilot

Claude can only change the music when you message it. The autopilot keeps layered channels moving in between. Each layer that has variants, and every transform layer, changes on its own random timer (10–40 seconds by default). A layer either switches to another of its variants, or, if it's a transform, sometimes drops out for a while and comes back later. `pause` freezes things as they are. `stop` also hushes everything.

If a pattern uses a sound SuperDirt doesn't have, Tidal still accepts it, but that part is silent. So the server checks every name used with `s` or `sound` against your Dirt-Samples folder and SuperDirt's synths, and warns Claude about any it can't find.

Each session is also written to `tidal-mcp-session.log`, next to `TIDAL_FILE`, or wherever `TIDAL_LOG_FILE` points.

## Environment variables

| Variable | Default | |
|----------|---------|--|
| `TIDAL_USE_GHCI` | `false` | `true` for direct GHCi mode |
| `TIDAL_BOOT_PATH` | the `BootTidal.hs` in the package | Boot script passed to GHCi |
| `GHCI_PATH` | `ghci` | GHCi binary |
| `TIDAL_FILE` | `./tidal-mcp-output.tidal` | Output file in file mode |
| `TIDAL_LOG_FILE` | next to `TIDAL_FILE` | Session log |
| `TIDAL_QUARKS_PATH` | SuperCollider's `downloaded-quarks` folder | Where to find Dirt-Samples and SuperDirt, if SuperCollider keeps them somewhere unusual |
| `TIDAL_SAMPLE_PATHS` | — | Extra sample folders to check names against, separated by `:` (`;` on Windows). Use the same folders you load with `~dirt.loadSoundFiles` |
| `TIDAL_SHARE_SESSION` | `false` | `true` to share the server's Tidal with your editor (GHCi mode) |
| `TIDAL_SHARE_DIR` | `~/.tidal-mcp` | Where the shared-session socket and the `ghci` stand-in go |
| `TIDAL_CTRL_PORT` | the boot file's `cCtrlPort`, else 6010 | Tidal's control port, for `tidal_set_control` |
| `TIDAL_CTRL_HOST` | `127.0.0.1` | Host for the control port |
| `TIDAL_TRANSPORT` | `stdio` | `websocket` to serve MCP over WebSocket instead |

For the WebSocket transport and its settings, see [WEBSOCKET-USAGE.md](WEBSOCKET-USAGE.md).

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

Design notes for possible future features are in [docs/design](docs/design/). See [CONTRIBUTING.md](CONTRIBUTING.md) for where things go in the code.

### Releasing

Bump `version` in `package.json`, update `CHANGELOG.md`, merge, then tag:

```bash
git tag v1.2.0 && git push origin v1.2.0
```

`.github/workflows/release.yml` checks the tag matches `package.json`, runs the tests and publishes to npm with provenance. It uses npm trusted publishing if the package has this workflow set as a trusted publisher on npmjs.com, and otherwise an `NPM_TOKEN` repository secret.

## License

MIT
