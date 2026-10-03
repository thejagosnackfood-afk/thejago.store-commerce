#!/usr/bin/env node
'use strict';

// Codex-compatible MCP stdio entrypoint. Keep stdout reserved for MCP frames.
const readline = require('node:readline');
const { callResearchTool, listResearchTools } = require('./marketplace-intelligence.cjs');

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

function send(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function error(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handle(message) {
  if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    if (message?.id !== undefined) error(message.id, -32600, 'Invalid Request');
    return;
  }
  const id = message.id;
  if (message.method.startsWith('notifications/')) return;
  if (id === undefined) return;
  if (message.method === 'initialize') {
    const requested = message.params?.protocolVersion;
    send({ jsonrpc: '2.0', id, result: {
      protocolVersion: typeof requested === 'string' ? requested : '2024-11-05',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'jago-marketplace-intelligence', version: '1.0.0' },
    } });
    return;
  }
  if (message.method === 'ping') {
    send({ jsonrpc: '2.0', id, result: {} });
    return;
  }
  if (message.method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: listResearchTools() } });
    return;
  }
  if (message.method === 'tools/call') {
    const name = message.params?.name;
    try {
      const result = await callResearchTool(name, message.params?.arguments || {});
      const value = { source: result.source, marketplace: result.marketplace, result: result.result, fetchedAt: result.fetchedAt };
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError: false } });
    } catch (err) {
      const messageText = String(err?.message || 'Riset gagal.').slice(0, 500);
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: messageText }], isError: true } });
    }
    return;
  }
  error(id, -32601, `Method not found: ${message.method}`);
}

rl.on('line', line => {
  if (!line.trim()) return;
  if (Buffer.byteLength(line) > 1024 * 1024) {
    error(null, -32700, 'Message too large');
    return;
  }
  let message;
  try { message = JSON.parse(line); }
  catch { error(null, -32700, 'Parse error'); return; }
  void handle(message).catch(() => {
    if (message.id !== undefined) error(message.id, -32603, 'Internal error');
  });
});

rl.on('close', () => process.exit(0));
