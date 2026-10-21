# listener (experimental)

Finds where you are in a film by listening, for when the film plays on a TV instead of in IINA.
Uses a ShazamKit custom catalog built from the film's own file; matching runs on the Mac and no
audio is stored or sent anywhere. Requires macOS 14 or later and Xcode command-line tools.

```bash
helpers/listener/build.sh
```

Build the catalog for the audio track that will play. The track number is the one IINA shows
(1 = the first audio track); the default is 1. It takes about 90 s for a 2.5-hour film and is
cached in `~/Library/Caches/watch-companion/catalogs/` (or `$WATCH_COMPANION_CACHE/catalogs/`)
per file, track and language. It needs `ffmpeg` and `ffprobe`.

```bash
helpers/listener/catalog.sh /path/to/film.mp4 2
```

It prints `{"catalog": "<path>", "track": 2, "lang": "hin", "cached": false}`. Then listen:

```bash
helpers/listener/build/listener <catalog path> 30
```

It prints one JSON line per match, e.g. `{"offset": 1649.1, "matchOffset": 1646.0, …}`, where
`offset` is the predicted current position in seconds. `--signature clip.shazamsignature`
matches a file instead of the microphone, for testing.

### Why one catalog per audio track

Given a file with several audio tracks, `/usr/bin/shazam signature` signs them mixed together,
but a TV plays only one. In a test file with two different 3-minute tracks, 8 ten-second clips
per track, clean and with simulated speaker, room echo and noise:

| Catalog | Clips from the same track, clean | Same track, degraded | Clips from the other track |
|---|---|---|---|
| Whole file (tracks mixed) | 6/8 and 5/8 | 6/8 and 3/8 | (both tracks are in it) |
| One track (`catalog.sh`) | 8/8 and 8/8 | 7/8 and 5/8 | 0/8 |

So build the catalog from the track that plays, for example the Hindi dub rather than the
original. A catalog from the wrong language finds nothing instead of a wrong position.

Not wired into the plugin yet. See the "Watching on a TV" section of
[docs/DESIGN.md](../../docs/DESIGN.md).
