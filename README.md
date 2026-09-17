# bumpwright

**Upgrade a dependency, then fix the breaking changes — not just the version number.**

Dependabot and Renovate bump the version and hand you a red CI run. `bumpwright`
bumps the version, runs your tests, and when they break it drives a coding
agent to migrate your calling code until they pass again — then commits the
whole thing on a branch, optionally as a PR.

```
npx bumpwright react@19
```

What it does:

1. Checks your git tree is clean, creates `bumpwright/react-19`.
2. `npm install react@19`.
3. Runs your tests (`npm test` by default). Green? Commits, done.
4. Red? Feeds the failing output to a coding agent (Claude Code by default)
   with strict rules: adapt the calling code, never downgrade the package,
   never delete tests. Re-runs tests. Up to `--max-iters` times.
5. Green tests → one commit: the upgrade *and* the migration. `--pr` pushes
   and opens the PR via `gh`.

If the agent can't get to green, bumpwright exits non-zero and leaves the branch
in place with whatever progress was made. Your main branch is never touched.

## Install

```
npm install -g bumpwright     # or: npx bumpwright <pkg>
```

Requires Node 18+, git, and an agent CLI on your PATH
([Claude Code](https://claude.com/claude-code) by default).

## Usage

```
bumpwright <package>[@version] [options]

  --test <cmd>      Test command (default: npm test)
  --agent <cmd>     Agent command, receives the fix prompt on stdin
                    (default: claude -p --permission-mode acceptEdits)
  --max-iters <n>   Max fix attempts (default: 3)
  --pr              Push the branch and open a PR via gh
  --no-branch       Work on the current branch
  --workspaces      Also bump the package in every workspace subpackage that declares it
```

bumpwright also handles the parts that leave Dependabot PRs red or unopened:

- **Companion bumps.** If the install fails on a peer conflict (vite 8 wants a
  newer `@types/node` than you pin), bumpwright bumps the blocking companion
  alongside the target and retries, instead of dying like `npm install` does.
- **No test script?** If `package.json` has a build script but no real test
  script, the build becomes the red/green gate automatically.
- **pnpm and yarn** are detected from lockfiles, including from inside a
  workspace subpackage.

## Why not just ask Claude Code?

You can. Claude Code (or any coding agent) can do everything bumpwright does if
you prompt it carefully every time. bumpwright is the workflow, hardened:

- The guardrails are code, not prompt text: clean tree required, own branch,
  red tests never ship, one reviewable commit. An agent freelancing in your
  repo guarantees none of that.
- It's one command with zero prompt engineering, and the same command works
  headless in CI on a schedule — where nobody is typing prompts.
- It's agent-agnostic: swap Claude Code for Codex or anything else with
  `--agent` and the workflow doesn't change.

Any agent that reads a prompt on stdin and edits the working directory works:

```
bumpwright lodash --agent "claude -p --permission-mode acceptEdits"
bumpwright lodash --agent "codex exec --full-auto -"
```

## Python projects

The same loop works on Python. In a directory with `pyproject.toml` or
`requirements.txt` (and no `package.json`):

```
bumpwright requests@2.32.5 --test pytest
```

- `uv` projects: upgraded via `uv add` / `uv lock --upgrade-package` + `uv sync`
- pip projects: installed into the active environment and `requirements.txt`
  is rewritten to match, so the manifest stays truthful
- Default gate is `pytest`; pass `--test` for anything else
- Same guardrails: clean tree, green baseline required, own branch, red never ships

`audit` for Python (pip-audit) is next on the roadmap; today audit mode is npm-only.

## Security mode: `bumpwright audit`

The vulnerabilities nobody patches are the ones where the fix needs a breaking
upgrade — `npm audit fix` can't touch them and Dependabot's PR arrives red.

```
bumpwright audit --pr
```

Runs `npm audit`, skips everything a plain `npm audit fix` can handle, and for
each finding whose fix is a semver-major bump it runs the full migrate loop on
its own branch. The advisory URLs and severity land in the commit and PR body,
so the PR reads as the security fix it is. Exits non-zero if any upgrade
couldn't reach green.

Standing service on any repo — daily cron via the Action:

```yaml
      - uses: nipunhsud/bumpwright@v0.4.0
        with:
          package: audit             # security mode
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
```

## GitHub Action (the Dependabot-replacement mode)

Dependabot opens red PRs on a schedule. This opens green ones:

```yaml
name: weekly-upgrades
on:
  schedule: [{ cron: "0 6 * * 1" }]
  workflow_dispatch:
jobs:
  upgrade:
    runs-on: ubuntu-latest
    permissions: { contents: write, pull-requests: write }
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: nipunhsud/bumpwright@v0.4.0
        with:
          package: react@19          # or matrix over several packages
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
        env:
          GH_TOKEN: ${{ github.token }}
```

If the migration can't reach green, the job fails and nothing is opened —
you get silence instead of a red PR to babysit.

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

## Related work

[Shridhar2104/bumpfix](https://github.com/marketplace/actions/bumpfix) applies
the same core idea — an agent fixing what a dependency bump broke, gated on
tests — as a CI-only action for Python manifests. Bumpwright is the npm-side
take, and adds initiation (you point it at an upgrade), `audit` security mode,
workspaces, companion bumps, an MCP server, and agent-agnostic drivers.

## License

MIT

## Use with LLM coding tools

**Claude Code (or any agent with a shell):** no integration needed. Install
bumpwright on your PATH and add one line to your project's `CLAUDE.md`:

```
For dependency upgrades, run `bumpwright <pkg>@<version>` instead of hand-migrating.
```

**MCP (Claude Desktop, Cursor, and other no-shell clients):** bumpwright ships a
zero-dependency MCP stdio server exposing one tool, `upgrade_dependency`.

```
claude mcp add bumpwright -- bumpwright-mcp
```

Or in any MCP client config:

```json
{ "mcpServers": { "bumpwright": { "command": "bumpwright-mcp" } } }
```

The tool takes `package`, `cwd` (absolute project path), and optionally
`version`, `test`, `agent`, `max_iters`, `pr`. Same guardrails as the CLI:
clean tree required, own branch, red tests never ship.
