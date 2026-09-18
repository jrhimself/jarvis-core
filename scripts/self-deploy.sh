#!/usr/bin/env bash
# Runs as root, started by jarvis-self-deploy.path when the brain writes a commit
# hash into data/deploy-request.
#
# The brain's own unit has NoNewPrivileges=yes and cannot restart anything. That
# is deliberate: a process that rewrites its own source should not also hold a
# path to root. So the whole vocabulary across this boundary is one forty-
# character string, and the only thing it can ask for is "run the commit that is
# already on origin/main" -- which is checked here, not taken on trust.
#
# Everything git and npm touches runs as the service account; only the restart
# needs root. Both it and the checkout come from the environment, which the unit
# that starts this sets -- see deploy/README.md.
set -uo pipefail

USER=${JARVIS_USER:?set JARVIS_USER to the account the service runs as}
REPO=${JARVIS_ROOT:?set JARVIS_ROOT to the checkout the service runs from}
DATA=$REPO/data
REQUEST=$DATA/deploy-request
RESULT=$DATA/deploy-result.json
SERVICE=jarvis-brain
AS_SERVICE=(runuser -u "$USER" --)

finish() {
  local ok=$1 step=$2 detail=$3
  printf '{"sha":"%s","ok":%s,"step":"%s","at":"%s","detail":"%s"}\n' \
    "${SHA:-}" "$ok" "$step" "$(date -Is)" "${detail//\"/\'}" > "$RESULT"
  chown "$USER:$USER" "$RESULT" 2>/dev/null
  [ "$ok" = "true" ] || echo "self-deploy failed at $step: $detail" >&2
  exit $([ "$ok" = "true" ] && echo 0 || echo 1)
}

[ -f "$REQUEST" ] || exit 0
SHA=$(tr -d '[:space:]' < "$REQUEST")
rm -f "$REQUEST"

[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || finish false request "not a commit hash"

cd "$REPO" || finish false repo "no checkout at $REPO"

"${AS_SERVICE[@]}" git -C "$REPO" fetch --quiet origin main \
  || finish false fetch "could not reach origin"

# The one rule that makes this boundary worth having: only what is already on
# main may run. A branch that was never reviewed cannot be deployed by writing
# its hash into the request file.
"${AS_SERVICE[@]}" git -C "$REPO" merge-base --is-ancestor "$SHA" origin/main \
  || finish false ancestry "$SHA is not on origin/main"

ROLLBACK=$("${AS_SERVICE[@]}" git -C "$REPO" rev-parse HEAD)

roll_back() {
  "${AS_SERVICE[@]}" git -C "$REPO" reset --hard --quiet "$ROLLBACK"
  "${AS_SERVICE[@]}" npm --prefix "$REPO" run build >/dev/null 2>&1
}

"${AS_SERVICE[@]}" git -C "$REPO" reset --hard --quiet "$SHA" \
  || finish false checkout "could not check out $SHA"

if ! "${AS_SERVICE[@]}" git -C "$REPO" diff --quiet "$ROLLBACK" "$SHA" -- package-lock.json; then
  if ! "${AS_SERVICE[@]}" npm --prefix "$REPO" ci >/dev/null 2>&1; then
    roll_back
    finish false install "npm ci failed"
  fi
fi

if ! out=$("${AS_SERVICE[@]}" npm --prefix "$REPO" test 2>&1); then
  roll_back
  finish false tests "$(echo "$out" | tail -n 3 | tr '\n' ' ')"
fi

if ! out=$("${AS_SERVICE[@]}" npm --prefix "$REPO" run test:types 2>&1); then
  roll_back
  finish false types "$(echo "$out" | tail -n 3 | tr '\n' ' ')"
fi

if ! systemctl restart "$SERVICE"; then
  roll_back
  systemctl restart "$SERVICE"
  finish false restart "the service would not restart on the new code"
fi

finish true restarted "running ${SHA:0:7}"
