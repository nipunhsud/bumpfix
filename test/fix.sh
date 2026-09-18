#!/usr/bin/env bash
# bumpwright fix: guardrail loop around `npm audit fix` — fixer stubbed so live
# advisory feeds can't decide the outcome (all-lodash-4.x-vulnerable taught us).
set -euo pipefail
BW="$(cd "$(dirname "$0")/.." && pwd)/bin/bumpwright.js"
REAL_NPM=$(command -v npm)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
cd "$TMP"
git init -q -b main && git config user.email t@t && git config user.name t
printf '{ "name":"f","private":true,"scripts":{"test":"exit 0"} }' > package.json
"$REAL_NPM" install --silent lodash@4.17.11 >/dev/null 2>&1
mkdir shim
cat > shim/npm <<STUB
#!/usr/bin/env bash
if [ "\$1 \$2" = "audit fix" ]; then
  perl -pi -e 's/4\\.17\\.11/4.17.21/g' package-lock.json
  exit 0
fi
exec "$REAL_NPM" "\$@"
STUB
chmod +x shim/npm
printf 'node_modules/\nshim/\n' > .gitignore
git add -A && git commit -qm init
PATH="$TMP/shim:$PATH" node "$BW" fix >/dev/null
git rev-parse --verify -q bumpwright/audit-fix >/dev/null || { echo "FAIL: no fix branch"; exit 1; }
git show bumpwright/audit-fix:package-lock.json | grep -q '4\.17\.21' || { echo "FAIL: lockfile not updated"; exit 1; }
git log bumpwright/audit-fix -1 --pretty=%s | grep -q "npm audit fix" || { echo "FAIL: bad commit"; exit 1; }

# Gate-breaking fixes must revert and refuse.
git checkout -q main
cat > shim/npm <<STUB
#!/usr/bin/env bash
if [ "\$1 \$2" = "audit fix" ]; then
  perl -pi -e 's/4\\.17\\.11/4.17.21/g' package-lock.json
  echo broken > gate-marker
  exit 0
fi
exec "$REAL_NPM" "\$@"
STUB
if PATH="$TMP/shim:$PATH" node "$BW" fix --no-branch --test "test ! -f gate-marker" >/dev/null 2>&1; then
  echo "FAIL: gate-breaking fix was accepted"; exit 1
fi
git diff --quiet -- package-lock.json || { echo "FAIL: broken fix not reverted"; exit 1; }
echo "FIX OK"
