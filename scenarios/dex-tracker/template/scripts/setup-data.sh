#!/usr/bin/env bash
# Downloads pinned snapshots of PokeAPI's data and sprites, builds data/dex.sqlite from
# them (scripts/build-db.mjs) and keeps the sprites and artwork under data/media for
# api/server.mjs. Safe to re-run; does nothing if data/ is complete.
set -euo pipefail

API_DATA_COMMIT=447bd5c378bf87da964bfe4dd7487a7bf1d97cbd
SPRITES_COMMIT=97a7832d307311c0e1c6ea9035308bf80cc94f81

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CACHE="$ROOT/.data-cache"
DATA="$ROOT/data"

fetch() { # <repo> <commit> <sparse-checkout patterns...>
  local dir="$CACHE/$1" repo="$1" commit="$2"
  shift 2
  if [ -f "$dir/.done" ]; then return; fi
  rm -rf "$dir" && mkdir -p "$dir"
  git -C "$dir" init -q
  git -C "$dir" remote add origin "https://github.com/PokeAPI/$repo.git"
  git -C "$dir" fetch -q --depth 1 --filter=blob:none origin "$commit"
  git -C "$dir" sparse-checkout set --no-cone "$@"
  git -C "$dir" checkout -q FETCH_HEAD
  touch "$dir/.done"
}

if [ -f "$DATA/.done" ]; then echo "Data already present in $DATA"; exit 0; fi

echo "Fetching PokeAPI snapshots..."
fetch api-data "$API_DATA_COMMIT" \
  /data/api/v2/pokemon-species/ /data/api/v2/pokemon/ /data/api/v2/evolution-chain/ /data/api/v2/version/ \
  /data/api/v2/version-group/ /data/api/v2/pokedex/ /data/api/v2/type/ /data/api/v2/item/
fetch sprites "$SPRITES_COMMIT" '/sprites/pokemon/*.png' '/sprites/pokemon/other/official-artwork/*.png'

rm -rf "$DATA" && mkdir -p "$DATA/media"
mv "$CACHE/sprites/sprites" "$DATA/media/sprites"
node "$ROOT/scripts/build-db.mjs" "$CACHE/api-data/data/api/v2" "$DATA/media" "$DATA/dex.sqlite"
touch "$DATA/.done"

rm -rf "$CACHE"
echo "Data ready in $DATA"
