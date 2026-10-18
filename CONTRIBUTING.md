# Contributing

Bug reports and pull requests are welcome.

## Reporting a bug

Open an issue with:

- what you asked for, and what played (or didn't)
- the mode (GHCi or file) and the transport (stdio or WebSocket)
- the server's log lines, which your MCP client shows, especially any starting `[GHCI]`
- your OS, Node version (`node --version`) and Tidal version (printed when Tidal starts)

## Setting up

```bash
git clone https://github.com/Benedict/tidal-cycles-mcp-server.git
cd tidal-cycles-mcp-server
npm install
npm test
```

`npm test` builds the server and runs the test suite. It needs neither Haskell nor SuperCollider: GHCi mode is tested against a stand-in, `test/fixtures/fake-ghci.mjs`.

If you have Tidal installed, also run:

```bash
npm run typecheck:tidal   # type-checks every command and palette entry with GHCi's :t
npm run smoke:ghci        # runs the server against real Tidal, using silent patterns only
```

CI runs all three.

## Making a change

- **New Tidal code the server sends** goes in `src/commands.ts`, and gets a check in `scripts/typecheck-tidal.ts`. That's how we found `silence d1` had never worked.
- **New palette entries** go in `src/palette.ts`. They're type-checked automatically, and checked against Dirt-Samples when it's installed.
- **New tools** are defined and handled in `src/index.ts`. Add a test in `test/server.test.ts` (file mode) or `test/server-ghci.test.ts` (GHCi mode), and a row to the README's tool table.
- **Errors from Tidal** should reach the client: throw `TidalError` and don't record state until Tidal has accepted the code.

Open a pull request against `main`. CI must pass before it's merged.

## Releasing

See [Releasing](README.md#releasing) in the README.
