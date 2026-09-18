#!/usr/bin/env bash
# Runs on the JARVIS host after a push to main, called by .git/hooks/post-receive.
# Builds, runs the acceptance suite, and only then restarts the service and
# forwards the commit to GitHub. A failure rolls the checkout back, so what is
# running is always something that passed.
set -uo pipefail

# Where the checkout is. Overridable so this is not one machine's path: the
# post-receive hook that calls it knows where it lives.
REPO=${JARVIS_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}
SERVICE=jarvis-brain
ZEROES=0000000000000000000000000000000000000000

cd "$REPO" || exit 1

old=""
new=""
while read -r from to ref; do
  [ "$ref" = "refs/heads/main" ] || continue
  old=$from
  new=$to
done

if [ -z "$new" ]; then
  echo "deploy: no update to main, nothing to do"
  exit 0
fi

step() {
  echo
  echo "--> $*"
}

fail() {
  echo
  echo "!!! deploy FAILED at: $1"
  if [ -n "$old" ] && [ "$old" != "$ZEROES" ]; then
    echo "!!! rolling the checkout back to ${old:0:7}"
    git reset --hard --quiet "$old" || echo "!!! rollback failed, the checkout needs a look"
    npm run build >/dev/null 2>&1 || echo "!!! rebuild after rollback failed"
  fi
  echo "!!! $SERVICE was not restarted and nothing was pushed to GitHub"
  exit 1
}

if [ "$old" = "$ZEROES" ] || ! git diff --quiet "$old" "$new" -- package-lock.json; then
  step "installing dependencies"
  npm ci || fail "npm ci"
fi

step "building and running the acceptance suite"
npm test || fail "npm test"

step "type-checking the tests"
npm run test:types || fail "npm run test:types"

step "restarting $SERVICE"
sudo -n systemctl restart "$SERVICE" || fail "systemctl restart"

step "pushing to GitHub"
if ! git push --quiet origin main; then
  echo "!!! push to GitHub failed; $SERVICE is running ${new:0:7} all the same"
  exit 1
fi

echo
echo "deployed ${new:0:7}: suite green, $SERVICE restarted, origin/main updated"
