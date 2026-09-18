#!/usr/bin/env bash
# Fetches the owner's notes from wherever they are kept into the directory the nightly
# ingest reads. Run by jarvis-corpus.service before the ingest itself.
#
# The notes live on the machine where the owner works with a coding agent; this
# host only ever reads them. The key in ~/.ssh/corpus is pinned on the other side
# to a single forced command -- tar of that one directory -- so a break-in here
# yields those notes and nothing else. A tarball rather than rsync: half a
# megabyte a night is not worth a dependency on the far side having it.
#
# CORPUS_SOURCE decides the route. If the direct one between the two machines
# does not carry SSH, name whatever address does; a name that only resolves on
# the far side's own network will not resolve here.
set -euo pipefail

SOURCE=${CORPUS_SOURCE:?set CORPUS_SOURCE to user@host:path}
PORT=${CORPUS_PORT:-22}
KEY=${CORPUS_KEY:-$HOME/.ssh/corpus}
# Where the checkout happens to sit, not where it once sat. The unit runs this
# with no argument, and the data directory the ingest reads is the only one the
# unit grants write access to, so a hard-coded home-relative path is read-only
# from in here and the pass dies before it has fetched anything.
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
DEST=${1:-$root/data/corpus}

staging=$(mktemp -d "${TMPDIR:-/tmp}/corpus.XXXXXX")
trap 'rm -rf "$staging"' EXIT

ssh -i "$KEY" -p "$PORT" \
  -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=yes \
  "$SOURCE" true | tar -xzf - -C "$staging"

# A corpus with nothing in it means the far side broke, not that somebody deleted
# every note. Ingesting it would retire every fact the notes ever produced. The
# floor is a count rather than a fraction because there is nothing to compare
# against on a first run; set CORPUS_MIN_NOTES to whatever a thin corpus is here.
MIN=${CORPUS_MIN_NOTES:-10}
count=$(find "$staging" -name '*.md' | wc -l)
if [ "$count" -lt "$MIN" ]; then
  echo "pull-corpus: only $count notes came across, fewer than $MIN; refusing to replace the copy" >&2
  exit 1
fi

# Swap whole, so a transfer that dies halfway is never what gets read.
mkdir -p "$(dirname "$DEST")"
rm -rf "$DEST.new"
mv "$staging" "$DEST.new"
rm -rf "$DEST.old"
if [ -d "$DEST" ]; then mv "$DEST" "$DEST.old"; fi
mv "$DEST.new" "$DEST"
rm -rf "$DEST.old"

echo "pull-corpus: $count notes in $DEST"
