# listener (experimental)

Finds where you are in a film by listening, for when the film plays on a TV instead of in IINA.
Uses a ShazamKit custom catalog built from the film's own file; matching runs on the Mac and no
audio is stored or sent anywhere. Requires macOS 14 or later and Xcode command-line tools.

```bash
helpers/listener/build.sh
```

```bash
shazam signature --input /path/to/film.mp4 --output film.shazamsignature
```

```bash
printf 'title\nMy Film\n' > items.csv
```

```bash
shazam custom-catalog create --signature-asset film.shazamsignature --media-items items.csv --output film.shazamcatalog
```

```bash
helpers/listener/build/listener film.shazamcatalog 30
```

It prints one JSON line per match, e.g. `{"offset": 1649.1, "matchOffset": 1646.0, …}`, where
`offset` is the predicted current position in seconds. `--signature clip.shazamsignature`
matches a file instead of the microphone, for testing.

Not wired into the plugin yet. See the "Watching on a TV" section of
[docs/DESIGN.md](../../docs/DESIGN.md).
