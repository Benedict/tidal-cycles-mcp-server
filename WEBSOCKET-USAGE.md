# WebSocket Usage Guide

The Tidal MCP Server now supports WebSocket connections for improved reliability and network accessibility.

## Important: Dual Transport Setup

**Claude Desktop**: Always uses stdio transport (configured in `claude_desktop_config.json`)
**External Clients**: Use WebSocket transport for web UIs, collaboration, etc.

These can run simultaneously - Claude Desktop connects via stdio while external clients connect via WebSocket to the same server instance.

## Key Benefits

- **Network Accessible**: Connect from remote machines, web browsers, or other applications
- **Multiple Simultaneous Connections**: Multiple clients can connect at once
- **Bidirectional Communication**: Server pushes real-time updates to all connected clients
- **Automatic Reconnection**: Built-in heartbeat and reconnection handling
- **Better Performance**: Persistent connections avoid connection overhead

## Starting the Server

### For External WebSocket Clients
```bash
# Easy way - use the provided script
npm run start:websocket

# Manual way
TIDAL_TRANSPORT=websocket npm start

# Custom port and host
TIDAL_WS_PORT=9000 TIDAL_WS_HOST=0.0.0.0 npm run start:ws
```

### For Claude Desktop Only (Default)
```bash
# Claude Desktop manages this automatically via claude_desktop_config.json
# No manual startup needed - just use Claude Desktop
```

### Testing WebSocket Connection
```bash
# Start WebSocket server in one terminal
npm run start:websocket

# Test connection in another terminal
npm run test:websocket
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `TIDAL_TRANSPORT` | Transport type: `websocket` or `stdio` | `stdio` |
| `TIDAL_WS_PORT` | WebSocket server port | `8080` |
| `TIDAL_WS_HOST` | WebSocket server host | `localhost` |

## Real-time Updates

When using WebSocket mode, all connected clients receive real-time broadcasts:

### Pattern Updates
```json
{
  "type": "pattern_update",
  "channel": "d1",
  "pattern": "sound \"bd*4\"",
  "fullPattern": "d1 $ sound \"bd*4\"",
  "timestamp": 1234567890
}
```

### Hush Events
```json
{
  "type": "hush",
  "timestamp": 1234567890
}
```

## Client Examples

### JavaScript/Node.js
```javascript
import WebSocket from 'ws';

const ws = new WebSocket('ws://localhost:8080');

ws.on('open', () => {
  // Send MCP request
  ws.send(JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'tidal_eval',
      arguments: {
        channel: 'd1',
        pattern: 'sound "bd*4"'
      }
    }
  }));
});

ws.on('message', (data) => {
  const message = JSON.parse(data.toString());

  if (message.type === 'pattern_update') {
    console.log(\`New pattern on \${message.channel}: \${message.pattern}\`);
  }
});
```

### Browser
```javascript
const ws = new WebSocket('ws://localhost:8080');

ws.onmessage = (event) => {
  const message = JSON.parse(event.data);

  // Handle real-time updates
  if (message.type === 'pattern_update') {
    updateVisualization(message.channel, message.pattern);
  }
};
```

### Python
```python
import websocket
import json

def on_message(ws, message):
    data = json.loads(message)
    if data.get('type') == 'pattern_update':
        print(f"Pattern update: {data['channel']} -> {data['pattern']}")

ws = websocket.WebSocketApp("ws://localhost:8080", on_message=on_message)
ws.run_forever()
```

## Use Cases

### Web-based Tidal UI
Create a browser-based interface that connects to the same Tidal session as Claude:

```html
<!DOCTYPE html>
<html>
<head><title>Tidal Web UI</title></head>
<body>
  <div id="channels"></div>
  <script>
    const ws = new WebSocket('ws://localhost:8080');

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === 'pattern_update') {
        document.getElementById(msg.channel).textContent = msg.pattern;
      }
    };
  </script>
</body>
</html>
```

### Multiple Claude Instances
Run multiple Claude instances connected to the same Tidal server:

```bash
# Terminal 1: Start WebSocket server
TIDAL_TRANSPORT=websocket npm start

# Terminal 2: Claude instance 1
claude code --server ws://localhost:8080

# Terminal 3: Claude instance 2
claude code --server ws://localhost:8080
```

### Remote Performance
Control Tidal from a different machine:

```bash
# Server machine
TIDAL_WS_HOST=0.0.0.0 TIDAL_TRANSPORT=websocket npm start

# Client machine
claude code --server ws://server-ip:8080
```

### Live Coding Collaboration
Multiple users can connect and see each other's patterns in real-time.

## Connection Health

The WebSocket transport includes:

- **Heartbeat**: Automatic ping/pong every 30 seconds
- **Timeout Detection**: Disconnects stale connections after 60 seconds
- **Graceful Shutdown**: Proper cleanup on server shutdown
- **Error Handling**: Robust error reporting and recovery

## Migration from stdio

The server maintains full backward compatibility:

```bash
# Old way (still works)
npm start

# New way
TIDAL_TRANSPORT=websocket npm start
```

All MCP tools and functionality remain identical between transports.

## Testing

Use the included test client:

```bash
# Start server
TIDAL_TRANSPORT=websocket npm start

# Test in another terminal
node test-websocket-client.js
```

The test demonstrates:
1. Connecting to the WebSocket server
2. Listing available tools
3. Evaluating a pattern
4. Getting channel state
5. Hushing patterns
6. Receiving real-time updates

## Monitoring

Server logs show WebSocket activity:

```
[WebSocket] Server listening on port 8080
[WebSocket] Client client_123_abc connected from 127.0.0.1
[WebSocket] Client client_123_abc disconnected
```

Check connected clients programmatically by adding monitoring endpoints to the server.