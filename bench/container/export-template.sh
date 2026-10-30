#!/usr/bin/env bash
# Copies a scenario's template directory into <dest> as a fresh git repo with a single
# commit, without data, node_modules or anything else generated. This is the repo each
# agent starts from.
#
# Usage: bench/container/export-template.sh <template dir> <dest>
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TEMPLATE="$(cd "${1:?usage: export-template.sh <template dir> <dest>}" && pwd)"
DEST="${2:?usage: export-template.sh <template dir> <dest>}"
REL="${TEMPLATE#"$ROOT"/}"

rm -rf "$DEST"
mkdir -p "$DEST"
# Only files tracked in the harness repo, so ignored and generated files never leak in.
git -C "$ROOT" ls-files -z "$REL" | while IFS= read -r -d '' f; do
  mkdir -p "$DEST/$(dirname "${f#"$REL"/}")"
  cp "$ROOT/$f" "$DEST/${f#"$REL"/}"
done
chmod +x "$DEST"/scripts/*.sh

git -C "$DEST" init -q -b main
git -C "$DEST" add -A
git -C "$DEST" -c user.name=bench -c user.email=bench@localhost commit -q -m "Initial commit"
echo "Exported template to $DEST"
