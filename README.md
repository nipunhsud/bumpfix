# bumpfix

**Upgrade a dependency, then fix the breaking changes — not just the version number.**

Dependabot and Renovate bump the version and hand you a red CI run. `bumpfix`
bumps the version, runs your tests, and when they break it drives a coding
agent to migrate your calling code until they pass again — then commits the
whole thing on a branch, optionally as a PR.

```
npx bumpfix react@19
```

What it does:

1. Checks your git tree is clean, creates `bumpfix/react-19`.
2. `npm install react@19`.
3. Runs your tests (`npm test` by default). Green? Commits, done.
4. Red? Feeds the failing output to a coding agent (Claude Code by default)
   with strict rules: adapt the calling code, never downgrade the package,
   never delete tests. Re-runs tests. Up to `--max-iters` times.
5. Green tests → one commit: the upgrade *and* the migration. `--pr` pushes
   and opens the PR via `gh`.

If the agent can't get to green, bumpfix exits non-zero and leaves the branch
in place with whatever progress was made. Your main branch is never touched.

## Install

```
npm install -g bumpfix     # or: npx bumpfix <pkg>
```

Requires Node 18+, git, and an agent CLI on your PATH
([Claude Code](https://claude.com/claude-code) by default).

## Usage

```
bumpfix <package>[@version] [options]

  --test <cmd>      Test command (default: npm test)
  --agent <cmd>     Agent command, receives the fix prompt on stdin
                    (default: claude -p --permission-mode acceptEdits)
  --max-iters <n>   Max fix attempts (default: 3)
  --pr              Push the branch and open a PR via gh
  --no-branch       Work on the current branch
```

Any agent that reads a prompt on stdin and edits the working directory works:

```
bumpfix lodash --agent "claude -p --permission-mode acceptEdits"
bumpfix lodash --agent "codex exec --full-auto -"
```

## Why

- Security patching and dependency maintenance is the #1 reported pain in the
  [2026 State of Open Source report](https://www.openlogic.com/blog/state-of-open-source-report-key-insights);
  55% of orgs that failed a compliance audit were running end-of-life packages
  they were afraid to upgrade.
- Version bumps are automated. Code migration isn't. That gap is where
  upgrades go to die in a `dependabot-ignore` list.

## Safety

- Refuses to run on a dirty working tree.
- Works on its own branch; your history is one `git branch -D` away from clean.
- The agent is instructed to never weaken or skip tests — but review the diff
  like any PR. It's a coding agent, not a notary.

## License

MIT
