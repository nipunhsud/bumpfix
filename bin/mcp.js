#!/usr/bin/env node
// bumpfix-mcp — MCP stdio server exposing bumpfix as a tool.
// Zero dependencies: newline-delimited JSON-RPC 2.0 per the MCP stdio transport.
const readline = require("readline");
const { spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const BUMPFIX = path.join(__dirname, "bumpfix.js");
const VERSION = require("../package.json").version;

const TOOL = {
  name: "upgrade_dependency",
  description:
    "Upgrade an npm dependency in a git repository and automatically migrate the calling code past any breaking changes. " +
    "Bumps the package, runs the project's tests, and if they fail drives a coding agent to fix the source until tests pass. " +
    "Commits on a bumpfix/<pkg> branch; never touches main; fails rather than shipping red tests. " +
    "Requires a clean git working tree.",
  inputSchema: {
    type: "object",
    properties: {
      package: { type: "string", description: "npm package name, e.g. \"react\"" },
      version: { type: "string", description: "Target version or dist-tag (default: latest)" },
      cwd: { type: "string", description: "Absolute path to the project root (must contain package.json)" },
      test: { type: "string", description: "Test command (default: npm test)" },
      agent: { type: "string", description: "Agent command receiving the fix prompt on stdin (default: claude -p --permission-mode acceptEdits)" },
      max_iters: { type: "integer", description: "Max fix attempts (default: 3)" },
      pr: { type: "boolean", description: "Push the branch and open a PR via gh (default: false)" }
    },
    required: ["package", "cwd"]
  }
};

function send(msg) { process.stdout.write(JSON.stringify(msg) + "\n"); }
function reply(id, result) { send({ jsonrpc: "2.0", id, result }); }
function replyErr(id, code, message) { send({ jsonrpc: "2.0", id, error: { code, message } }); }

function callTool(args) {
  const cwd = args.cwd;
  if (!cwd || !path.isAbsolute(cwd) || !fs.existsSync(path.join(cwd, "package.json")))
    return { ok: false, text: "cwd must be an absolute path to a directory containing package.json" };
  const spec = args.version ? `${args.package}@${args.version}` : args.package;
  const argv = [BUMPFIX, spec];
  if (args.test) argv.push("--test", args.test);
  if (args.agent) argv.push("--agent", args.agent);
  if (args.max_iters) argv.push("--max-iters", String(args.max_iters));
  if (args.pr) argv.push("--pr");
  const r = spawnSync(process.execPath, argv, { cwd, encoding: "utf8" });
  const text = ((r.stdout || "") + (r.stderr || "")).slice(-10000) || "(no output)";
  return { ok: r.status === 0, text };
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  line = line.trim();
  if (!line) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;
  if (id === undefined || id === null) return; // notification — nothing to do
  try {
    if (method === "initialize") {
      reply(id, {
        protocolVersion: (params && params.protocolVersion) || "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "bumpfix", version: VERSION }
      });
    } else if (method === "tools/list") {
      reply(id, { tools: [TOOL] });
    } else if (method === "tools/call") {
      if (!params || params.name !== TOOL.name) return replyErr(id, -32602, `unknown tool: ${params && params.name}`);
      const res = callTool(params.arguments || {});
      reply(id, { content: [{ type: "text", text: res.text }], isError: !res.ok });
    } else if (method === "ping") {
      reply(id, {});
    } else {
      replyErr(id, -32601, `method not found: ${method}`);
    }
  } catch (e) {
    replyErr(id, -32603, String(e && e.message || e));
  }
});
