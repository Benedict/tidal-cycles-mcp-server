# Security

## What the server can do

Tidal patterns are Haskell, and in GHCi mode the server runs them with your user's permissions. Anything that can call the server's tools can run code on your machine. That's how live coding works, so the server's job is to make sure only the clients you chose can reach it.

- **stdio (the default):** only the MCP client that started the server, such as Claude Desktop or Claude Code, can talk to it.
- **WebSocket (`TIDAL_TRANSPORT=websocket`):** anything that can reach the port can run code, because there's no authentication. It listens on `localhost` by default. Don't bind it to `0.0.0.0`; tunnel the port instead. Browser pages are refused unless their origin is listed in `TIDAL_WS_ALLOWED_ORIGINS`.
- **Shared session (`TIDAL_SHARE_SESSION=true`):** the socket in `~/.tidal-mcp` can only be opened by your user.
- **Web pages (`TIDAL_UI_PORT`):** they can't run Tidal code. Their buttons (hush, autopilot, restart Tidal) only work from this machine. Requests must be addressed to `localhost` or an IP address, and a browser's origin must match the page's, so other websites can't connect, even by DNS rebinding. The Strudel page runs Strudel code in each viewer's browser.
- **Control port:** Tidal listens for OSC control messages on `127.0.0.1` (port 6011 with the bundled `BootTidal.hs`). That's Tidal's own feature: those messages can change values and mute channels, but they can't run code.

The server only writes to `TIDAL_FILE`, its session log, and `~/.tidal-mcp` when sharing is on.

## Reporting a vulnerability

Report it privately through GitHub: on the repository's **Security** tab, choose **Report a vulnerability**. Please don't open a public issue.

Fixes go into the latest release.
