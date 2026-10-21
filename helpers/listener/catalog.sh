#!/bin/sh
# Builds the ShazamKit catalog for one audio track of a film, cached per file and track.
#
#   catalog.sh <film> [audio-track]
#
# audio-track is the number IINA and mpv use (aid): 1 = the first audio track. Default 1.
# Prints one JSON line: {"catalog": "<path>", "track": N, "lang": "...", "cached": true|false}.
#
# Why per track: given a file with several audio tracks, /usr/bin/shazam signs them mixed
# together, but a TV plays only one. A catalog from the one track that plays matches more clips,
# and a catalog from another language matches none (helpers/listener/README.md).
set -eu

film=${1:?usage: catalog.sh <film> [audio-track]}
aid=${2:-1}
case $aid in *[!0-9]* | '' | 0) echo "audio-track must be 1 or more" >&2; exit 2 ;; esac
[ -f "$film" ] || { echo "no such file: $film" >&2; exit 2; }

n=$(ffprobe -v error -select_streams a -show_entries stream=index -of csv=p=0 "$film" | wc -l | tr -d ' ')
[ "$aid" -le "$n" ] || { echo "the file has $n audio track(s), not $aid" >&2; exit 2; }
lang=$(ffprobe -v error -select_streams "a:$((aid - 1))" -show_entries stream_tags=language -of default=nw=1:nk=1 "$film" | head -1)
lang=$(printf '%s' "${lang:-und}" | tr -c 'A-Za-z0-9' '_')

dir=${WATCH_COMPANION_CACHE:-$HOME/Library/Caches/watch-companion}/catalogs
base=$(basename "$film" | tr -d '\n' | tr -c 'A-Za-z0-9._-' '_' | cut -c1-80)
key=$(stat -f '%z-%m' "$film")
out="$dir/$base-$key-a$aid-$lang.shazamcatalog"

if [ -f "$out" ]; then
  printf '{"catalog": "%s", "track": %s, "lang": "%s", "cached": true}\n' "$out" "$aid" "$lang"
  exit 0
fi

mkdir -p "$dir"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
# Only this track, as mono: the room hears one mix of the speakers anyway.
ffmpeg -v error -i "$film" -map "0:a:$((aid - 1))" -vn -ac 1 -c:a aac -b:a 96k "$tmp/audio.m4a"
/usr/bin/shazam signature --input "$tmp/audio.m4a" --output "$tmp/audio.shazamsignature" >/dev/null
printf 'title\n%s (audio %s %s)\n' "$(basename "$film" | tr -d ',"')" "$aid" "$lang" > "$tmp/items.csv"
/usr/bin/shazam custom-catalog create --signature-asset "$tmp/audio.shazamsignature" \
  --media-items "$tmp/items.csv" --output "$tmp/catalog.shazamcatalog" >/dev/null
mv "$tmp/catalog.shazamcatalog" "$out"
printf '{"catalog": "%s", "track": %s, "lang": "%s", "cached": false}\n' "$out" "$aid" "$lang"
