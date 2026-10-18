import WebSocket, { WebSocketServer } from 'ws';
import { IncomingMessage } from 'http';
import { Transport, TransportSendOptions } from '@modelcontextprotocol/sdk/shared/transport.js';
import { JSONRPCMessage, MessageExtraInfo } from '@modelcontextprotocol/sdk/types.js';

/**
 * WebSocket transport for MCP server
 * Provides reliable, bidirectional communication with reconnection support
 */

export class WebSocketServerTransport implements Transport {
  private server: WebSocketServer;
  private clients: Map<string, WebSocketClient> = new Map();
  // Requests from different clients can share an id, so each gets a
  // server-wide id on the way in, mapped back on the way out.
  private nextRequestId = 1;
  private requests: Map<string | number, { clientId: string; id: string | number }> = new Map();

  // Transport interface properties
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage, extra?: MessageExtraInfo) => void;
  sessionId?: string;

  constructor(options: { port: number; host?: string; allowedOrigins?: string[] }) {
    const allowedOrigins = options.allowedOrigins ?? [];
    this.server = new WebSocketServer({
      port: options.port,
      host: options.host || 'localhost',
      perMessageDeflate: false,
      // Browsers don't apply CORS to WebSockets, so without this any web page could
      // connect to localhost and evaluate arbitrary code. Non-browser clients send
      // no Origin header and are always allowed.
      verifyClient: ({ origin }: { origin?: string }) => {
        if (!origin || allowedOrigins.includes(origin)) {
          return true;
        }
        console.error(`[WebSocket] Rejected connection from origin ${origin}`);
        return false;
      }
    });

    this.setupServer();
  }

  private setupServer() {
    this.server.on('connection', (ws: WebSocket, req: IncomingMessage) => {
      const clientId = this.generateClientId();
      const client = new WebSocketClient(clientId, ws, this);

      this.clients.set(clientId, client);
      console.error(`[WebSocket] Client ${clientId} connected from ${req.socket.remoteAddress}`);

      ws.on('close', () => {
        this.clients.delete(clientId);
        console.error(`[WebSocket] Client ${clientId} disconnected`);
      });

      ws.on('error', (error) => {
        console.error(`[WebSocket] Client ${clientId} error:`, error);
        this.clients.delete(clientId);
      });
    });

    this.server.on('error', (error: Error) => {
      console.error('[WebSocket] Server error:', error);
      this.onerror?.(error);
    });

    console.error(`[WebSocket] Server listening on port ${this.server.options.port}`);
  }

  private generateClientId(): string {
    return `client_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
  }

  // Transport interface methods
  async start(): Promise<void> {
    // Server is already started in constructor
    return Promise.resolve();
  }

  async send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    // A response goes only to the client that made the request, with its own id
    // (An error without an id, e.g. for unparseable input, can't be routed.)
    if ("id" in message && !("method" in message) && message.id !== undefined) {
      const route = this.requests.get(message.id);
      if (!route) {
        console.error(`[WebSocket] Dropping a response to unknown request ${message.id}`);
        return;
      }
      this.requests.delete(message.id);
      const client = this.clients.get(route.clientId);
      if (client?.isConnected()) {
        client.send(JSON.stringify({ ...message, id: route.id }));
      }
      return;
    }

    // Notifications go to every client
    this.broadcast(message);
  }

  async close(): Promise<void> {
    // Close all client connections
    this.clients.forEach(client => {
      client.close();
    });
    this.clients.clear();

    // Close the server
    return new Promise((resolve) => {
      this.server.close(() => {
        console.error('[WebSocket] Server closed');
        this.onclose?.();
        resolve();
      });
    });
  }

  // Additional methods for WebSocket-specific functionality
  getConnectedClients(): string[] {
    return Array.from(this.clients.keys());
  }

  getClientCount(): number {
    return this.clients.size;
  }

  sendToClient(clientId: string, message: any): boolean {
    const client = this.clients.get(clientId);
    if (client && client.isConnected()) {
      client.send(JSON.stringify(message));
      return true;
    }
    return false;
  }

  broadcast(message: any, excludeClient?: string): void {
    const messageStr = JSON.stringify(message);

    this.clients.forEach((client, id) => {
      if (id !== excludeClient && client.isConnected()) {
        client.send(messageStr);
      }
    });
  }

  // Handle message from a specific client
  handleClientMessage(clientId: string, message: JSONRPCMessage): void {
    if ("id" in message && "method" in message) {
      const id = this.nextRequestId++;
      this.requests.set(id, { clientId, id: message.id });
      message = { ...message, id };
    }
    this.onmessage?.(message);
  }
}

/**
 * Individual WebSocket client wrapper
 */
class WebSocketClient {
  private lastPing: number = Date.now();
  private pingInterval?: NodeJS.Timeout;

  constructor(
    public readonly id: string,
    private ws: WebSocket,
    private transport: WebSocketServerTransport
  ) {
    this.setupClient();
    this.startHeartbeat();
  }

  private setupClient() {
    this.ws.on('message', async (data: WebSocket.Data) => {
      try {
        const message = JSON.parse(data.toString());

        // Handle ping/pong for heartbeat
        if (message.type === 'ping') {
          this.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
          this.lastPing = Date.now();
          return;
        }

        // Handle regular MCP messages
        this.transport.handleClientMessage(this.id, message);
      } catch (error) {
        console.error(`[WebSocket] Error handling message from ${this.id}:`, error);
        this.send(JSON.stringify({
          error: {
            code: -32700,
            message: 'Parse error'
          }
        }));
      }
    });

    this.ws.on('pong', () => {
      this.lastPing = Date.now();
    });
  }

  private startHeartbeat() {
    // Send ping every 30 seconds
    this.pingInterval = setInterval(() => {
      if (this.isConnected()) {
        this.ws.ping();

        // Check if client hasn't responded to ping in 60 seconds
        if (Date.now() - this.lastPing > 60000) {
          console.error(`[WebSocket] Client ${this.id} heartbeat timeout, closing connection`);
          this.close();
        }
      } else {
        if (this.pingInterval) {
          clearInterval(this.pingInterval);
        }
      }
    }, 30000);
  }

  send(message: string): void {
    if (this.isConnected()) {
      this.ws.send(message);
    }
  }

  close(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
    }
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.close();
    }
  }

  isConnected(): boolean {
    return this.ws.readyState === WebSocket.OPEN;
  }
}
