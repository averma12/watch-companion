# Design notes

How Watch Companion works, and what was learned building it. Numbers come from tests on an
Apple M4 Pro with IINA 1.5.0 and a 2.5-hour 4K HDR10 film with English subtitles.

## The request

Everything the model sees is built by `buildRequest()` in
`iina-plugin/watch-companion.iinaplugin/lib/context.js`, in an order that keeps the start of the
request the same from one call to the next, so the API can cache it:

1. title and year;
2. the cast as "actor as character" lines, each followed by the actor's photo (256 px, the lead
   image of their Wikipedia article); cache breakpoint;
3. the subtitle lines that have started by now, in 10-minute blocks with their times
   (`[22:59] …`); a block that has ended never changes, and the last ended block carries the
   second cache breakpoint;
4. the characters established so far (below);
5. the current position and the current frame as a 768 px JPEG (optional);
6. up to six earlier questions and answers from this chat (questions only);
7. the question, or "X-Ray: who is in this scene?".

One system prompt covers both questions and the X-Ray: it asks for plain-text answers of two to
four sentences, citations for subtitle claims (`[m:ss]`, `[frame]`, `[background]`), outside
knowledge only as tagged background and never about this film's plot, faces matched against the
actor photos, and no assumption that an unlabelled line belongs to the main character. The
X-Ray adds a JSON schema (`output_config.format`) for its cards.

A film's subtitles up to the current position fit easily: at 10 minutes about 3,300 input
tokens, at 1:40 about 45,000. No retrieval index is needed for a single film.

**Caching, measured.** At 10:00, an X-Ray wrote 7,355 tokens to the cache ($0.047), and a second
X-Ray read them back ($0.013). A question after an X-Ray did not read the X-Ray's entry: the JSON
schema is rendered ahead of the content, so questions and X-Rays keep separate entries. The cache
lives five minutes, so an isolated call pays the 1.25x write on its prefix for nothing; follow-ups
within five minutes cost about a third.

## Who the film has established: the character registry

`characterRegistry()` reads only the subtitles up to now. SDH speaker labels (`NORA:`) say who
spoke and when; names said in the dialogue say who was mentioned. Labels map to cast entries by
any of their names, short ones included (`TJ` for Theodore "TJ" Okafor, in the tests' made-up
cast). A surname two cast members share (Nora Vance and May Vance) counts for neither. A label
outside the cast list counts once it has two lines, so one-off roles (`LANDLORD`) drop out while
minor characters stay, spelled as the dialogue spells them (`DEWITT:` becomes "DeWitt"). Each entry carries what the character has been called, when they
first appeared, how many labelled lines they have, and whether they spoke or were named in the last
two minutes.

On the test film at 45:52 the registry listed ten characters, three of them outside Wikipedia's
nine-person cast list, and one cast member as "in the last two minutes" from being named in the
dialogue before any line of theirs had a label.

## X-Ray

The X-Ray is one call with the same context and a JSON schema: for each person in the scene, the
character, the actor, whether they are in the frame or speaking, a confidence, and one or two
sentences on what the film has shown so far, with citations. What can come from data does:
`xrayPeople()` adds the photo, the "first seen" time from the registry (never after now), and
checks each citation against the subtitles. As on streaming services, a visible cast member is
named even before the film names the character (the owner's choice); what is said about them
stays fenced. Someone the model can't identify is shown as a short description with low
confidence.

Tried on the test film at four positions: the person in the frame and the two speaking off it,
including a character using a false name; two named characters missing from the cast list,
found from the subtitles; a hero in a full face mask, identified by the costume and the dialogue;
and an unnamed person shown with a guess from the dialogue and low confidence.

## Spoiler defences, in layers

1. **The fence.** Only subtitle lines whose start time is ≤ now. Tested at every position.
2. **No plot sources.** Wikipedia is used only for the Cast section's names; descriptions after
   the names, and the prose paragraphs, are dropped because they carry plot.
3. **The prompt.** Never reveal or guess later events; cast names only for people visible or
   already named; outside knowledge never for this film's plot.
4. **The backstop.** If an answer names a cast member who hasn't appeared in the subtitles so far
   and wasn't in the question, the sidebar hides it behind "Show anyway".
5. **Citations can't jump ahead.** A cited time becomes a link only if a subtitle line starts
   within 1.5 s of it and it isn't after the position you asked from; seeking is clamped to that
   position too.
6. **Subtitle timing.** A subtitle file made for another release can run seconds early, which
   would let unheard lines past the fence. When a film opens, ffmpeg measures speech energy in
   the centre channel every 50 ms over three windows of up to 5 minutes, and each window is
   matched against "a line is on screen" at lags up to ±30 s. If at least two windows agree that
   the subtitles run more than 1 s early, lines are moved later by that much. The viewer's own
   subtitle delay in IINA moves them later too. Lines are never moved earlier: subtitles that run
   late only cost the last few seconds, and the sidebar says so.

Probes like "who else is in this movie?" and "is <character> in this film?" early in a film
named only people already seen and declined to say who appears later.

A known gap: the model's memory. For a well-known film in its training data it may know the
plot; the fence can't stop that, the prompt only asks it not to use it.

## Subtitles: speaker names matter

The first real failure was attribution. In a store scene the plain English track had no
speaker names, the main character had just spoken on the phone, and the answer gave the whole
conversation to him; it was his friend. The same file had a second English track in SDH style
(`SAM: I'll take one.`, `CASHIER: Down at the end.`, as in this made-up example). With it, the same model, effort
and frame answered correctly.

So the plugin reads every text subtitle track in the viewer's language and uses the one with
the most speaker labels (at least 10) as context, whatever track is shown on screen. Embedded
tracks are converted with `ffmpeg -map 0:<ff-index> -f srt pipe:1` (about 1 s for a 28 GB MP4)
and cached.

## Measured

| What | Result |
|---|---|
| Answer latency, Claude Opus 5.5, effort low, with a frame | 4.2–6.1 s |
| Cost per answer | ~$0.02 at 10 min; ~$0.10 at 51 min with a long answer |
| Effort low vs medium | same latency, similar answers (two samples) |
| Wikipedia cast lookup (3 requests) | ~2.7 s, cached per film |
| Subtitle timing check (3 × 5 min of E-AC-3 5.1) | ~4 s per film, cached; an in-sync track measures −0.3 to 0 s, and a track shifted by +5, −3 or +12 s measures the shift within 0.3 s |
| Frame | mpv `screenshot-to-file … video` is already tone-mapped for HDR10; `sips` makes the 768 px JPEG. The JPEG looks dimmer than the screen (open issue) |

## IINA plugin API lessons

- Code after `await iina.http.*` runs on the URL session's thread. Calling `sidebar.show()`
  there crashed IINA (SIGABRT in AppKit's layout engine). A `setTimeout(…, 0)` hop before any UI
  call fixes it; `toMain()` in `main.js` does this.
- `iina.http.post` sends a body only when `data` is an object (serialised as JSON). Strings in
  `data`, `json` or `body` arrive as an empty body with status 200, so the failure is silent.
- The Keychain methods are `keychainWrite`/`keychainRead` with a lower-case "c". Items are
  stored as service `"<plugin identifier> - <service>"`.
- `Object.keys(iina.utils)` shows only constants; native methods aren't enumerable. `strings`
  on `/Applications/IINA.app/Contents/MacOS/IINA` lists their selectors.
- `utils.exec` needs absolute paths. `utils.resolvePath("@data/x")` works; `"@data"` alone
  doesn't.
- `sidebar.loadFile()` at the top level of the entry script stops the script; call it in
  `iina.window-loaded`.
- New dev plugins are disabled until enabled in Settings → Plugins.

## Watching on a TV

When the film plays on a TV, IINA can't tell the position. Options, in order of preference:
the casting tool's reported position; listening with ShazamKit against a catalog made from the
film's own file; for streaming apps with no local file, the viewer typing the time once, with a
clock running from there.

**Built: tvcast's position.** The plugin polls tvcast's panel API (`GET
http://127.0.0.1:8766/api/status`) every 3 s. When `now.file` is the file open in IINA and the
TV is playing or paused, the position comes from `tv.position` (`tvReading()` in
`lib/context.js`), and the sidebar says "position from TV". On the switch the plugin pauses and
mutes IINA once, then keeps it on the TV's scene (an exact seek whenever it is more than 2 s
off). Before a question's frame, IINA seeks exactly to the position the question uses. Citation
clicks go to the TV (`POST /api/seek` with `X-TVCast: 1` and a JSON content type; without the
content type IINA form-encodes the body and tvcast answers 400).

Measured on one TV (DLNA, subtitles burned in, HLS stream), against the TV's own audio heard by
the Mac's microphone through `helpers/listener`: tvcast's position minus the heard position over
150 s, median −0.09 s, range −0.65 to +0.37 s (31 matches; tvcast reports whole seconds).
Pauses, plays and seeks from the TV's remote showed up within one poll. The frame IINA took at
the TV's position was the same frame as one taken from the file at that time.

ShazamKit results so far (`helpers/listener`):

| What | Result |
|---|---|
| Catalog from the film's file with `/usr/bin/shazam` | 73 s for 2.5 h, 1.5 MB |
| 10 s clean clips at four positions | all matched, within 5 ms |
| Simulated TV speaker + room echo + noise, 10 s | 7 of 8 matched, within 15 ms |
| Mac microphone, film playing from the Mac's speakers | 17 of 17 matches in 35 s; a steady ~0.3 s lag behind the player |
| Catalog from one audio track (`catalog.sh`: ffmpeg extracts it, then `/usr/bin/shazam`) | ~87 s for 2.5 h; the same clips all match |
| Two different tracks in one file, 8 clips each | whole-file catalog (tracks mixed): 3–6 of 8; one-track catalog: 5–8 of 8, and 0 of 8 from the other track |

A file with several audio tracks (a dub next to the original) needs the catalog of the track
that plays: `/usr/bin/shazam` signs all tracks mixed, which matches worse, and a catalog of the
wrong language matches nothing.

IINA has no microphone permission, so the listener must be its own signed binary with a
microphone usage string, not a process the plugin starts. Not yet tested against a real TV.
Known limits: dubbed audio needs a catalog per language; ads and recaps in streaming apps break
a running clock.
