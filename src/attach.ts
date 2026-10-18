/**
 * Run by the `ghci` wrapper that tidal-mcp-server writes (see share.ts), in
 * place of ghci. Forwards each GHCi statement to the server's shared Tidal
 * session and prints what comes back: output on stdout, errors on stderr.
 * If the server isn't running, it runs the real ghci instead.
 */
import { spawn } from "node:child_process";
import * as net from "node:net";
import { createInterface } from "node:readline";
import { StatementBuffer, defaultShareDir, socketPathIn } from "./share.js";

const socketPath = process.env.TIDAL_SHARE_SOCKET || socketPathIn(defaultShareDir());

function runRealGhci(): void {
  const ghci = process.env.TIDAL_REAL_GHCI || "ghci";
  const child = spawn(ghci, process.argv.slice(2), { stdio: "inherit" });
  child.on("error", (err) => {
    console.error(`tidal-mcp-server isn't running, and ${ghci} couldn't start: ${err.message}`);
    process.exit(127);
  });
  child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
}

const socket = net.connect(socketPath);

socket.once("error", () => runRealGhci());

socket.once("connect", () => {
  socket.removeAllListeners("error");
  process.stdout.write("Connected to the Tidal session shared by tidal-mcp-server.\n");

  let pending = 0;
  let inputDone = false;
  const finishIfDone = () => {
    if (inputDone && pending === 0) socket.end();
  };

  let buffered = "";
  socket.on("data", (data) => {
    buffered += data.toString();
    let index: number;
    while ((index = buffered.indexOf("\n")) !== -1) {
      const response = JSON.parse(buffered.slice(0, index));
      buffered = buffered.slice(index + 1);
      pending--;
      if (response.output) process.stdout.write(response.output + "\n");
      if (response.error) process.stderr.write(response.error + "\n");
      finishIfDone();
    }
  });
  socket.on("close", () => {
    if (!inputDone) process.stderr.write("tidal-mcp-server stopped. Restart Tidal in your editor to reconnect.\n");
    process.exit(0);
  });
  socket.on("error", (err) => process.stderr.write(`Lost the shared session: ${err.message}\n`));

  const statements = new StatementBuffer();
  const input = createInterface({ input: process.stdin });
  input.on("line", (line) => {
    if (line.trim() === ":q" || line.trim() === ":quit") {
      inputDone = true;
      finishIfDone();
      return;
    }
    const code = statements.push(line);
    if (code === undefined || !code.trim()) return;
    pending++;
    socket.write(JSON.stringify({ code }) + "\n");
  });
  input.on("close", () => {
    inputDone = true;
    finishIfDone();
  });
});
