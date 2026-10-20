# Watch Companion

Ask questions about the film you're watching, while you watch it, without spoilers.

Watch Companion is a plugin for [IINA](https://iina.io), the macOS video player. Press ⌘K, ask
"who is this?", "what did she just say?" or "what has happened so far?", and get an answer in
the sidebar in a few seconds. Answers are built only from what you have already seen: the
subtitles up to the current position, the current frame and the cast names. Nothing from later
in the film is ever sent to the model.

```
  you ask ──► subtitles up to now ─┐
              current frame (768 px)├──► Claude ──► answer with citations [22:59]
              cast names (Wikipedia)┘                (click a time to jump back there)
```

## What it does

- **Spoiler-safe context.** One pure function builds everything the model sees, and only from
  subtitle lines that have already started. Tests check this at every position.
- **Who said what.** If the file has an SDH subtitle track (speaker names such as `SAM:`), the
  plugin uses it for context even when you watch with a plain track; without speaker names,
  models tend to give every line to the main character.
- **Citations.** Claims from the subtitles carry the time of the line, e.g. `[22:59]`; click it
  to jump back there, then "← Back". A time is linked only if a real subtitle line starts there
  and it isn't after your position. Background from the model's own knowledge is tagged
  `[background]`, and it is told never to use outside knowledge about this film's plot.
- **Cast names, not plot.** The cast comes from the Cast section of the film's Wikipedia
  article: actor and character names only; the descriptions (which carry plot) are dropped. If
  an answer names a cast member who hasn't been mentioned yet, it is hidden behind
  "Show anyway".
- **Subtitles from anywhere in the file.** A `.srt`/`.vtt` beside the video, or a text track
  inside it (read once with `ffmpeg` and cached).
- **Cost shown per answer.** Typically $0.02–0.10 with Claude Opus 5.5, depending on how far
  into the film you are (more subtitles, more tokens). About 4–6 s per answer.

## Privacy

- The video file never leaves your Mac. Sent to Anthropic: the subtitle text up to now, one
  downscaled frame (optional), the cast names and your question. Sent to Wikipedia: the film's
  title and year, to look up the cast (optional).
- Your Anthropic API key is stored in the macOS Keychain, not in files.

## Requirements

- macOS with [IINA](https://iina.io) 1.5 or later (tested with 1.5.0).
- An [Anthropic API key](https://console.anthropic.com/).
- Optional: [`ffmpeg`](https://ffmpeg.org) (`brew install ffmpeg`) to read subtitle tracks
  inside the video. Not needed for `.srt`/`.vtt` files beside it.
- Text subtitles. Image-based subtitles (PGS/VobSub) aren't supported yet; without subtitles the
  plugin answers from the frame alone.

## Install

In IINA's **Settings → Plugins**, choose to install a plugin from GitHub and enter
`averma12/watch-companion`.

Or from a clone, for development:

```bash
/Applications/IINA.app/Contents/MacOS/iina-plugin link iina-plugin/watch-companion.iinaplugin
```

New plugins are disabled by default: enable **Watch Companion** in **Settings → Plugins**.

## Use

1. Open a film in IINA.
2. Press **⌘K**, or **Plugin → Show Plugins Panel** and pick **Ask** in the panel's menu.
3. Type a question. The first time, the plugin asks for your API key (or imports
   `ANTHROPIC_API_KEY` from an env file you name in its preferences) and stores it in the
   Keychain.

Preferences (**Settings → Plugins → Watch Companion**): model (Opus 5.5, Sonnet 5.5, Haiku 5.5),
effort, sending the frame on or off, the Wikipedia cast lookup on or off, and the key import
file.

## Develop

```bash
node --test iina-plugin/test/*.test.js
```

Layout and the lessons learned along the way (IINA API quirks, measured latency and cost, why
SDH tracks matter) are in [docs/DESIGN.md](docs/DESIGN.md). Agent and contributor rules are in
[AGENTS.md](AGENTS.md).

**Test without typing:** write
`{"at": 600, "viaSidebar": true, "questions": ["Who is on screen right now?"]}` to
`~/Library/Application Support/com.colliderli.iina/plugins/.data/com.averma12.watch-companion/autoask.json`
and open a film: the plugin seeks to 10:00, asks through its own sidebar form, writes
`autoask-result.json` and deletes the request. Each question costs real API money.

## Roadmap

- **Watching on a TV.** Find the position when the film plays on the TV instead of in IINA:
  from the casting tool, or by listening with ShazamKit against a catalog built from the film's
  own audio (prototype in [helpers/listener](helpers/listener); first measurements in
  [docs/DESIGN.md](docs/DESIGN.md)). Ask from a phone page instead of the Mac's sidebar.
- **Spoiler-safe web search** for background questions (the actor's other films, the comics),
  limited to pages published before the film's release.
- The last few seconds as several frames, for "what just happened?".

## License

[MIT](LICENSE)
