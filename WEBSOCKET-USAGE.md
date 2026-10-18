# WebSocket transport

By default the server speaks MCP over stdio, which is what Claude Desktop and Claude Code use. With `TIDAL_TRANSPORT=websocket`, it speaks MCP over a WebSocket instead, so other programs can connect to it: a web page, a script, or several clients at once.

A server process uses one transport or the other. A WebSocket server is a separate process from the one Claude Desktop starts, with its own Tidal and its own state. To have Claude and something else drive the same Tidal, run the WebSocket server and connect everything to it. Alternatively, share the Tidal session with your editor (see the README).

## Starting it

```bash
TIDAL_TRANSPORT=websocket npx tidal-mcp-server
# or, from a clone:
npm run start:websocket
```

| Variable | Default | |
|----------|---------|--|
| `TIDAL_WS_PORT` | `8080` | Port to listen on |
| `TIDAL_WS_HOST` | `localhost` | Address to listen on |
| `TIDAL_WS_ALLOWED_ORIGINS` | _(none)_ | Comma-separated browser origins allowed to connect, e.g. `http://localhost:5173` |

All the other settings (GHCi mode, boot file and so on) work as they do over stdio.

## Security

Patterns are Haskell, run with your permissions, and the WebSocket has no authentication. So:

- **Keep it on `localhost`.** Setting `TIDAL_WS_HOST=0.0.0.0` lets anyone who can reach the port run code on your machine. To use it from another machine, tunnel the port instead, e.g. `ssh -L 8080:localhost:8080 you@server`.
- **Browsers are refused unless you allow them.** Without this, any web page you visited could connect to `ws://localhost:8080` and run code. Pages send an `Origin` header, and only origins listed in `TIDAL_WS_ALLOWED_ORIGINS` are accepted. Programs that don't send an `Origin` header, such as Node or Python scripts, aren't affected.

## Talking to it

Messages are MCP JSON-RPC, one per WebSocket message. Replies go only to the client that sent the request, with that client's own `id`, so several clients can use the same ids without clashing.

```javascript
import WebSocket from "ws";

const ws = new WebSocket("ws://localhost:8080");

ws.on("open", () => {
  ws.send(JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "tidal_eval", arguments: { channel: "d1", pattern: 's "bd*4"' } },
  }));
});

ws.on("message", (data) => console.log(JSON.parse(data.toString())));
```

`test-websocket-client.js` is a fuller example: `npm run test:websocket` while a WebSocket server is running.

## Updates pushed to every client

As well as replies, every connected client receives these messages, so that a UI can follow what's playing. They aren't JSON-RPC: tell them apart by their `type` field.

```json
{ "type": "pattern_update", "channel": "d1", "pattern": "s \"bd*4\"", "fullPattern": "d1 $ s \"bd*4\"", "timestamp": 1234567890 }
{ "type": "hush", "timestamp": 1234567890 }
```

## Connection health

The server pings each client every 30 seconds, and closes connections that haven't answered for 60. Clients can also send `{"type": "ping"}` and get `{"type": "pong"}` back.
