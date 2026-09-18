#!/usr/bin/env bash
# Smoke test: exercises the full orchestration loop (branch, install, failing
# tests, agent invocation via stdin, retest, commit) with a fake agent.
set -euo pipefail
BUMPWRIGHT="$(cd "$(dirname "$0")/.." && pwd)/bin/bumpwright.js"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
cd "$TMP"

git init -q -b main
git config user.email t@t && git config user.name t
cat > package.json <<'PKG'
{ "name": "fixture", "version": "1.0.0", "private": true,
  "dependencies": { "isarray": "1.0.0" },
  "scripts": { "test": "bash check.sh" } }
PKG
cat > check.sh <<'CHK'
#!/usr/bin/env bash
v=$(node -p "require('isarray/package.json').version")
case "$v" in 1.*) exit 0;; esac
test -f fixed.txt
CHK
npm install --silent >/dev/null 2>&1
# Fake agent: verifies the prompt arrived on stdin, then "fixes" the code.
cat > agent.sh <<'AGENT'
#!/usr/bin/env bash
grep -q 'isarray' - || { echo "prompt missing package name" >&2; exit 1; }
touch fixed.txt
AGENT
chmod +x agent.sh
git add -A && git commit -qm init

node "$BUMPWRIGHT" isarray@2.0.5 --agent ./agent.sh --max-iters 2

git rev-parse --verify -q bumpwright/isarray-2.0.5 >/dev/null || { echo "FAIL: branch missing"; exit 1; }
git log -1 --pretty=%s | grep -q "Upgrade isarray" || { echo "FAIL: commit missing"; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "FAIL: dirty tree after run"; exit 1; }
grep -q '"isarray": "\^\?2' package.json || grep -q '2.0.5' package.json || { echo "FAIL: version not bumped"; exit 1; }
# Injection attempts must die at arg parsing, before any git/npm command.
if node "$BUMPWRIGHT" 'x$(touch inj1)' 2>/dev/null; then echo "FAIL: bad package accepted"; exit 1; fi
if node "$BUMPWRIGHT" 'isarray@1.0.0$(touch inj2)' 2>/dev/null; then echo "FAIL: bad version accepted"; exit 1; fi
[ ! -f inj1 ] && [ ! -f inj2 ] || { echo "FAIL: injection executed"; exit 1; }

# --max-iters 0 = bump and test only: must fail red without ever running the agent.
git checkout -q main
if node "$BUMPWRIGHT" isarray@2.0.5 --agent ./agent.sh --max-iters 0 --no-branch >/dev/null 2>&1; then
  echo "FAIL: max-iters 0 should exit non-zero on red tests"; exit 1
fi
[ ! -f fixed.txt ] || { echo "FAIL: agent ran despite --max-iters 0"; exit 1; }

echo "SMOKE OK"
