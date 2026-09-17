#!/usr/bin/env node
// bumpwright — upgrade a dependency, then fix the breaking changes, not just the version number.
// Zero dependencies. Node 18+.
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const HELP = `bumpwright <package>[@version] [options]
       bumpwright audit [options]      Fix every vulnerability that needs a breaking upgrade

Upgrades an npm dependency, runs your tests, and if they break, drives a
coding agent to migrate your calling code until they pass again.

Options:
  --test <cmd>      Test command (default: npm test)
  --agent <cmd>     Agent command, receives the fix prompt on stdin
                    (default: claude -p --permission-mode acceptEdits)
  --max-iters <n>   Max fix attempts (default: 3)
  --workspaces      Also bump the package in every workspace subpackage that declares it
  --pr              Push the branch and open a PR via gh
  --no-branch       Work on the current branch instead of bumpwright/<pkg>
  -h, --help        Show this help
`;

function run(cmd, opts = {}) {
  const r = spawnSync(cmd, { shell: true, encoding: "utf8", ...opts });
  return { code: r.status ?? 1, out: (r.stdout || "") + (r.stderr || "") };
}

function die(msg) { console.error(`bumpwright: ${msg}`); process.exit(1); }

function parseArgs(argv) {
  const pm = detectPm();
  const a = { pm, test: pm.test, agent: "claude -p --permission-mode acceptEdits", maxIters: 3, pr: false, branch: true };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--test") { a.test = argv[++i]; a.testExplicit = true; }
    else if (v === "--workspaces") a.workspaces = true;
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
      return { install: d === process.cwd() && fs.existsSync(path.join(d, "pnpm-workspace.yaml")) ? "pnpm add -w" : "pnpm add", test: "pnpm test", sync: "pnpm install --frozen-lockfile" };
    if (fs.existsSync(path.join(d, "yarn.lock"))) return { install: "yarn add", test: "yarn test", sync: "yarn install --frozen-lockfile" };
    if (fs.existsSync(path.join(d, "package-lock.json"))) break;
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  return { install: "npm install", test: "npm test", sync: "npm ci" };
}

function currentVersion(pkg, dir = ".") {
  try {
    const pj = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    for (const k of ["dependencies", "devDependencies", "optionalDependencies"])
      if (pj[k] && pj[k][pkg]) return pj[k][pkg];
  } catch { /* fall through */ }
  return null;
}

function workspaceDirs(pkg) {
  const dirs = [];
  (function walk(d, depth) {
    if (depth > 4) return;
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory() || e.name === "node_modules" || e.name.startsWith(".")) continue;
      const sub = path.join(d, e.name);
      try {
        const pj = JSON.parse(fs.readFileSync(path.join(sub, "package.json"), "utf8"));
        if ((pj.dependencies && pj.dependencies[pkg]) || (pj.devDependencies && pj.devDependencies[pkg]))
          dirs.push(sub);
      } catch { /* no or bad package.json */ }
      walk(sub, depth + 1);
    }
  })(".", 1);
  if (currentVersion(pkg)) dirs.unshift(".");
  return dirs.length ? dirs : ["."];
}

function auditMode(argv) {
  if (!fs.existsSync("package.json")) die("no package.json here — run from your project root");
  const passthrough = [];
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (["--test", "--agent", "--max-iters"].includes(v)) passthrough.push(v, argv[++i]);
    else if (["--pr", "--no-branch", "--workspaces"].includes(v)) passthrough.push(v);
  }
  console.log("→ npm audit --json");
  const audit = run("npm audit --json");
  let report;
  try { report = JSON.parse(audit.out.slice(audit.out.indexOf("{"))); } catch { die("could not parse npm audit output"); }
  const vulns = report.vulnerabilities || {};
  const advisoriesOf = (v, depth = 0) => {
    // Advisory URLs often live on the transitive entry a via-string points at.
    if (!v || depth > 2) return [];
    return (v.via || []).flatMap((x) =>
      typeof x === "object" ? [x.url || x.title].filter(Boolean) : advisoriesOf(vulns[x], depth + 1));
  };
  const installedMajor = (name) => {
    try { return parseInt(JSON.parse(fs.readFileSync(path.join("node_modules", name, "package.json"), "utf8")).version, 10); }
    catch { return null; }
  };
  const majors = new Map();
  let fixable = 0, downgrades = 0;
  for (const v of Object.values(vulns)) {
    const f = v.fixAvailable;
    if (!f) continue;
    if (f === true || !f.isSemVerMajor) { fixable++; continue; }
    const cur = installedMajor(f.name);
    if (cur !== null && parseInt(f.version, 10) < cur) {
      // npm sometimes proposes an older major as the "fix" — a downgrade PR helps nobody.
      console.log(`→ skipping ${f.name}: npm proposes a downgrade (${cur}.x -> ${f.version})`);
      downgrades++;
      continue;
    }
    const entry = majors.get(f.name) || { version: f.version, severity: v.severity, advisories: [] };
    entry.advisories.push(...advisoriesOf(v));
    majors.set(f.name, entry);
  }
  if (fixable) console.log(`→ ${fixable} finding(s) fixable without a major bump — run \`npm audit fix\` for those`);
  if (!majors.size) { console.log("✓ no vulnerabilities need a breaking upgrade"); process.exit(0); }
  const start = run("git rev-parse --abbrev-ref HEAD").out.trim();
  let failed = 0;
  for (const [name, info] of majors) {
    console.log(`\n=== ${name}@${info.version} — security (${info.severity}) ===`);
    const urls = [...new Set(info.advisories)];
    const env = { ...process.env, BUMPWRIGHT_NOTE: urls.length ? `Security: fixes ${urls.join(", ")}` : `Security: fixes npm audit finding (${info.severity})` };
    const r = spawnSync(process.execPath, [__filename, `${name}@${info.version}`, ...passthrough], { stdio: "inherit", env });
    if ((r.status ?? 1) !== 0) failed++;
    run(`git checkout -f "${start}"`); // back to the starting point...
    run("git checkout -- ."); // ...drop any residue a failed child left...
    console.log("→ resyncing node_modules to the lockfile");
    run(detectPm().sync); // ...and undo the target's install: git can't restore node_modules
  }
  console.log(failed ? `\n✗ ${failed}/${majors.size} security upgrades did not reach green` : `\n✓ all ${majors.size} security upgrades green`);
  process.exit(failed ? 1 : 0);
}

function main() {
  if (process.argv[2] === "audit") return auditMode(process.argv.slice(3));
  const a = parseArgs(process.argv.slice(2));

  if (!fs.existsSync("package.json")) die("no package.json here — run from your project root");
  if (run("git rev-parse --is-inside-work-tree").code !== 0) die("not a git repository");
  if (run("git status --porcelain").out.trim() !== "") die("working tree not clean — commit or stash first");

  if (!a.testExplicit) {
    const pj = JSON.parse(fs.readFileSync("package.json", "utf8"));
    const t = pj.scripts && pj.scripts.test;
    if ((!t || /no test specified/i.test(t)) && pj.scripts && pj.scripts.build) {
      a.test = `${a.pm.test.split(" ")[0]} run build`;
      console.log(`→ no test script; using the build as the gate: ${a.test}`);
    }
  }

  console.log(`→ baseline: ${a.test}`);
  const baseline = run(a.test);
  if (baseline.code !== 0) {
    console.error(baseline.out.slice(-2000));
    die(`the gate "${a.test}" is already red before any upgrade — fix that first, or pass a working --test`);
  }

  const targets = a.workspaces ? workspaceDirs(a.pkg) : ["."];
  if (a.workspaces) console.log(`→ workspaces declaring ${a.pkg}: ${targets.join(", ")}`);
  const oldVersion = currentVersion(a.pkg, targets[0]) || "(not yet a dependency)";
  const branch = "bumpwright/" + `${a.pkg}-${a.version}`.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/^-+/, "");
  if (a.branch) {
    if (run(`git checkout -b "${branch}"`).code !== 0) die(`could not create branch ${branch} (already exists?)`);
    console.log(`→ branch ${branch}`);
  }

  const specs = [`${a.pkg}@${a.version}`];
  for (const dir of targets) {
    for (;;) {
      const cmd = dir === "." ? a.pm.install : a.pm.install.replace(/ -w$/, "");
      console.log(`→ ${cmd} ${specs.join(" ")}${dir === "." ? "" : ` (in ${dir})`}`);
      const inst = run(`${cmd} ${specs.map((x) => `"${x}"`).join(" ")}`, { cwd: dir });
      if (inst.code === 0) break;
      // Peer conflict: bump the blocking companion alongside the target and retry.
      const m = inst.out.match(/Conflicting peer dependency: (@?[\w./-]+)@(\d+)/);
      const okName = m && /^(@[a-z0-9~][\w.~-]*\/)?[a-z0-9~][\w.~-]*$/i.test(m[1]);
      const companion = okName ? `${m[1]}@^${m[2]}` : null;
      if (!companion || specs.includes(companion)) {
        console.error(inst.out.slice(-3000));
        die(`install failed${dir === "." ? "" : ` in ${dir}`}`);
      }
      console.log(`→ peer conflict with ${m[1]}; retrying with companion ${companion}`);
      specs.push(companion);
    }
  }
  const newVersion = currentVersion(a.pkg, targets[0]) || a.version;

  let result = null;
  for (let i = 0; i <= a.maxIters; i++) {
    console.log(`→ ${a.test}${i ? ` (after fix attempt ${i})` : ""}`);
    result = run(a.test);
    if (result.code === 0) break;
    if (i === a.maxIters) {
      console.error(result.out.slice(-4000));
      console.error(`\nbumpwright: tests still failing after ${a.maxIters} fix attempts.`);
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
    if ((agent.status ?? 1) !== 0) console.error("bumpwright: agent command exited non-zero, re-running tests anyway");
  }

  console.log("✓ tests passing");
  run("git add -A");
  const note = process.env.BUMPWRIGHT_NOTE ? `${process.env.BUMPWRIGHT_NOTE}\n\n` : "";
  const msg = `Upgrade ${a.pkg} ${oldVersion} -> ${newVersion} and migrate breaking changes\n\n${note}Automated by bumpwright.`;
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
