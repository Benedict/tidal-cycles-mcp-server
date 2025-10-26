#!/usr/bin/env node

/**
 * Test script for TidalCycles MCP Server
 * Run this to verify the server can start and respond to basic requests
 */

import { spawn } from 'child_process';
import * as readline from 'readline';

console.log('🌀 Testing TidalCycles MCP Server\n');

// Start the MCP server
const serverProcess = spawn('node', ['dist/index.js'], {
  stdio: ['pipe', 'pipe', 'inherit'],
  env: { ...process.env, TIDAL_FILE: '/tmp/test-tidal-output.tidal' }
});

const rl = readline.createInterface({
  input: serverProcess.stdout,
  crlfDelay: Infinity
});

let messageId = 1;

function sendRequest(method: string, params: any = {}) {
  const request = {
    jsonrpc: '2.0',
    id: messageId++,
    method,
    params
  };
  serverProcess.stdin.write(JSON.stringify(request) + '\n');
  console.log(`📤 Sent: ${method}`);
}

// Test sequence
setTimeout(() => {
  console.log('\n1️⃣  Testing initialize...');
  sendRequest('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: {
      name: 'test-client',
      version: '1.0.0'
    }
  });
}, 100);

setTimeout(() => {
  console.log('\n2️⃣  Testing tools/list...');
  sendRequest('tools/list');
}, 500);

setTimeout(() => {
  console.log('\n3️⃣  Testing tidal_eval...');
  sendRequest('tools/call', {
    name: 'tidal_eval',
    arguments: {
      channel: 'd1',
      pattern: 'sound "bd sd bd sd"'
    }
  });
}, 1000);

setTimeout(() => {
  console.log('\n4️⃣  Testing tidal_get_state...');
  sendRequest('tools/call', {
    name: 'tidal_get_state',
    arguments: {}
  });
}, 1500);

// Listen for responses
rl.on('line', (line) => {
  try {
    const response = JSON.parse(line);
    console.log(`📥 Response:`, JSON.stringify(response, null, 2));
  } catch (e) {
    // Ignore non-JSON output
  }
});

// Cleanup after tests
setTimeout(() => {
  console.log('\n✅ Tests complete!');
  console.log('\nIf you saw responses above, the MCP server is working correctly.');
  console.log('Check /tmp/test-tidal-output.tidal to see the generated Tidal code.\n');
  serverProcess.kill();
  process.exit(0);
}, 2500);

// Handle errors
serverProcess.on('error', (error) => {
  console.error('❌ Error starting server:', error);
  process.exit(1);
});

serverProcess.on('exit', (code) => {
  if (code !== 0 && code !== null) {
    console.error(`❌ Server exited with code ${code}`);
    process.exit(code);
  }
});
