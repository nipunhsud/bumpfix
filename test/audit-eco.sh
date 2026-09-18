#!/usr/bin/env bash
# Live tests: pnpm and pip-audit collectors end to end.
set -euo pipefail
BW="$(cd "$(dirname "$0")/.." && pwd)/bin/bumpwright.js"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# --- pnpm: direct vulnerable dep gets bumped to the highest patched version ---
mkdir "$TMP/pn" && cd "$TMP/pn"
git init -q -b main && git config user.email t@t && git config user.name t
printf '{ "name":"pn","private":true,"scripts":{"test":"exit 0"} }' > package.json
printf 'packages:\n  - packages/*\n' > pnpm-workspace.yaml
mkdir -p packages/a
printf '{ "name":"a","private":true,"dependencies":{"minimist":"0.0.8"},"scripts":{"test":"exit 0"} }' > packages/a/package.json
pnpm install --silent >/dev/null 2>&1
printf 'node_modules/\n' > .gitignore
git add -A && git commit -qm init
node "$BW" audit >/dev/null 2>&1 || { echo "FAIL: pnpm audit run failed"; exit 1; }
BR=$(git branch --list 'bumpwright/minimist-*' --format='%(refname:short)' | head -1)
[ -n "$BR" ] || { echo "FAIL: no pnpm audit branch"; exit 1; }
git show "$BR:packages/a/package.json" | grep -Eq '"minimist": ?"\^?(0\.2\.[4-9]|[1-9])' || { echo "FAIL: minimist not bumped past advisories"; git show "$BR:package.json"; exit 1; }
git log "$BR" -1 --pretty=%B | grep -q "Security: fixes http" || { echo "FAIL: no advisory in pnpm commit"; exit 1; }
echo "PNPM AUDIT OK"

# --- pip-audit collector: stubbed feed (live 2026 fixes need py>=3.10), real pip install ---
mkdir "$TMP/py" && cd "$TMP/py"
git init -q -b main && git config user.email t@t && git config user.name t
python3 -m venv .venv >/dev/null
mkdir stub
cat > stub/pip-audit <<'STUB'
#!/usr/bin/env bash
echo '{"dependencies":[{"name":"six","version":"1.15.0","vulns":[{"id":"PYSEC-TEST-1","fix_versions":["1.16.0"],"aliases":[]}]}],"fixes":[]}'
STUB
chmod +x stub/pip-audit
export PATH="$TMP/py/stub:$TMP/py/.venv/bin:$PATH"
python3 -m pip install --quiet six==1.15.0
echo "six==1.15.0" > requirements.txt
printf '.venv/\nstub/\n' > .gitignore
git add -A && git commit -qm init
node "$BW" audit --test "python3 -c 'import six'" >/dev/null 2>&1 || { echo "FAIL: pip audit run failed"; exit 1; }
BR=$(git branch --list 'bumpwright/six-*' --format='%(refname:short)' | head -1)
[ -n "$BR" ] || { echo "FAIL: no py audit branch"; exit 1; }
git show "$BR:requirements.txt" | grep -q 'six==1.16.0' || { echo "FAIL: six not bumped: $(git show "$BR:requirements.txt")"; exit 1; }
git log "$BR" -1 --pretty=%B | grep -q "osv.dev/vulnerability/PYSEC-TEST-1" || { echo "FAIL: no OSV advisory in commit"; exit 1; }
echo "PIP AUDIT OK"

# --- --overrides: transitive vuln (mkdirp 0.5.1 bundles vulnerable minimist) pinned at patched floor ---
mkdir "$TMP/tx" && cd "$TMP/tx"
git init -q -b main && git config user.email t@t && git config user.name t
printf '{ "name":"tx","private":true,"dependencies":{"mkdirp":"0.5.1"},"scripts":{"test":"exit 0"} }' > package.json
pnpm install --silent >/dev/null 2>&1
printf 'node_modules/\n' > .gitignore
git add -A && git commit -qm init
node "$BW" audit --overrides >/dev/null 2>&1 || { echo "FAIL: overrides run failed"; exit 1; }
git rev-parse --verify -q bumpwright/security-overrides >/dev/null || { echo "FAIL: no overrides branch"; exit 1; }
git show bumpwright/security-overrides:package.json | grep -q '"minimist": "\^0\.' || { echo "FAIL: override not written"; exit 1; }
git log bumpwright/security-overrides -1 --pretty=%B | grep -q "TEMPORARY" || { echo "FAIL: no temporary label"; exit 1; }
git log bumpwright/security-overrides -1 --pretty=%B | grep -q "github.com/advisories" || { echo "FAIL: no advisory links"; exit 1; }
echo "OVERRIDES OK"
