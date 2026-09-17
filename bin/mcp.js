#!/usr/bin/env node
// bumpwright-mcp — MCP stdio server exposing bumpwright as a tool.
// Zero dependencies: newline-delimited JSON-RPC 2.0 per the MCP stdio transport.
const readline = require("readline");
const { spawn } = require("child_process");
const path = require("path");
const os = require("os");
const fs = require("fs");

const BUMPWRIGHT = path.join(__dirname, "bumpwright.js");
const VERSION = require("../package.json").version;
const PROTOCOL = "2025-06-18";
const TAIL = 10000; // chars of run output returned to the client
const TIMEOUT_MS = 30 * 60 * 1000; // ponytail: fixed 30-min cap; make it a tool arg if runs need longer
// GUI-launched hosts (Claude Desktop, Cursor) pass a minimal PATH; keep npm,
// git, gh and the default claude agent resolvable from the usual install dirs.
const ENV = {
  ...process.env,
  PATH: [process.env.PATH, "/usr/local/bin", "/opt/homebrew/bin", path.join(os.homedir(), ".local/bin")]
    .filter(Boolean).join(path.delimiter)
};

const PKG_RE = /^(@[a-z0-9~][\w.~-]*\/)?[a-z0-9~][\w.~-]*$/i;
const VER_RE = /^[\w.^~<>=*|+ -]+$/;

const TOOL = {
  name: "upgrade_dependency",
  description:
    "Upgrade an npm dependency in a git repository and automatically migrate the calling code past any breaking changes. " +
    "Bumps the package, runs the project's tests, and if they fail drives a coding agent to fix the source until tests pass. " +
    "Commits on a bumpwright/<pkg> branch; never touches main; fails rather than shipping red tests. " +
    "Requires a clean git working tree.",
  inputSchema: {
    type: "object",
    properties: {
      package: { type: "string", description: "npm package name, e.g. \"react\"" },
      version: { type: "string", description: "Target version or dist-tag (default: latest)" },
      cwd: { type: "string", description: "Absolute path to the project root (must contain package.json)" },
      test: { type: "string", description: "Test command (default: npm test)" },
      agent: { type: "string", description: "Agent command receiving the fix prompt on stdin (default: claude -p --permission-mode acceptEdits)" },
      max_iters: { type: "integer", description: "Max fix attempts; 0 = bump and test only, never run the agent (default: 3)" },
      pr: { type: "boolean", description: "Push the branch and open a PR via gh (default: false)" }
    },
    required: ["package", "cwd"]
  }
};

function send(msg) { process.stdout.write(JSON.stringify(msg) + "\n"); }
function reply(id, result) { send({ jsonrpc: "2.0", id, result }); }
function replyErr(id, code, message) { send({ jsonrpc: "2.0", id, error: { code, message } }); }

let running = false; // ponytail: one upgrade at a time per server; queue if anyone ever needs more

function callTool(args, respond) {
  const fail = (text) => respond(false, text);
  if (typeof args.package !== "string" || !PKG_RE.test(args.package))
    return fail('invalid or missing "package": must be a legal npm package name');
  if (args.version !== undefined && (typeof args.version !== "string" || !VER_RE.test(args.version)))
    return fail('invalid "version": must be a plain version, range, or dist-tag');
  if (typeof args.cwd !== "string" || !path.isAbsolute(args.cwd) || !fs.existsSync(args.cwd))
    return fail('"cwd" must be an absolute path to an existing project directory');
  if (running)
    return fail("an upgrade is already running in this server — wait for it to finish");

  const spec = args.version ? `${args.package}@${args.version}` : args.package;
  const argv = [BUMPWRIGHT, spec];
  if (args.test) argv.push("--test", String(args.test));
  if (args.agent) argv.push("--agent", String(args.agent));
  if (args.max_iters !== undefined) argv.push("--max-iters", String(args.max_iters));
  if (args.pr) argv.push("--pr");

  running = true;
  let out = "", done = false;
  const finish = (ok, text) => {
    if (done) return;
    done = true; running = false; clearTimeout(timer);
    respond(ok, text.slice(-TAIL) || "(no output)");
  };
  const child = spawn(process.execPath, argv, { cwd: args.cwd, env: ENV });
  const timer = setTimeout(() => {
    out += `\nbumpwright-mcp: run exceeded ${TIMEOUT_MS / 60000} minutes, killed`;
    child.kill("SIGTERM");
  }, TIMEOUT_MS);
  child.stdout.on("data", (d) => { out = (out + d).slice(-TAIL * 2); });
  child.stderr.on("data", (d) => { out = (out + d).slice(-TAIL * 2); });
  child.on("error", (e) => finish(false, out + `\nspawn error: ${e.message}`));
  child.on("close", (code) => finish(code === 0, out));
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  line = line.trim();
  if (!line) return;
  let msg;
  try { msg = JSON.parse(line); }
  catch { return send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }); }
  const { id, method, params } = msg;
  if (id === undefined || id === null) return; // notification — nothing to do
  try {
    if (method === "initialize") {
      reply(id, { protocolVersion: PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: "bumpwright", version: VERSION } });
    } else if (method === "tools/list") {
      reply(id, { tools: [TOOL] });
    } else if (method === "tools/call") {
      if (!params || params.name !== TOOL.name) return replyErr(id, -32602, `unknown tool: ${params && params.name}`);
      callTool(params.arguments || {}, (ok, text) =>
        reply(id, { content: [{ type: "text", text }], isError: !ok }));
    } else if (method === "ping") {
      reply(id, {});
    } else {
      replyErr(id, -32601, `method not found: ${method}`);
    }
  } catch (e) {
    replyErr(id, -32603, String(e && e.message || e));
  }
});
