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

  // Transport interface properties
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage, extra?: MessageExtraInfo) => void;
  sessionId?: string;

  constructor(options: { port: number; host?: string }) {
    this.server = new WebSocketServer({
      port: options.port,
      host: options.host || 'localhost',
      perMessageDeflate: false
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
    return `client_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  // Transport interface methods
  async start(): Promise<void> {
    // Server is already started in constructor
    return Promise.resolve();
  }

  async send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    // Broadcast to all connected clients
    const messageStr = JSON.stringify(message);

    this.clients.forEach((client, id) => {
      if (client.isConnected()) {
        client.send(messageStr);
      }
    });
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
    if (this.onmessage) {
      this.onmessage(message);
    }
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

/**
 * WebSocket client for connecting to the server
 */
export class WebSocketClientTransport implements Transport {
  private ws?: WebSocket;
  private url: string;
  private reconnectAttempts = 0;
  private maxReconnectDelay = 30000;
  private reconnectTimer?: NodeJS.Timeout;
  private messageHandler?: (message: any) => Promise<any>;
  private closeHandler?: () => void;
  private errorHandler?: (error: Error) => void;
  private connected = false;

  constructor(url: string) {
    this.url = url;
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.connect()
        .then(() => resolve())
        .catch(reject);
    });
  }

  private async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.url);

        this.ws.on('open', () => {
          console.error(`[WebSocket Client] Connected to ${this.url}`);
          this.connected = true;
          this.reconnectAttempts = 0;

          // Start heartbeat
          this.startHeartbeat();
          resolve();
        });

        this.ws.on('message', async (data: WebSocket.Data) => {
          try {
            const message = JSON.parse(data.toString());

            // Handle pong response
            if (message.type === 'pong') {
              return;
            }

            // Handle regular messages
            if (this.messageHandler) {
              await this.messageHandler(message);
            }
          } catch (error) {
            console.error('[WebSocket Client] Error handling message:', error);
          }
        });

        this.ws.on('close', () => {
          console.error('[WebSocket Client] Connection closed');
          this.connected = false;
          this.scheduleReconnect();
          this.closeHandler?.();
        });

        this.ws.on('error', (error) => {
          console.error('[WebSocket Client] Connection error:', error);
          this.connected = false;
          this.errorHandler?.(error);

          if (this.reconnectAttempts === 0) {
            reject(error);
          }
        });

      } catch (error) {
        reject(error);
      }
    });
  }

  private startHeartbeat() {
    // Send ping every 30 seconds
    const heartbeatInterval = setInterval(() => {
      if (this.connected && this.ws?.readyState === WebSocket.OPEN) {
        this.send({ type: 'ping', timestamp: Date.now() });
      } else {
        clearInterval(heartbeatInterval);
      }
    }, 30000);
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    const delay = Math.min(
      1000 * Math.pow(2, this.reconnectAttempts),
      this.maxReconnectDelay
    );

    console.error(`[WebSocket Client] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts + 1})`);

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectAttempts++;
      try {
        await this.connect();
      } catch (error) {
        console.error('[WebSocket Client] Reconnection failed:', error);
      }
    }, delay);
  }

  async send(message: any): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    } else {
      throw new Error('WebSocket not connected');
    }
  }

  onMessage(handler: (message: any) => Promise<any>): void {
    this.messageHandler = handler;
  }

  onClose(handler: () => void): void {
    this.closeHandler = handler;
  }

  onError(handler: (error: Error) => void): void {
    this.errorHandler = handler;
  }

  async close(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    if (this.ws) {
      this.ws.close();
      this.connected = false;
    }
  }

  isConnected(): boolean {
    return this.connected && this.ws?.readyState === WebSocket.OPEN;
  }
}