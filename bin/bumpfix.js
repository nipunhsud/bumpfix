#!/usr/bin/env node
// bumpfix — upgrade a dependency, then fix the breaking changes, not just the version number.
// Zero dependencies. Node 18+.
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const HELP = `bumpfix <package>[@version] [options]

Upgrades an npm dependency, runs your tests, and if they break, drives a
coding agent to migrate your calling code until they pass again.

Options:
  --test <cmd>      Test command (default: npm test)
  --agent <cmd>     Agent command, receives the fix prompt on stdin
                    (default: claude -p --permission-mode acceptEdits)
  --max-iters <n>   Max fix attempts (default: 3)
  --pr              Push the branch and open a PR via gh
  --no-branch       Work on the current branch instead of bumpfix/<pkg>
  -h, --help        Show this help
`;

function run(cmd, opts = {}) {
  const r = spawnSync(cmd, { shell: true, encoding: "utf8", ...opts });
  return { code: r.status ?? 1, out: (r.stdout || "") + (r.stderr || "") };
}

function die(msg) { console.error(`bumpfix: ${msg}`); process.exit(1); }

function parseArgs(argv) {
  const pm = detectPm();
  const a = { pm, test: pm.test, agent: "claude -p --permission-mode acceptEdits", maxIters: 3, pr: false, branch: true };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--test") a.test = argv[++i];
    else if (v === "--agent") a.agent = argv[++i];
    else if (v === "--max-iters") { const n = parseInt(argv[++i], 10); a.maxIters = Number.isNaN(n) || n < 0 ? 3 : n; }
    else if (v === "--pr") a.pr = true;
    else if (v === "--no-branch") a.branch = false;
    else if (v === "-h" || v === "--help") { console.log(HELP); process.exit(0); }
    else rest.push(v);
  }
  if (rest.length !== 1) { console.log(HELP); process.exit(rest.length ? 1 : 0); }
  const at = rest[0].lastIndexOf("@");
  a.pkg = at > 0 ? rest[0].slice(0, at) : rest[0];
  a.version = at > 0 ? rest[0].slice(at + 1) : "latest";
  if (!/^(@[a-z0-9~][\w.~-]*\/)?[a-z0-9~][\w.~-]*$/i.test(a.pkg)) die(`invalid package name: ${a.pkg}`);
  if (!/^[\w.^~<>=*|+ -]+$/.test(a.version)) die(`invalid version spec: ${a.version}`);
  return a;
}

function detectPm() {
  let d = process.cwd();
  for (;;) {
    if (fs.existsSync(path.join(d, "pnpm-lock.yaml")))
      return { install: d === process.cwd() && fs.existsSync(path.join(d, "pnpm-workspace.yaml")) ? "pnpm add -w" : "pnpm add", test: "pnpm test" };
    if (fs.existsSync(path.join(d, "yarn.lock"))) return { install: "yarn add", test: "yarn test" };
    if (fs.existsSync(path.join(d, "package-lock.json"))) break;
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  return { install: "npm install", test: "npm test" };
}

function currentVersion(pkg) {
  try {
    const pj = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"));
    for (const k of ["dependencies", "devDependencies", "optionalDependencies"])
      if (pj[k] && pj[k][pkg]) return pj[k][pkg];
  } catch { /* fall through */ }
  return null;
}

function main() {
  const a = parseArgs(process.argv.slice(2));

  if (!fs.existsSync("package.json")) die("no package.json here — run from your project root");
  if (run("git rev-parse --is-inside-work-tree").code !== 0) die("not a git repository");
  if (run("git status --porcelain").out.trim() !== "") die("working tree not clean — commit or stash first");

  const oldVersion = currentVersion(a.pkg) || "(not yet a dependency)";
  const branch = "bumpfix/" + `${a.pkg}-${a.version}`.replace(/[^a-zA-Z0-9._-]/g, "-");
  if (a.branch) {
    if (run(`git checkout -b "${branch}"`).code !== 0) die(`could not create branch ${branch} (already exists?)`);
    console.log(`→ branch ${branch}`);
  }

  console.log(`→ ${a.pm.install} ${a.pkg}@${a.version}`);
  const inst = run(`${a.pm.install} "${a.pkg}@${a.version}"`, { stdio: ["ignore", "inherit", "inherit"], encoding: undefined });
  if (inst.code !== 0) die(`${a.pm.install} failed`);
  const newVersion = currentVersion(a.pkg) || a.version;

  let result = null;
  for (let i = 0; i <= a.maxIters; i++) {
    console.log(`→ ${a.test}${i ? ` (after fix attempt ${i})` : ""}`);
    result = run(a.test);
    if (result.code === 0) break;
    if (i === a.maxIters) {
      console.error(result.out.slice(-4000));
      console.error(`\nbumpfix: tests still failing after ${a.maxIters} fix attempts.`);
      console.error(a.branch ? `Branch ${branch} left in place for manual work.` : "Changes left in working tree.");
      process.exit(1);
    }
    console.log(`✗ tests failing — fix attempt ${i + 1}/${a.maxIters}`);
    const prompt = `The npm dependency "${a.pkg}" in this repository was just upgraded from ${oldVersion} to ${newVersion}.
The test command \`${a.test}\` now fails with the output below.

Fix this repository's source code so it works with ${a.pkg}@${newVersion}.
Rules:
- Do NOT downgrade, pin, or remove ${a.pkg}. Adapt the calling code instead.
- Do NOT weaken, skip, or delete tests to make them pass; change them only where they exercise a genuinely removed/renamed API.
- Consult ${a.pkg}'s changelog or release notes for the breaking changes if useful.
- Keep the diff minimal.

Failing test output:
${result.out.slice(-8000)}`;
    const agent = spawnSync(a.agent, { shell: true, input: prompt, stdio: ["pipe", "inherit", "inherit"] });
    if ((agent.status ?? 1) !== 0) console.error("bumpfix: agent command exited non-zero, re-running tests anyway");
  }

  console.log("✓ tests passing");
  run("git add -A");
  const msg = `Upgrade ${a.pkg} ${oldVersion} -> ${newVersion} and migrate breaking changes\n\nAutomated by bumpfix.`;
  if (run(`git commit -m "${msg.replace(/"/g, '\\"')}"`).code !== 0) die("git commit failed");
  console.log(`✓ committed upgrade of ${a.pkg} to ${newVersion}`);

  if (a.pr) {
    if (run(`git push -u origin "${branch}"`).code !== 0) die("git push failed");
    const pr = run(`gh pr create --fill`, { stdio: ["ignore", "inherit", "inherit"], encoding: undefined });
    if (pr.code !== 0) die("gh pr create failed");
  } else if (a.branch) {
    console.log(`Review with: git diff main...${branch}`);
  }
}

main();
