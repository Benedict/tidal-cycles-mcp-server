#!/usr/bin/env node

import WebSocket from 'ws';

/**
 * Simple WebSocket client to test the Tidal MCP server
 * Usage: node test-websocket-client.js [ws://localhost:8080]
 */

const url = process.argv[2] || 'ws://localhost:8080';
console.log(`Connecting to ${url}...`);

const ws = new WebSocket(url);

ws.on('open', () => {
  console.log('✓ Connected to Tidal MCP Server');

  // Send a tools list request
  const listToolsRequest = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/list'
  };

  console.log('Sending tools/list request...');
  ws.send(JSON.stringify(listToolsRequest));
});

ws.on('message', (data) => {
  try {
    const message = JSON.parse(data.toString());
    console.log('Received:', JSON.stringify(message, null, 2));

    // If we got the tools list, try evaluating a pattern
    if (message.id === 1 && message.result?.tools) {
      console.log('✓ Got tools list, now testing pattern evaluation...');

      setTimeout(() => {
        const evalRequest = {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: {
            name: 'tidal_eval',
            arguments: {
              channel: 'd1',
              pattern: 'sound "bd*4"'
            }
          }
        };

        console.log('Sending pattern evaluation...');
        ws.send(JSON.stringify(evalRequest));
      }, 1000);
    }

    // Test getting state
    if (message.id === 2) {
      console.log('✓ Pattern evaluation successful, testing state...');

      setTimeout(() => {
        const stateRequest = {
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: {
            name: 'tidal_get_state',
            arguments: {}
          }
        };

        console.log('Getting state...');
        ws.send(JSON.stringify(stateRequest));
      }, 1000);
    }

    // Test hush
    if (message.id === 3) {
      console.log('✓ State retrieved, testing hush...');

      setTimeout(() => {
        const hushRequest = {
          jsonrpc: '2.0',
          id: 4,
          method: 'tools/call',
          params: {
            name: 'tidal_hush',
            arguments: {}
          }
        };

        console.log('Sending hush...');
        ws.send(JSON.stringify(hushRequest));
      }, 1000);
    }

    if (message.id === 4) {
      console.log('✓ All tests completed successfully!');
      setTimeout(() => {
        ws.close();
      }, 1000);
    }

  } catch (error) {
    console.error('Error parsing message:', error);
    console.error('Raw message:', data.toString());
  }
});

ws.on('close', () => {
  console.log('Connection closed');
  process.exit(0);
});

ws.on('error', (error) => {
  console.error('WebSocket error:', error);
  process.exit(1);
});

// Handle Ctrl+C gracefully
process.on('SIGINT', () => {
  console.log('\\nClosing connection...');
  ws.close();
});