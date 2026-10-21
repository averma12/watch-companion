# Watch Companion

Ask questions about the film you're watching, while you watch it, without spoilers.

Watch Companion is a plugin for [IINA](https://iina.io), the macOS video player. Press ⌘K, ask
"who is this?", "what did she just say?" or "what has happened so far?", and get an answer in
the sidebar in a few seconds, or press **X-Ray** to see who is in the scene. Answers are built
only from what you have already seen: the subtitles up to the current position, the current
frame and the cast. Nothing from later in the film is ever sent to the model.

```
  you ask ──► subtitles up to now ─┐
              current frame (768 px)├──► Claude ──► answer with citations [22:59]
              cast + photos (Wikipedia)┘             (click a time to jump back there)
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
- **X-Ray.** Press **X-Ray** in the sidebar (or **Plugin → X-Ray: who's in this scene**): a card
  for each person in the scene, with the actor's photo, the character and the actor, whether
  they are in the frame or speaking, one or two lines on what the film has shown about them so
  far (with clickable times), and when the film first showed them. As on streaming services, a
  cast member who is visible is named even before the film names the character.
- **Knows who has appeared.** From the subtitles so far, the plugin works out which characters
  the film has introduced, what they have been called, when they first appeared, and who spoke
  in the last two minutes (SDH speaker labels help most). The model gets that list and the
  actors' photos, so "who is this?" and "who said that?" land on the right person.
- **Cast names, not plot.** The cast comes from the Cast section of the film's Wikipedia
  article: actor and character names only; the descriptions (which carry plot) are dropped. If
  an answer names a cast member who hasn't been mentioned yet, it is hidden behind
  "Show anyway".
- **Subtitles in time with the audio.** When a film opens, the plugin checks the subtitle track
  against the dialogue in the audio (about 4 s, once per file). If the subtitles run early,
  lines are counted from when they are spoken, so a line you haven't heard yet can't slip in.
  Your subtitle delay in IINA is followed too. Lines are never moved earlier.
- **Subtitles from anywhere in the file.** A `.srt`/`.vtt` beside the video, or a text track
  inside it (read once with `ffmpeg` and cached).
- **Watching on a TV.** Cast the film to your TV with [tvcast](https://github.com/thepushkarp/tvcast)
  and keep it open in IINA on the Mac. While the TV plays that file, the plugin takes the
  position from the TV (the sidebar says "position from TV"), keeps IINA paused, muted and on
  the TV's scene, and takes the frame from there. Clicking a citation jumps the TV back to that
  line, and "← Back" returns it.
- **Follow-up questions.** The last six questions and answers go with each new one, so "now?"
  after "where are we?" is understood.
- **Cost shown per answer.** With Claude Opus 5.5, about $0.01–0.05 for a question or an X-Ray
  shortly after another one, and up to about $0.20 for the first one late in a film (more
  subtitles, more tokens). The cast, the photos and the subtitles up to the last full ten
  minutes are cached for five minutes, so follow-ups are cheap. About 5–12 s each.

## Privacy

- The video file never leaves your Mac. Sent to Anthropic (or OpenRouter, if you use an
  OpenRouter key): the subtitle text up to now, one
  downscaled frame (optional), the cast with the actors' photos, and your question. Sent to
  Wikipedia: the film's title and year and the actors' names, to look up the cast and their
  photos (optional; the photos come from wikimedia.org and are cached on your Mac). On a TV, the plugin only talks to tvcast on
  your own Mac (`127.0.0.1:8766`).
- Your API key is stored in the macOS Keychain, not in files.

## Quick start

You need a Mac, about five minutes, and an Anthropic or OpenRouter API key.

1. **Install IINA** from [iina.io](https://iina.io) (or `brew install --cask iina`). Version 1.5
   or later.
2. **Get an API key** at [console.anthropic.com](https://console.anthropic.com/) and add a few
   dollars of credit. The API is billed separately from a Claude.ai subscription. A question
   costs about $0.02–0.10. An [OpenRouter](https://openrouter.ai/keys) key (`sk-or-…`) works
   too: the plugin sends the same request to OpenRouter's Anthropic-compatible endpoint, with
   the same Claude models.
3. **Install the plugin**, either way:
   - Download `watch-companion-<version>.iinaplgz` from the
     [latest release](https://github.com/averma12/watch-companion/releases/latest) and
     double-click it; IINA asks to install it.
   - Or in IINA: **Settings → Plugins**, install from GitHub, and paste
     `https://github.com/averma12/watch-companion`. IINA will then offer updates by itself.

   Make sure **Watch Companion** is enabled in **Settings → Plugins**.
4. **Watch something with subtitles.** Open a film whose subtitles are a `.srt`/`.vtt` file next
   to the video (same name) or a text track inside it. For tracks inside the video, install
   [`ffmpeg`](https://ffmpeg.org) once: `brew install ffmpeg`.
5. **Ask.** Press **⌘K** (or **Plugin → Show Plugins Panel**, then pick **Ask**), type a
   question, press Enter, or press **X-Ray**. The first time, paste your API key when asked; it
   is stored in the macOS Keychain.

Settings (**Settings → Plugins → Watch Companion**): model (Opus 5.5 by default; Sonnet 5.5 and
Haiku 5.5 are cheaper), provider (whichever key you have, Anthropic first; or Anthropic or
OpenRouter), effort, whether to send the frame, whether to look up the cast, and an optional env
file to import `ANTHROPIC_API_KEY` or `OPENROUTER_API_KEY` from instead of pasting it.

**On a TV:** start tvcast's daemon, play the film on the TV with it (`tv open <title>`), and open
the same file in IINA. Within a few seconds the sidebar shows "position from TV". Then ask as
usual from the Mac.

Limits today: text subtitles only (not image-based PGS/VobSub; without subtitles it answers
from the frame alone), English Wikipedia for the cast, and on a TV only a local file cast with
tvcast (not streaming apps, not other casting tools).

## Develop

```bash
node --test iina-plugin/test/*.test.js
```

Link the plugin folder into IINA instead of installing a release (then enable it in
**Settings → Plugins**; dev plugins start disabled):

```bash
/Applications/IINA.app/Contents/MacOS/iina-plugin link iina-plugin/watch-companion.iinaplugin
```

**Release:** bump `version` and `ghVersion` in `Info.json`, then push a tag like `v0.1.1`; the
`release` workflow packs the plugin into an `.iinaplgz` and attaches it to a GitHub release,
which is where IINA installs and updates from.

Layout and the lessons learned along the way (IINA API quirks, measured latency and cost, why
SDH tracks matter) are in [docs/DESIGN.md](docs/DESIGN.md). Agent and contributor rules are in
[AGENTS.md](AGENTS.md).

**Test without typing:** write
`{"at": 600, "viaSidebar": true, "questions": ["Who is on screen right now?"]}` to
`~/Library/Application Support/com.colliderli.iina/plugins/.data/com.averma12.watch-companion/autoask.json`
and open a film: the plugin seeks to 10:00, asks through its own sidebar form, writes
`autoask-result.json` and deletes the request. Each question costs real API money. Add
`"xray": true` to run the X-Ray there, `"subsShift": -5` to move the subtitles 5 s early first
(to test the timing check), or `"frames": [600, 1800]` to save the frames a question would send.

## Roadmap

- **More ways to watch on a TV.** Listening with ShazamKit as a check on the TV's position, and
  for players that don't report one (prototype in [helpers/listener](helpers/listener);
  measurements in [docs/DESIGN.md](docs/DESIGN.md)). Ask from a phone page instead of the Mac's
  sidebar, or by voice.
- **Spoiler-safe web search** for background questions (the actor's other films, the comics),
  limited to pages published before the film's release.
- The last few seconds as several frames, for "what just happened?".

## License

[MIT](LICENSE)
