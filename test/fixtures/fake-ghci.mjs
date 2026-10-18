#!/usr/bin/env node
// A stand-in for `ghci -ghci-script BootTidal.hs`, for tests without Haskell.
// It mimics the behaviour the server relies on:
//   - `:set prompt` / `:set prompt-cont` change the prompt printed after each statement
//   - `:{ ... :}` groups lines into one statement
//   - code containing BAD gets a GHC-style error on stderr
//   - code containing HANG never gets a prompt; CRASH exits
//   - a boot script whose path contains "broken" fails to load
// Every statement received is appended to $FAKE_GHCI_LOG, one JSON string per line.
// With FAKE_GHCI_CRLF=1 it ends lines with \r\n, as GHCi does on Windows.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const boot = args[args.indexOf("-ghci-script") + 1] ?? "";
const logFile = process.env.FAKE_GHCI_LOG;

if (process.env.FAKE_GHCI_CRLF === "1") {
  for (const stream of [process.stdout, process.stderr]) {
    const write = stream.write.bind(stream);
    stream.write = (text, ...rest) => write(String(text).replace(/\n/g, "\r\n"), ...rest);
  }
}

let prompt = "tidal> ";
let block = null;
let line = 1;

if (boot.includes("broken")) {
  process.stderr.write(`${boot}:4:1: error: [GHC-87110]\n    Could not find module ‘Sound.Tidal.Context’\n\n`);
}
process.stdout.write(`Loaded GHCi configuration from ${boot}\n`);
process.stdout.write(prompt);

function statement(code) {
  if (logFile) appendFileSync(logFile, JSON.stringify(code) + "\n");
  line++;

  const set = code.match(/^:set (prompt|prompt-cont) (".*")$/);
  if (set) {
    if (set[1] === "prompt") prompt = JSON.parse(set[2]);
    // Like Tidal, say something unprompted shortly after start-up
    if (set[1] === "prompt") setTimeout(() => process.stdout.write("Waiting for SuperDirt (v.1.7.2 or higher)..\n"), 30);
  } else if (code === ":q") {
    process.stdout.write("Leaving GHCi.\n");
    process.exit(0);
  } else if (code.includes("CRASH")) {
    process.exit(1);
  } else if (code.includes("HANG")) {
    return;
  } else if (code.includes("BAD")) {
    process.stderr.write(
      `<interactive>:${line}:5: error: [GHC-88464]\n    Variable not in scope: BAD :: Pattern ValueMap\n\n`
    );
  }
  process.stdout.write(prompt);
}

createInterface({ input: process.stdin }).on("line", (text) => {
  if (block) {
    if (text === ":}") {
      const code = block.join("\n");
      block = null;
      statement(code);
    } else {
      block.push(text);
    }
  } else if (text === ":{") {
    block = [];
  } else {
    statement(text);
  }
});
