# Design notes

Notes written while planning features. They describe intentions, not how the server works now; the main README is the reference for that.

| Note | Status |
|------|--------|
| [websocket.md](websocket.md) | Built: the WebSocket transport (`TIDAL_TRANSPORT=websocket`). The design differs in places; see [WEBSOCKET-USAGE.md](../../WEBSOCKET-USAGE.md). |
| [midi-input.md](midi-input.md) | Not built. |
| [feature-ideas.md](feature-ideas.md) | Mostly not built. Some ideas were done differently: pattern history (`tidal_get_history`), and evolving patterns (layers and `tidal_autopilot`). |
