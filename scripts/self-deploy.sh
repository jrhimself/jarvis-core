#!/usr/bin/env bash
# Runs as root, started by jarvis-self-deploy.path when the brain writes a
# request into data/deploy-request.
#
# The brain's own unit has NoNewPrivileges=yes and cannot restart anything. That
# is deliberate: a process that rewrites its own source should not also hold a
# path to root. So the vocabulary across this boundary is a handful of fixed
# lines, each checked here rather than taken on trust:
#
#   <40-hex sha>            run a commit that is already on origin/main
#   try core <n>            put open pull request <n> of this repository live on
#                           top of what runs now, to be tried before it is merged
#   try pack <id> <n>       the same for pull request <n> of the pack in packs/<id>
#   untry                   take the trial off again
#
# A trial is the one way unmerged code runs, and it is narrow: the pull request
# is fetched here, from origin, by number -- the brain names a number, never a
# commit or a path -- merged onto the running commit, and put through the suite
# and the types like any deploy. Only one runs at a time, and data/trial.json
# says which, so it can be taken off again. Asking for one needs the owner's
# yes; that is enforced by the tool that writes the request.
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
TRIAL=$DATA/trial.json
SERVICE=jarvis-brain
AS_SERVICE=(runuser -u "$USER" --)
# A trial's merge commit is made on this machine and never pushed; it needs a
# name, and it should not be anybody's.
MERGE_AS=(-c user.name="JARVIS trial" -c user.email="trial@jarvis.invalid")

finish() {
  local ok=$1 step=$2 detail=$3
  printf '{"sha":"%s","ok":%s,"step":"%s","at":"%s","detail":"%s"}\n' \
    "${SHA:-}" "$ok" "$step" "$(date -Is)" "${detail//\"/\'}" > "$RESULT"
  chown "$USER:$USER" "$RESULT" 2>/dev/null
  [ "$ok" = "true" ] || echo "self-deploy failed at $step: $detail" >&2
  exit $([ "$ok" = "true" ] && echo 0 || echo 1)
}

git_as() { "${AS_SERVICE[@]}" git "$@"; }

write_trial() {
  local kind=$1 pack=$2 pr=$3 base=$4 sha=$5
  printf '{"kind":"%s","pack":"%s","pr":%s,"base":"%s","sha":"%s","at":"%s"}\n' \
    "$kind" "$pack" "$pr" "$base" "$sha" "$(date -Is)" > "$TRIAL"
  chown "$USER:$USER" "$TRIAL" 2>/dev/null
}

trial_field() {
  sed -n "s/.*\"$1\":\"\{0,1\}\([^\",}]*\)\"\{0,1\}[,}].*/\1/p" "$TRIAL" 2>/dev/null
}

# Puts the core checkout on a commit, installs when the lockfile moved, and builds.
core_to() {
  local from=$1 to=$2
  git_as -C "$REPO" reset --hard --quiet "$to" || return 1
  if ! git_as -C "$REPO" diff --quiet "$from" "$to" -- package-lock.json; then
    "${AS_SERVICE[@]}" npm --prefix "$REPO" ci >/dev/null 2>&1 || return 1
  fi
  "${AS_SERVICE[@]}" npm --prefix "$REPO" run build >/dev/null 2>&1
}

# Puts one pack on a commit and builds it.
pack_to() {
  local dir=$1 to=$2 id
  id=$(basename "$dir")
  git_as -C "$dir" reset --hard --quiet "$to" || return 1
  (cd "$REPO" && "${AS_SERVICE[@]}" npx tsc --build "packs/$id") >/dev/null 2>&1
}

suite() {
  local out
  if ! out=$("${AS_SERVICE[@]}" npm --prefix "$REPO" test 2>&1); then
    echo "tests: $(echo "$out" | tail -n 3 | tr '\n' ' ')"
    return 1
  fi
  if ! out=$("${AS_SERVICE[@]}" npm --prefix "$REPO" run test:types 2>&1); then
    echo "types: $(echo "$out" | tail -n 3 | tr '\n' ' ')"
    return 1
  fi
}

[ -f "$REQUEST" ] || exit 0
LINE=$(tr -s '[:space:]' ' ' < "$REQUEST" | sed 's/^ //; s/ $//')
rm -f "$REQUEST"
cd "$REPO" || finish false repo "no checkout at $REPO"

# ---------------------------------------------------------------- trials
if [[ "$LINE" =~ ^try\ core\ ([0-9]{1,6})$ || "$LINE" =~ ^try\ pack\ ([a-z0-9][a-z0-9-]{0,39})\ ([0-9]{1,6})$ ]]; then
  [ -f "$TRIAL" ] && finish false busy "another pull request is on trial; take it off first"
  if [[ "$LINE" =~ ^try\ core ]]; then
    KIND=core PACK="" PR=${BASH_REMATCH[1]} DIR=$REPO
  else
    KIND=pack PACK=${BASH_REMATCH[1]} PR=${BASH_REMATCH[2]} DIR=$REPO/packs/$PACK
    [ -d "$DIR/.git" ] || finish false pack "no pack checkout named $PACK"
  fi
  BASE=$(git_as -C "$DIR" rev-parse HEAD)
  git_as -C "$DIR" fetch --quiet origin "pull/$PR/head" \
    || finish false fetch "could not fetch pull request $PR"
  if ! git_as "${MERGE_AS[@]}" -C "$DIR" merge --quiet --no-edit --no-ff \
      -m "trial: pull request $PR" FETCH_HEAD >/dev/null 2>&1; then
    git_as -C "$DIR" merge --abort >/dev/null 2>&1
    git_as -C "$DIR" reset --hard --quiet "$BASE"
    finish false conflict "pull request $PR does not merge onto what runs now"
  fi
  SHA=$(git_as -C "$DIR" rev-parse HEAD)

  if [ "$KIND" = core ]; then
    built=true
    if ! git_as -C "$REPO" diff --quiet "$BASE" "$SHA" -- package-lock.json; then
      "${AS_SERVICE[@]}" npm --prefix "$REPO" ci >/dev/null 2>&1 || built=false
    fi
    if [ "$built" = false ]; then
      core_to "$SHA" "$BASE"
      finish false install "npm ci failed"
    fi
  else
    (cd "$REPO" && "${AS_SERVICE[@]}" npx tsc --build "packs/$PACK") >/dev/null 2>&1 || {
      pack_to "$DIR" "$BASE"
      finish false build "pack $PACK does not build"
    }
  fi

  if ! why=$(suite); then
    if [ "$KIND" = core ]; then core_to "$SHA" "$BASE"; else pack_to "$DIR" "$BASE"; fi
    finish false tests "$why"
  fi
  write_trial "$KIND" "$PACK" "$PR" "$BASE" "$SHA"
  if ! systemctl restart "$SERVICE"; then
    if [ "$KIND" = core ]; then core_to "$SHA" "$BASE"; else pack_to "$DIR" "$BASE"; fi
    rm -f "$TRIAL"
    systemctl restart "$SERVICE"
    finish false restart "the service would not restart with pull request $PR"
  fi
  finish true trying "pull request $PR is live on trial"
fi

if [ "$LINE" = untry ]; then
  [ -f "$TRIAL" ] || finish false untry "nothing is on trial"
  KIND=$(trial_field kind) PACK=$(trial_field pack) BASE=$(trial_field base) SHA=$(trial_field sha)
  [[ "$BASE" =~ ^[0-9a-f]{40}$ ]] || finish false untry "the trial file has no base to go back to"
  if [ "$KIND" = core ]; then
    core_to "$(git_as -C "$REPO" rev-parse HEAD)" "$BASE" || finish false untry "could not go back to $BASE"
  else
    [[ "$PACK" =~ ^[a-z0-9][a-z0-9-]{0,39}$ ]] || finish false untry "the trial file names no pack"
    pack_to "$REPO/packs/$PACK" "$BASE" || finish false untry "could not put pack $PACK back"
  fi
  rm -f "$TRIAL"
  SHA=$BASE
  systemctl restart "$SERVICE" || finish false restart "the service would not restart"
  finish true untried "back on ${BASE:0:7}"
fi

# ---------------------------------------------------------------- merged code
SHA=$LINE
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || finish false request "not a request this accepts"

git_as -C "$REPO" fetch --quiet origin main \
  || finish false fetch "could not reach origin"

# The one rule that makes this boundary worth having: only what is already on
# main may run this way. A branch that was never reviewed cannot be deployed by
# writing its hash into the request file; the only door for that is a trial.
git_as -C "$REPO" merge-base --is-ancestor "$SHA" origin/main \
  || finish false ancestry "$SHA is not on origin/main"

ROLLBACK=$(git_as -C "$REPO" rev-parse HEAD)

roll_back() {
  core_to "$SHA" "$ROLLBACK"
}

git_as -C "$REPO" reset --hard --quiet "$SHA" \
  || finish false checkout "could not check out $SHA"

if ! git_as -C "$REPO" diff --quiet "$ROLLBACK" "$SHA" -- package-lock.json; then
  if ! "${AS_SERVICE[@]}" npm --prefix "$REPO" ci >/dev/null 2>&1; then
    roll_back
    finish false install "npm ci failed"
  fi
fi

if ! why=$(suite); then
  roll_back
  finish false "${why%%:*}" "${why#*: }"
fi

if ! systemctl restart "$SERVICE"; then
  roll_back
  systemctl restart "$SERVICE"
  finish false restart "the service would not restart on the new code"
fi

# A core trial ran on the commit this replaced, so it is over now; a pack trial
# lives in its pack and carries on.
[ -f "$TRIAL" ] && [ "$(trial_field kind)" = core ] && rm -f "$TRIAL"

finish true restarted "running ${SHA:0:7}"
