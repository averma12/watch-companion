# AGENTS.md

Guide for coding agents (Claude Code, Codex, …) and contributors. Read this first, then
[docs/DESIGN.md](docs/DESIGN.md).

## What this is

Watch Companion answers questions about the film being watched in IINA, from the subtitles so
far, the current frame and the cast names. See [README.md](README.md).

## Rules

1. **No spoilers.** Never send the model anything past the viewer's current position: no later
   subtitle lines, frames, plot summaries or synopses. All context goes through
   `buildRequest()` in `lib/context.js`; keep it the only place, and test it.
2. **Retrieval is the product.** Choose the right context before reaching for a bigger model.
   A film's subtitles up to now fit in the context window; use smarter retrieval only when they
   don't (for example across a whole series).
3. **Privacy.** Video files never leave the Mac. Only text and downscaled frames go to APIs.
   API keys live in the macOS Keychain, never in files or the repo.
4. **Local first.** Do on the Mac what it can do (ffmpeg, screenshots, ShazamKit). The LLM call
   is the main network step.
5. **Cheap frames.** About 768 px on the long side; HDR must be tone-mapped (mpv's screenshot
   already is).
6. **DRM is a wall, not a puzzle.** Never capture, record or decrypt protected streams.

## IINA plugin facts (checked against IINA 1.5.0)

- Entry runs once per player window, before a file opens; do work in `mpv.file-loaded` and set
  up UI in `iina.window-loaded`.
- **After `await iina.http.*`, code runs off the main thread.** UI calls there
  (`sidebar.show()`, …) crash IINA. Hop first: `await new Promise(r => setTimeout(r, 0))`.
- `http.post(url, {headers, data: <object>})` sends the object as JSON. A string in `data` (or
  `json`/`body`) is sent as an empty body.
- Keychain: `utils.keychainWrite(service, name, value)` / `utils.keychainRead(service, name)`,
  lower-case "c". Items are stored per plugin identifier.
- `utils.exec` needs absolute paths (IINA's PATH has no Homebrew).
- `require("./lib/x.js")` with `module.exports` works.
- Native methods aren't enumerable from JS; to find one, run `strings` on the IINA binary.

## Working agreements

- **Prototype before integrating.** Try an idea in a small throwaway script against the real
  player first.
- Tests: `node --test iina-plugin/test/*.test.js`. Add a test for anything that touches what the
  model sees.
- Code, comments, commits and docs are in English. Commit messages explain why.
- Don't commit film files, frames from commercial films, subtitle files, or API keys.

## Layout

```
iina-plugin/watch-companion.iinaplugin/   the plugin
iina-plugin/test/                         node tests for lib/context.js
helpers/listener/                         experimental ShazamKit listener (watching on a TV)
docs/DESIGN.md                            design notes and lessons learned
```
