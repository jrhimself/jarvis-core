#!/usr/bin/env bash
#
# Fails when a tracked file carries something that belongs to one household
# rather than to the project: a private address, a tailnet name, a home
# directory, a mailbox, or a credential shape.
#
# It also fails when anything under the private paths is tracked at all --
# `config/`, `data/`, `packs/`, the denylist and the env file: the five things a
# deployment owns and this repository does not carry. Those are
# ignored, but an ignore rule is not consulted for a file git already knows
# about, so a single `git add -f` or a `git mv` into one of them would publish
# it quietly. `data/` is the one that would hurt most and look most innocent: it
# holds the memory database, and a published copy of that is a published copy of
# everything the assistant was ever told. The count is checked, never the
# contents.
#
# Two lists. The structural one below is safe to read in public -- it describes
# shapes, not people. The names of a household are not: they would be published
# by the very file meant to keep them out. Those live outside the repository, in
# `.denylist.local` (ignored by git) for a local run, and in the `DENYLIST_EXTRA`
# repository secret for CI. One extended regular expression per line, blank
# lines and `#` comments skipped.
#
# Nothing that matches is ever printed. A hit reports the file, the line number
# and which rule caught it, so a failing run in a public log still says nothing
# about the house.
#
# A pack is a repository of its own, and the one most likely to be given away.
# This check looks no further into `packs/` than asserting it is untracked,
# which leaves a pack guarded on neither side: no denylist of its own, and
# usually no CI. `--path` aims the same scan at such a checkout. The words never
# travel with it -- they are read from beside this script, whatever tree is being
# scanned.
#
# Three things are scanned, because a file's contents are only one of the ways
# a household reaches a public repository:
#
#   the contents of tracked files, which is the obvious one;
#   the target of every tracked symlink, which `git grep` does not read at all --
#     that is how a link named `packs` pointing at one person's home directory
#     was committed twice, seen by the tracked-private count and by nothing else;
#   and commit messages, which are published with the history and which no
#     amount of care inside the tree can clean up afterwards.
#
# Usage: scripts/check-no-house-facts.sh [--verbose] [--path <checkout>] [--since <rev>]
#   --verbose  also print the matching text; for local use only.
#   --path     scan that checkout rather than this one.
#   --since    scan the commit messages after <rev>. Default: the current
#              branch's upstream, so what is checked is the work being added.
#              `--since ""` scans every reachable message.

set -uo pipefail

usage() {
  echo "usage: check-no-house-facts.sh [--verbose] [--path <checkout>] [--since <rev>]" >&2
  exit 2
}

verbose=0
target=""
since=""
since_set=0
while [ $# -gt 0 ]; do
  case $1 in
    --verbose) verbose=1 ;;
    --path) shift; [ $# -gt 0 ] || usage; target=$1 ;;
    --path=*) target=${1#--path=} ;;
    --since) shift; [ $# -gt 0 ] || usage; since=$1; since_set=1 ;;
    --since=*) since=${1#--since=}; since_set=1 ;;
    *) usage ;;
  esac
  shift
done

# A household's own words belong to the deployment that has them and not to the
# checkout being scanned, so this is resolved before anything changes directory.
readonly DENYLIST="$(cd "$(dirname "$0")/.." && pwd)/.denylist.local"

if [ -n "$target" ]; then
  # Neither refusal repeats the path: an argument pointing into somebody's
  # checkout is itself a home directory, and this may be running where logs are
  # kept.
  cd "$target" 2>/dev/null || { echo "no-house-facts: no such directory" >&2; exit 2; }
  toplevel=$(git rev-parse --show-toplevel 2>/dev/null) ||
    { echo "no-house-facts: not a git checkout" >&2; exit 2; }
  # Hits are reported relative to the root, so the scan starts there rather than
  # wherever inside the checkout the argument happened to point.
  cd "$toplevel" || exit 1
  # A clean result says nothing unless it says what was looked at. The directory
  # name is as much as can be printed; the path it sits in cannot be.
  echo "no-house-facts: scanning $(basename "$PWD")"
else
  cd "$(dirname "$0")/.." || exit 1
fi

# Files that exist to describe the patterns cannot be scanned for them.
readonly SELF_EXCLUDES=(
  ":(exclude)scripts/check-no-house-facts.sh"
  ":(exclude).github/workflows/no-house-facts.yml"
  # package-lock.json is no longer excluded: the rule that forced it out -- a
  # dependency version reading as a 10/8 address -- was the bug fixed above, and
  # the lockfile is a leak vector of its own (a resolved `file:` path names a
  # machine).
)

# rule|regex. The rule name is what a failure prints.
readonly STRUCTURAL=(
  # Each branch carries its own octets. Sharing one tail was wrong for 10/8,
  # which needs three after it and was given two: `10.5.0` read as an address,
  # and a version number is the commonest string in a changelog there is.
  'private-ipv4|(^|[^0-9.])(192\.168\.[0-9]{1,3}\.[0-9]{1,3}|172\.(1[6-9]|2[0-9]|3[01])\.[0-9]{1,3}\.[0-9]{1,3}|10(\.[0-9]{1,3}){3})([^0-9.]|$)'
  'tailnet-ipv4|(^|[^0-9.])100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.[0-9]{1,3}\.[0-9]{1,3}([^0-9.]|$)'
  'tailnet-host|[A-Za-z0-9-]+\.ts\.net'
  'dynamic-dns|duckdns'
  # A *user's* home directory, which means an absolute path. The leading guard
  # is what keeps a relative import of this repo's own `brain/src/home/`
  # directory from reading as one.
  'home-directory|(^|[^-A-Za-z0-9_.])/home/[a-z][a-z0-9_-]*'
  'jwt|eyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}'
  'api-key|(sk_[A-Za-z0-9]{24,}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|GOCSPX-[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{30,})'
  'private-key|-----BEGIN [A-Z ]*PRIVATE KEY-----'
)

# Mailboxes are flagged unless the domain is one RFC 2606 reserves for writing
# examples with, or the address is the `git@` of an ssh clone url -- that names a
# forge rather than a person, and every pack's README carries one in its install
# instructions. Both exclusions need their guard to mean anything: without the
# leading one the match starts a character later and `it@github.com` reads as an
# address, and a reserved name is only reserved as the last label, so
# `someone@runner.invalid` is an example and `mail@testbed.nl` is not.
#
# A no-reply address is excluded on the same ground as `git@`: it is a service
# saying it has no mailbox, and it cannot be written to. Every commit here
# carries one in a Co-authored-by trailer, and a rule that fires on every commit
# is a rule nobody reads. The forge's own `users.noreply.github.com` is excluded
# by domain because the account name sits in the local part, where the
# no-reply guard cannot see it.
readonly RESERVED_DOMAIN='(?:[A-Za-z0-9-]+\.)*(?:invalid|localhost|test|example|example\.(?:com|org|net))(?![A-Za-z0-9.-])'
readonly NOREPLY_DOMAIN='users\.noreply\.github\.com(?![A-Za-z0-9.-])'
readonly MAILBOX="(?<![A-Za-z0-9._%+-])(?!(?:git|noreply|no-reply)@)[A-Za-z0-9._%+-]+@(?!$RESERVED_DOMAIN)(?!$NOREPLY_DOMAIN)[A-Za-z0-9.-]+\.[A-Za-z]{2,}"

# The household's own words, kept out of the repository on purpose. Loaded
# before anything is scanned: the file scan, the symlink scan and the message
# scan all ask the same question and must not drift into asking three.
extra_source=""
extra_lines=""
if [ -n "${DENYLIST_EXTRA:-}" ]; then
  extra_source="DENYLIST_EXTRA"
  extra_lines=$DENYLIST_EXTRA
elif [ -f "$DENYLIST" ]; then
  extra_source=".denylist.local"
  extra_lines=$(cat "$DENYLIST")
fi

# rule|regex, same shape as STRUCTURAL, so the two can be scanned as one list.
EXTRA=()
extra_count=0
if [ -n "$extra_lines" ]; then
  while IFS= read -r pattern; do
    case $pattern in "" | \#*) continue ;; esac
    extra_count=$((extra_count + 1))
    EXTRA+=("private-$extra_count|$pattern")
  done <<< "$extra_lines"
fi
readonly EXTRA

hits=0

# The private half must not be *tracked*, whatever .gitignore says. `git mv` into
# an ignored directory keeps the file in the index, and a tracked file there is
# published: the ignore rule stops being consulted the moment git already knows
# about it. This is a count of paths, never their contents.
readonly PRIVATE_PATHS=(config data packs .denylist.local .env)

check_private_paths() {
  local tracked
  for path in "${PRIVATE_PATHS[@]}"; do
    tracked=$(git ls-files -- "$path" | wc -l | tr -d ' ')
    if [ "$tracked" != "0" ]; then
      printf '  tracked-private: %s has %s tracked file(s) and must have none\n' "$path" "$tracked"
      hits=$((hits + tracked))
    fi
  done
}

check_private_paths

# A symlink is a tracked file whose contents `git grep` never reads: it walks
# blobs as text and a link is not text to it. So the rules above look straight
# past one, and a link is the shortest way to write an absolute path into a
# repository -- `packs -> /home/somebody/jarvis-core/packs` names the account,
# the layout and the machine in twenty-eight bytes, and it was committed twice
# before anything noticed. An absolute target is a hit whatever it says: it
# cannot be right for anybody but the machine it was made on, so it breaks every
# other checkout as well as naming this one. A relative target is scanned like
# any other line. The target itself is never printed.
check_symlinks() {
  local mode sha path target rule regex entry
  while read -r mode sha _stage path; do
    [ "$mode" = "120000" ] || continue
    target=$(git cat-file blob "$sha" 2>/dev/null) || continue
    case $target in
      /*)
        printf '  symlink-absolute: %s points outside any checkout and names the machine it was made on\n' "$path"
        hits=$((hits + 1))
        continue
        ;;
    esac
    for entry in "${STRUCTURAL[@]}" ${EXTRA[@]+"${EXTRA[@]}"}; do
      rule=${entry%%|*}
      regex=${entry#*|}
      if printf '%s' "$target" | grep -qE -e "$regex"; then
        printf '  symlink-%s: %s\n' "$rule" "$path"
        hits=$((hits + 1))
      fi
    done
  done < <(git ls-files -s)
}

check_symlinks

# npm is the one tool that writes the contents of `packs/` into a tracked file on
# its own: as a workspace glob in `package.json`, and as a resolved path and a
# package name in `package-lock.json`. That is how this repository came to name
# three private packs of one deployment. A glob is fine -- it names nobody -- but
# a *named* directory under `packs/` in either file is someone's own pack: this
# repository carries none of them. The lockfile needs a rule of its own
# because the structural rules cannot tell a named directory from a path: they
# look for household words, and a pack name is only wrong here because of where
# it sits. Only a count is printed.
readonly NPM_MANIFESTS=(package.json package-lock.json)

check_npm_manifests() {
  local found
  local named="packs/[A-Za-z0-9._-]"
  for file in "${NPM_MANIFESTS[@]}"; do
    found=$(git grep -cIP -e "$named" -- "$file" 2>/dev/null | cut -d: -f2)
    [ -n "$found" ] || continue
    printf '  npm-manifest: %s names %s pack(s) under packs/; a pack is not a workspace\n' \
      "$file" "$found"
    hits=$((hits + found))
  done
}

check_npm_manifests

# A line may say, in a trailing comment, that it has to be what it is. The
# migration that renames a value away from a household's word has to contain
# that word; so does a test that proves the rename happened. Allowed lines are
# counted and the total is printed, so they cannot quietly accumulate.
readonly ALLOW_MARKER='no-house-facts: allow'
allowed=0

report() {
  local rule=$1
  shift
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    case "$line" in
      *"$ALLOW_MARKER"*)
        allowed=$((allowed + 1))
        continue
        ;;
    esac
    if [ "$verbose" = 1 ]; then
      printf '  %s: %s\n' "$rule" "$line"
    else
      printf '  %s: %s\n' "$rule" "${line%%:*}:$(printf '%s' "$line" | cut -d: -f2)"
    fi
    hits=$((hits + 1))
  done
}

scan_ere() {
  local rule=$1 regex=$2
  report "$rule" < <(git grep -nIE -e "$regex" -- . "${SELF_EXCLUDES[@]}" 2>/dev/null)
}

scan_pcre() {
  local rule=$1 regex=$2
  report "$rule" < <(git grep -nIP -e "$regex" -- . "${SELF_EXCLUDES[@]}" 2>/dev/null)
}

for entry in "${STRUCTURAL[@]}" ${EXTRA[@]+"${EXTRA[@]}"}; do
  scan_ere "${entry%%|*}" "${entry#*|}"
done

scan_pcre mailbox "$MAILBOX"

# Commit messages are published with the history and cannot be corrected once
# they are: rewriting one rewrites every sha below it. A tree can be cleaned the
# day before publication; a message cannot, so it has to be caught when it is
# written. One already got through here -- a household name in the subject of a
# merged pull request -- which is why the default range is the work being added
# rather than the whole history. The history is dealt with once, by the commit
# that publication is made from; every message after that is this check's job.
#
# The range: `--since <rev>` wins, then the branch's upstream, and with neither
# nothing is scanned and the run says so rather than reporting a clean history
# it never looked at. `--since ""` asks for everything reachable.
check_messages() {
  local range description count sha rule regex entry message upstream
  if [ "$since_set" = 1 ]; then
    if [ -z "$since" ]; then
      range="--all"
      description="every reachable commit"
    else
      range="$since..HEAD"
      description="$since..HEAD"
    fi
  elif upstream=$(git rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' 2>/dev/null); then
    range="$upstream..HEAD"
    description="$upstream..HEAD"
  else
    echo "no-house-facts: WARNING -- no upstream and no --since; commit messages were not scanned."
    return
  fi

  count=$(git rev-list --count $range 2>/dev/null) || {
    echo "no-house-facts: WARNING -- $description is not a range; commit messages were not scanned."
    return
  }
  echo "no-house-facts: $count commit message(s) scanned ($description)"
  [ "$count" != "0" ] || return

  for sha in $(git rev-list $range); do
    message=$(git log -1 --format='%B' "$sha")
    case "$message" in *"$ALLOW_MARKER"*) allowed=$((allowed + 1)); continue ;; esac
    for entry in "${STRUCTURAL[@]}" ${EXTRA[@]+"${EXTRA[@]}"}; do
      rule=${entry%%|*}
      regex=${entry#*|}
      if printf '%s' "$message" | grep -qE -e "$regex"; then
        if [ "$verbose" = 1 ]; then
          printf '  message-%s: %s %s\n' "$rule" "${sha:0:12}" "$(git log -1 --format='%s' "$sha")"
        else
          printf '  message-%s: %s\n' "$rule" "${sha:0:12}"
        fi
        hits=$((hits + 1))
      fi
    done
    if printf '%s' "$message" | grep -qP -e "$MAILBOX"; then
      printf '  message-mailbox: %s\n' "${sha:0:12}"
      hits=$((hits + 1))
    fi
  done
}

check_messages

if [ -z "$extra_source" ]; then
  echo "no-house-facts: WARNING -- no private pattern list found."
  echo "  Set DENYLIST_EXTRA or write .denylist.local; the structural rules alone"
  echo "  do not catch a name."
else
  echo "no-house-facts: $extra_count private pattern(s) from $extra_source"
fi

if [ "$allowed" -gt 0 ]; then
  echo "no-house-facts: $allowed line(s) marked '$ALLOW_MARKER'"
fi

if [ "$hits" -gt 0 ]; then
  echo
  echo "no-house-facts: FAILED -- $hits line(s) carry something that is not the project's."
  exit 1
fi

echo "no-house-facts: clean"
