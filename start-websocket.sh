#!/bin/bash

# Start Tidal MCP Server in WebSocket mode
# This allows external clients (web UIs, other apps) to connect
# while Claude Desktop uses the stdio transport

echo "Starting Tidal MCP Server in WebSocket mode..."
echo "Claude Desktop: Uses stdio transport (configured in claude_desktop_config.json)"
echo "External clients: Can connect to ws://localhost:8080"
echo ""

export TIDAL_TRANSPORT=websocket
export TIDAL_WS_PORT=${TIDAL_WS_PORT:-8080}
export TIDAL_WS_HOST=${TIDAL_WS_HOST:-localhost}
export TIDAL_FILE=${TIDAL_FILE:-"$(pwd)/tidal-mcp-output.tidal"}
export TIDAL_USE_GHCI=${TIDAL_USE_GHCI:-false}

if [ "$TIDAL_USE_GHCI" = "true" ]; then
    export TIDAL_BOOT_PATH=${TIDAL_BOOT_PATH:-"$(pwd)/BootTidal.hs"}
    export GHCI_PATH=${GHCI_PATH:-"ghci"}
    echo "GHCi mode: Enabled"
    echo "Boot script: $TIDAL_BOOT_PATH"
else
    echo "File mode: Writing to $TIDAL_FILE"
fi

echo "WebSocket server: ws://$TIDAL_WS_HOST:$TIDAL_WS_PORT"
echo ""
echo "Press Ctrl+C to stop"
echo "----------------------------------------"

node dist/index.js