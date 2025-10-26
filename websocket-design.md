# WebSocket-Based Communication Design

## Core Implementation

```typescript
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebSocketServerTransport } from "@modelcontextprotocol/sdk/server/websocket.js";
import WebSocket from 'ws';

class TidalWebSocketServer {
  private wss: WebSocket.Server;
  private mcpServer: Server;
  private clients: Map<string, WebSocket> = new Map();

  constructor(port: number = 8080) {
    // Create WebSocket server
    this.wss = new WebSocket.Server({
      port,
      // Enable heartbeat for connection health monitoring
      perMessageDeflate: false,
    });

    this.wss.on('connection', (ws, req) => {
      const clientId = this.generateClientId();
      this.clients.set(clientId, ws);

      // Set up ping/pong heartbeat
      const heartbeat = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.ping();
        } else {
          clearInterval(heartbeat);
          this.clients.delete(clientId);
        }
      }, 30000);

      // Handle connection with MCP protocol
      const transport = new WebSocketServerTransport(ws);
      this.mcpServer.connect(transport);

      ws.on('close', () => {
        clearInterval(heartbeat);
        this.clients.delete(clientId);
        console.log(`Client ${clientId} disconnected`);
      });

      ws.on('error', (error) => {
        console.error(`WebSocket error for ${clientId}:`, error);
      });
    });
  }

  // Broadcast pattern changes to all connected clients
  broadcastPatternUpdate(channel: string, pattern: string) {
    const message = JSON.stringify({
      type: 'pattern_update',
      channel,
      pattern,
      timestamp: Date.now()
    });

    this.clients.forEach((ws, id) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(message);
      }
    });
  }
}
```

## Key Benefits

### 1. **Connection Persistence & Reliability**
```typescript
// Automatic reconnection with exponential backoff
class ReconnectingWebSocket {
  private reconnectAttempts = 0;
  private maxReconnectDelay = 30000;

  connect() {
    this.ws = new WebSocket(this.url);

    this.ws.onclose = () => {
      const delay = Math.min(
        1000 * Math.pow(2, this.reconnectAttempts),
        this.maxReconnectDelay
      );

      setTimeout(() => {
        this.reconnectAttempts++;
        this.connect();
      }, delay);
    };

    this.ws.onopen = () => {
      this.reconnectAttempts = 0;
      // Restore session state
      this.restoreChannelStates();
    };
  }
}
```

### 2. **Real-time Event Streaming**
```typescript
// Server can push updates without client polling
interface TidalEvent {
  type: 'pattern_eval' | 'error' | 'cpu_usage' | 'tempo_change';
  data: any;
  timestamp: number;
}

// Push real-time metrics
setInterval(() => {
  this.broadcast({
    type: 'cpu_usage',
    data: { usage: process.cpuUsage(), memory: process.memoryUsage() },
    timestamp: Date.now()
  });
}, 1000);
```

### 3. **Multi-Client Support**
```typescript
// Multiple UIs can connect simultaneously
class SessionManager {
  private sessions: Map<string, TidalSession> = new Map();

  createSession(clientId: string): TidalSession {
    const session = new TidalSession({
      id: clientId,
      channels: new Map(),
      permissions: this.getClientPermissions(clientId)
    });

    this.sessions.set(clientId, session);
    return session;
  }

  // Collaborative features
  broadcastToOthers(senderId: string, event: TidalEvent) {
    this.sessions.forEach((session, id) => {
      if (id !== senderId && session.permissions.canReceiveBroadcasts) {
        session.send(event);
      }
    });
  }
}
```

### 4. **Better Error Recovery**
```typescript
// Graceful handling of GHCi crashes
class GHCiManager {
  private healthCheckInterval: NodeJS.Timer;

  startHealthMonitoring() {
    this.healthCheckInterval = setInterval(async () => {
      try {
        await this.sendHealthCheck();
      } catch (error) {
        console.error('GHCi health check failed, restarting...');
        await this.restartGHCi();

        // Notify all clients
        this.broadcast({
          type: 'ghci_restarted',
          data: { reason: 'health_check_failed' }
        });
      }
    }, 5000);
  }
}
```

### 5. **Session State Persistence**
```typescript
// Maintain state across reconnections
interface ClientSession {
  id: string;
  activeChannels: Map<string, ChannelState>;
  history: PatternHistory[];
  lastActivity: number;
}

class StatefulWebSocketServer {
  private sessions: Map<string, ClientSession> = new Map();

  handleReconnect(clientId: string, ws: WebSocket) {
    const session = this.sessions.get(clientId);
    if (session) {
      // Restore client state
      ws.send(JSON.stringify({
        type: 'session_restore',
        channels: Array.from(session.activeChannels.values()),
        history: session.history
      }));
    }
  }
}
```

## Client Connection Example

```typescript
// Browser/Node.js client
class TidalWebSocketClient {
  private ws: WebSocket;
  private reconnectTimer?: NodeJS.Timer;

  connect(url: string = 'ws://localhost:8080') {
    this.ws = new WebSocket(url);

    this.ws.on('open', () => {
      console.log('Connected to Tidal MCP Server');
      this.authenticate();
    });

    this.ws.on('message', (data) => {
      const message = JSON.parse(data.toString());
      this.handleMessage(message);
    });

    this.ws.on('close', () => {
      console.log('Connection closed, attempting reconnect...');
      this.scheduleReconnect();
    });
  }

  evalPattern(channel: string, pattern: string) {
    this.send({
      method: 'tools/call',
      params: {
        name: 'tidal_eval',
        arguments: { channel, pattern }
      }
    });
  }

  private handleMessage(message: any) {
    switch (message.type) {
      case 'pattern_update':
        console.log(`Pattern update: ${message.channel} -> ${message.pattern}`);
        break;
      case 'error':
        console.error('Server error:', message.error);
        break;
      case 'cpu_usage':
        this.updateMetrics(message.data);
        break;
    }
  }
}
```

## Configuration

```typescript
// Enhanced server configuration
interface WebSocketConfig {
  port: number;
  host?: string;
  maxConnections?: number;
  authRequired?: boolean;
  ssl?: {
    key: string;
    cert: string;
  };
  cors?: {
    origin: string | string[];
    credentials: boolean;
  };
  heartbeatInterval?: number;
  messageQueueSize?: number;
}

// Usage
const server = new TidalWebSocketServer({
  port: 8080,
  maxConnections: 10,
  heartbeatInterval: 30000,
  cors: {
    origin: ['http://localhost:3000', 'https://tidal-ui.example.com'],
    credentials: true
  }
});
```

## Advantages Over stdio

1. **Network Accessibility**: Can connect from remote machines, web browsers, or mobile apps
2. **Multiple Simultaneous Connections**: Support for collaborative live coding sessions
3. **Bidirectional Communication**: Server can push updates (errors, state changes, metrics)
4. **Connection Recovery**: Automatic reconnection with state restoration
5. **Protocol Flexibility**: Easy to add custom message types and events
6. **Debugging Tools**: WebSocket debugging is well-supported in browser DevTools
7. **Load Balancing**: Can distribute connections across multiple server instances
8. **Real-time Monitoring**: Push metrics and health status to monitoring dashboards

## Migration Path

```typescript
// Support both transports during transition
class HybridTidalServer {
  async start() {
    const mode = process.env.TIDAL_TRANSPORT || 'stdio';

    if (mode === 'websocket') {
      const wsTransport = new WebSocketServerTransport({ port: 8080 });
      await this.mcpServer.connect(wsTransport);
      console.log('Running on WebSocket port 8080');
    } else {
      const stdioTransport = new StdioServerTransport();
      await this.mcpServer.connect(stdioTransport);
      console.log('Running on stdio');
    }
  }
}
```