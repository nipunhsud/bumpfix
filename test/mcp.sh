#!/usr/bin/env bash
# Smoke test for the MCP server: initialize, tools/list, and an invalid call.
set -euo pipefail
MCP="$(cd "$(dirname "$0")/.." && pwd)/bin/mcp.js"
OUT=$(printf '%s\n%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"upgrade_dependency","arguments":{"package":"isarray","cwd":"/nonexistent-dir"}}}' \
  | node "$MCP")
echo "$OUT" | grep -q '"serverInfo":{"name":"bumpfix"' || { echo "FAIL: initialize"; exit 1; }
echo "$OUT" | grep -q '"name":"upgrade_dependency"'    || { echo "FAIL: tools/list"; exit 1; }
echo "$OUT" | grep -q '"isError":true'                 || { echo "FAIL: bad cwd should be isError"; exit 1; }
echo "MCP SMOKE OK"
