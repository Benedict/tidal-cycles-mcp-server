# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

## [Unreleased]

### Planned Features
- WebSocket-based communication for improved reliability
- Pattern version control and undo/redo support
- Real-time audio analysis feedback to Claude
- Browser-based UI for pattern visualization
- Multi-user collaboration support
- MIDI output support
- Integration with Hydra for visual live coding
- Pattern library and favorites system

---

For older versions and detailed changes, see the [commit history](https://github.com/yourusername/tidal-mcp-server/commits/main).
