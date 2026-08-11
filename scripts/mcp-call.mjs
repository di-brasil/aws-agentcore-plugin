#!/usr/bin/env node
// Minimal MCP stdio client: spawn a server build, call one tool, print the text.
//   node scripts/mcp-call.mjs <dist/index.js> <tool_name> '<json args>'
// Used by verify-fixes.sh to probe two builds with identical calls.

import { spawn } from "node:child_process";

const [distPath, toolName, argsJson = "{}"] = process.argv.slice(2);
if (!distPath || !toolName) {
  console.error("usage: mcp-call.mjs <dist/index.js> <tool_name> '<json args>'");
  process.exit(2);
}

const child = spawn("node", [distPath], { stdio: ["pipe", "pipe", "ignore"] });
const pending = [];
let buffer = "";

child.stdout.on("data", chunk => {
  buffer += chunk;
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const resolve = pending.shift();
      if (resolve) resolve(JSON.parse(line));
    } catch { /* server logs non-JSON to stderr, ignore stray lines */ }
  }
});

let nextId = 1;
const send = (method, params) => new Promise(resolve => {
  pending.push(resolve);
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }) + "\n");
});

const timeout = setTimeout(() => {
  console.error(`timeout calling ${toolName}`);
  child.kill();
  process.exit(1);
}, 60_000);

await send("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "verify-fixes", version: "1.0.0" },
});

const response = await send("tools/call", { name: toolName, arguments: JSON.parse(argsJson) });

clearTimeout(timeout);
child.kill();
process.stdout.write(response?.result?.content?.[0]?.text ?? `<no content: ${JSON.stringify(response)}>`);
