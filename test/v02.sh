#!/usr/bin/env bash
# v0.2 checks: auto build gate, --workspaces, companion bump on peer conflict.
set -euo pipefail
BUMPFIX="$(cd "$(dirname "$0")/.." && pwd)/bin/bumpfix.js"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# 1. No test script + build script present -> build becomes the gate.
mkdir "$TMP/gate" && cd "$TMP/gate"
git init -q -b main && git config user.email t@t && git config user.name t
printf '{ "name":"g","private":true,"dependencies":{"isarray":"1.0.0"},"scripts":{"build":"test -f fixed.txt"} }' > package.json
npm install --silent >/dev/null 2>&1
printf '#!/usr/bin/env bash\ntouch fixed.txt\n' > agent.sh && chmod +x agent.sh
git add -A && git commit -qm init
OUT=$(node "$BUMPFIX" isarray@2.0.5 --agent ./agent.sh)
echo "$OUT" | grep -q "using the build as the gate" || { echo "FAIL: build gate not chosen"; exit 1; }
git log -1 --pretty=%s | grep -q "Upgrade isarray" || { echo "FAIL: gate run did not commit"; exit 1; }

# 2. --workspaces bumps every subpackage declaring the dep.
mkdir -p "$TMP/ws/packages/a" "$TMP/ws/packages/b" && cd "$TMP/ws"
git init -q -b main && git config user.email t@t && git config user.name t
printf '{ "name":"root","private":true,"scripts":{"test":"exit 0"} }' > package.json
printf '{ "name":"a","dependencies":{"isarray":"1.0.0"} }' > packages/a/package.json
printf '{ "name":"b","devDependencies":{"isarray":"1.0.0"} }' > packages/b/package.json
git add -A && git commit -qm init
node "$BUMPFIX" isarray@2.0.5 --workspaces >/dev/null
grep -q '2.0.5' packages/a/package.json || { echo "FAIL: workspace a not bumped"; exit 1; }
grep -q '2.0.5' packages/b/package.json || { echo "FAIL: workspace b not bumped"; exit 1; }

# 3. Peer conflict -> companion bump (live npm, reproduces the ottehr ERESOLVE).
mkdir "$TMP/peer" && cd "$TMP/peer"
git init -q -b main && git config user.email t@t && git config user.name t
printf '{ "name":"p","private":true,"devDependencies":{"@types/node":"^18.0.0"},"scripts":{"test":"exit 0"} }' > package.json
npm install --silent >/dev/null 2>&1
git add -A && git commit -qm init
OUT=$(node "$BUMPFIX" vite@8 --no-branch 2>&1) || { echo "$OUT" | tail -5; echo "FAIL: peer-conflict run failed"; exit 1; }
echo "$OUT" | grep -q "retrying with companion @types/node@^2" || { echo "FAIL: no companion retry"; exit 1; }
grep -Eq '"@types/node": ?"\^2' package.json || { echo "FAIL: companion not bumped"; exit 1; }

echo "V02 OK"

# 4. bumpfix audit: a vuln whose fix is a major bump gets its own green branch
#    with the advisory in the commit (live npm audit against minimist 0.0.8).
mkdir "$TMP/audit" && cd "$TMP/audit"
git init -q -b main && git config user.email t@t && git config user.name t
printf '{ "name":"v","private":true,"dependencies":{"minimist":"0.0.8"},"scripts":{"test":"exit 0"} }' > package.json
npm install --silent >/dev/null 2>&1 || true
git add -A && git commit -qm init
OUT=$(node "$BUMPFIX" audit 2>&1) || { echo "$OUT" | tail -5; echo "FAIL: audit run failed"; exit 1; }
echo "$OUT" | grep -q "security" || { echo "FAIL: no security section"; exit 1; }
BR=$(git branch --list 'bumpfix/minimist-*' --format='%(refname:short)' | head -1)
[ -n "$BR" ] || { echo "FAIL: no audit branch created"; exit 1; }
git log "$BR" -1 --pretty=%B | grep -q "Security: fixes" || { echo "FAIL: advisory not in commit"; exit 1; }
git show "$BR:package.json" | grep -Eq '"minimist": ?"\^?1' || { echo "FAIL: minimist not on 1.x"; exit 1; }

echo "AUDIT OK"
