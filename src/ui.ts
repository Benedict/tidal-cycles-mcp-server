import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as path from "node:path";
import { WebSocket, WebSocketServer } from "ws";

/**
 * A local web server with two pages:
 *   /          a control page: what's playing, Hush, autopilot, restart Tidal
 *   /strudel   a Strudel page the server sends programs to (see strudel.html)
 *
 * Pages talk to the server over WebSockets on /events and /strudel.
 *
 * Only pages this server serves can connect: requests must be addressed to
 * localhost or an IP address (which stops DNS rebinding), and a browser's
 * Origin must match. Anyone who can reach the port can watch; only this
 * machine can press buttons.
 */

export interface StrudelResult {
  ok: boolean;
  error?: string;
}

export interface UiCallbacks {
  /** Everything the control page shows */
  snapshot(): unknown;
  /** Runs a control-page button; returns a message to show */
  action(name: string): Promise<string>;
}

const PAGES: Record<string, string> = { "/": "control.html", "/strudel": "strudel.html" };
const STRUDEL_RESULT_TIMEOUT_MS = 6000;

function isLoopback(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

/** localhost or an IP literal. A hostname could be an attacker's DNS pointing here. */
function isAllowedHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  const host = hostHeader.replace(/:\d+$/, "").replace(/^\[(.*)\]$/, "$1");
  return host === "localhost" || net.isIP(host) !== 0;
}

function isAllowedOrigin(req: http.IncomingMessage): boolean {
  const origin = req.headers.origin;
  return !origin || origin === `http://${req.headers.host}`;
}

export class UiServer {
  private http?: http.Server;
  private events = new WebSocketServer({ noServer: true });
  private strudel = new WebSocketServer({ noServer: true });
  private snapshotTimer?: NodeJS.Timeout;
  private lastSnapshot = "";
  private nextProgramId = 1;
  private program?: { id: number; code: string };
  private waiting = new Map<number, (result: StrudelResult) => void>();
  // Pages that have finished loading Strudel and its samples
  private readyPages = new WeakSet<WebSocket>();
  url = "";

  constructor(
    private options: { host: string; port: number; pagesDir: string; callbacks: UiCallbacks },
    private log: (message: string) => void = (m) => console.error(m)
  ) {}

  async start(): Promise<string> {
    const server = http.createServer((req, res) => this.serve(req, res));
    server.on("upgrade", (req, socket, head) => {
      const pathname = new URL(req.url ?? "/", "http://x").pathname;
      const wss = pathname === "/events" ? this.events : pathname === "/strudel" ? this.strudel : undefined;
      if (!wss || !isAllowedHost(req.headers.host) || !isAllowedOrigin(req)) {
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    });

    this.events.on("connection", (ws: WebSocket, req: http.IncomingMessage) => this.onEventsClient(ws, req));
    this.strudel.on("connection", (ws: WebSocket) => this.onStrudelPage(ws));

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.options.port, this.options.host, () => resolve());
    });
    server.unref();
    this.http = server;

    const { port } = server.address() as net.AddressInfo;
    const shownHost = this.options.host === "0.0.0.0" || this.options.host === "::" ? "localhost" : this.options.host;
    this.url = `http://${shownHost.includes(":") ? `[${shownHost}]` : shownHost}:${port}`;

    // Push state to control pages when it changes
    this.snapshotTimer = setInterval(() => this.pushSnapshot(), 500);
    this.snapshotTimer.unref();
    this.log(`[UI] Control page at ${this.url}/ and Strudel at ${this.url}/strudel`);
    return this.url;
  }

  stop(): void {
    clearInterval(this.snapshotTimer);
    for (const ws of [...this.events.clients, ...this.strudel.clients]) ws.terminate();
    this.http?.close();
  }

  strudelPageCount(): number {
    return this.strudel.clients.size;
  }

  /** Pages that have finished loading and can answer straight away. */
  readyStrudelPageCount(): number {
    return [...this.strudel.clients].filter((ws) => this.readyPages.has(ws)).length;
  }

  /**
   * Sends a program to every Strudel page and resolves with the first ready
   * page's result, or undefined if none answers in time. Only call it when a
   * page is ready: a page still loading its samples can take much longer.
   */
  sendProgram(code: string): Promise<StrudelResult | undefined> {
    const id = this.nextProgramId++;
    const message = JSON.stringify({ type: "program", id, code });
    for (const ws of this.strudel.clients) ws.send(message);

    // Strudel keeps playing the previous program if this one fails, so only
    // remember it (for pages that open later) once a page has accepted it
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        resolve(undefined);
      }, STRUDEL_RESULT_TIMEOUT_MS);
      timer.unref();
      this.waiting.set(id, (result) => {
        clearTimeout(timer);
        this.waiting.delete(id);
        if (result.ok) this.program = { id, code };
        resolve(result);
      });
    });
  }

  hushStrudel(): void {
    this.program = undefined;
    const message = JSON.stringify({ type: "hush" });
    for (const ws of this.strudel.clients) ws.send(message);
  }

  private serve(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (!isAllowedHost(req.headers.host)) {
      res.writeHead(403).end("Open this page via localhost or an IP address.");
      return;
    }
    const pathname = new URL(req.url ?? "/", "http://x").pathname;
    const page = PAGES[pathname];
    if (req.method !== "GET" || !page) {
      res.writeHead(404).end("Not found");
      return;
    }
    fs.readFile(path.join(this.options.pagesDir, page), (err, html) => {
      if (err) {
        res.writeHead(500).end("Page missing");
        return;
      }
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Frame-Options": "DENY",
      });
      res.end(html);
    });
  }

  private onEventsClient(ws: WebSocket, req: http.IncomingMessage): void {
    const local = isLoopback(req.socket.remoteAddress);
    ws.send(JSON.stringify({ type: "hello", canControl: local, strudelUrl: `${this.url}/strudel` }));
    ws.send(JSON.stringify({ type: "state", state: this.options.callbacks.snapshot() }));

    ws.on("message", async (data) => {
      let action: unknown;
      try {
        action = JSON.parse(data.toString()).action;
      } catch {
        return;
      }
      if (typeof action !== "string") return;
      if (!local) {
        ws.send(JSON.stringify({ type: "notice", ok: false, message: "Buttons only work on the machine running the server." }));
        return;
      }
      try {
        const message = await this.options.callbacks.action(action);
        ws.send(JSON.stringify({ type: "notice", ok: true, message }));
      } catch (error) {
        ws.send(JSON.stringify({ type: "notice", ok: false, message: (error as Error).message }));
      }
      this.pushSnapshot(true);
    });
  }

  private onStrudelPage(ws: WebSocket): void {
    // A page that joins late gets what's playing now
    if (this.program) ws.send(JSON.stringify({ type: "program", ...this.program }));

    ws.on("message", (data) => {
      let message: { type?: string; id?: number; ok?: boolean; error?: string };
      try {
        message = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (message.type === "ready") {
        this.readyPages.add(ws);
      } else if (message.type === "result" && typeof message.id === "number") {
        this.waiting.get(message.id)?.({ ok: message.ok === true, error: message.error });
      }
    });
  }

  private pushSnapshot(force = false): void {
    if (this.events.clients.size === 0) return;
    const state = JSON.stringify(this.options.callbacks.snapshot());
    if (!force && state === this.lastSnapshot) return;
    this.lastSnapshot = state;
    const message = `{"type":"state","state":${state}}`;
    for (const ws of this.events.clients) ws.send(message);
  }
}

/** Builds a Strudel program from named blocks: each is a `$:` pattern. */
export function composeStrudel(blocks: Map<string, string>, bpm?: number): string {
  const lines: string[] = [];
  if (bpm !== undefined) lines.push(`setcpm(${bpm}/4)`);
  for (const [name, code] of blocks) lines.push(`// ${name}\n$: ${code}`);
  return lines.join("\n\n");
}
