# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- A one-time notice in GHCi mode, in the first reply after installing, that the code Claude sends runs on your computer; the Claude Desktop setting for GHCi mode says so too
- `tidal_status`: the settings as the server resolved them, whether Tidal starts and its version, the control port, the last error and the log file, and whether a newer release is out (checked on npm at most once a day; `TIDAL_UPDATE_CHECK=false` turns it off)

### Changed
- The README's install examples use `tidal-mcp-server@^1`, so restarting the client picks up new 1.x releases but never a 2.0
- The session log is a `.tidal` file you can replay: each entry is the code that ran, under a `-- time` comment, with everything else commented out. Each session gets its own file in `tidal-mcp-sessions/` next to `TIDAL_FILE`, instead of overwriting `tidal-mcp-session.log`; `TIDAL_LOG_FILE` is now added to, not overwritten
- In GHCi mode, Tidal starts with the first tool call that needs it, not with the server. Claude Desktop can start a copy of the server it never uses, and that copy's Tidal played too

### Fixed
- Tidal failing to start is reported when it happens, rather than as "setcps not in scope" on the first pattern: a missing boot file, a `<no location info>` GHC error, a boot file that doesn't load Tidal, or another Tidal already on the control port
- Code containing a line that is just `:{` or `:}` is rejected. Such a line ended the server's `:{ ... :}` block, and what followed ran as GHCi commands (`:!` runs shell commands) outside what the server tracks
- In file mode, replies say the code was written to the file and needs evaluating, instead of "Pattern is now playing" and the like, which Claude passed on as fact
- Path settings ignore stray spaces and expand `~` and `${HOME}` (Claude Desktop passed `${HOME}` through unexpanded, so the session log couldn't be written)
- With `GHCI_PATH` unset, `ghci` is found in ghcup's and Homebrew's folders when it isn't on `PATH`, as for apps started from the Dock; the error lists where it looked

## [1.1.0] - 2026-10-19

### Added
- Install with `npx -y tidal-mcp-server`; the package ships its own `BootTidal.hs`
- A Claude Desktop bundle (`.mcpb`) on each GitHub release, for one-click install
- `tidal_set_layer`, `tidal_remove_layer`: build a channel from named layers
- `tidal_autopilot`: keeps layered channels changing between turns
- `tidal_palette`: idioms that combine well, including genre starting points
- `tidal_set_tempo`: set the tempo in BPM
- `tidal_list_samples`, and a warning when a pattern uses a sound SuperDirt doesn't have
- `tidal_set_control`: change values patterns read with `cF`/`cS` through Tidal's control port, optionally gliding
- `TIDAL_SHARE_SESSION`: share one Tidal session between the server and your editor (e.g. Pulsar)
- Windows support for GHCi mode, tested in CI
- A control page (Hush, what's playing, autopilot, restart Tidal) and a Strudel page with `strudel_*` tools, served on `TIDAL_UI_PORT`
- `tidal_get_state` takes `quiet` for clients that poll
- `TIDAL_WS_ALLOWED_ORIGINS` for the WebSocket transport

### Changed
- In GHCi mode, Tidal's errors are returned to the client, and rejected
  patterns change nothing
- Requires Node.js 22 or later

### Fixed
- `tidal_solo` and `tidal_unsolo` sent invalid Tidal
- `tidal_silence` sent invalid Tidal
- Multi-line patterns in GHCi mode
- A missing `ghci` no longer stops the server from connecting
- Web pages could connect to the WebSocket transport and run code
- WebSocket replies went to every connected client, and clients' request ids could clash

## [1.0.0] - 2025-10-25

### Added
- Initial release of TidalCycles MCP Server
- Core MCP tools: `tidal_eval`, `tidal_hush`, `tidal_silence`, `tidal_get_state`, `tidal_solo`, `tidal_unsolo`, `tidal_get_history`
- File-based pattern evaluation mode
- Direct GHCi integration mode (experimental)
- Support for all 9 TidalCycles channels (d1-d9)
- Pattern history tracking with configurable limits
- State awareness - tracks active patterns and timestamps
- Comprehensive documentation and examples
- MIT License

### Features
- **File Mode**: Stable pattern evaluation via file watching
- **Direct GHCi Mode**: Seamless pattern updates without restarts
- **Channel Management**: Solo, silence, and manage individual channels
- **History Tracking**: Review and recall previous patterns
- **Natural Language Control**: Claude can generate and modify patterns conversationally

### Documentation
- Comprehensive README with setup instructions
- QUICKSTART guide for rapid deployment
- CONTRIBUTING guidelines for developers
- Example patterns and use cases
- Troubleshooting section for common issues

### Known Issues
- File mode causes brief audio dropouts on pattern changes (by design)
- Direct GHCi mode is experimental and may have edge cases
- No undo functionality for pattern changes
- Single instance limitation (can't run multiple MCP servers)

---

For more detail, see the [commit history](https://github.com/Benedict/tidal-cycles-mcp-server/commits/main).
