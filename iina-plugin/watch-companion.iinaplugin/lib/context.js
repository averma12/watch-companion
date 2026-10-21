// Pure functions: subtitles, the position, cast, the request to Claude and its cost. No `iina`
// here, so the spoiler guard can be tested with plain node (iina-plugin/test/).

// --- subtitles -------------------------------------------------------------------------------

const toSec = (t) => {
  const parts = t.trim().replace(",", ".").split(":").map(Number);
  while (parts.length < 3) parts.unshift(0);
  return parts[0] * 3600 + parts[1] * 60 + parts[2];
};

const cleanText = (lines) => lines.join(" ")
  .replace(/<[^>]+>/g, "")      // <i>, <font …>, WebVTT voice tags
  .replace(/\{\\[^}]*\}/g, "")  // ASS override tags that survive conversion
  .replace(/\s+/g, " ").trim();

// SubRip and WebVTT both use "start --> end" lines; this reads either.
const parseSubs = (text) => (text || "").replace(/^﻿/, "").replace(/\r/g, "").split(/\n\s*\n/)
  .map((block) => {
    const rows = block.trim().split("\n");
    const i = rows.findIndex((r) => r.includes("-->"));
    if (i < 0) return null;
    const [a, b] = rows[i].split("-->");
    const text = cleanText(rows.slice(i + 1));
    return text ? { start: toSec(a), end: toSec(b.trim().split(/\s+/)[0]), text } : null;
  })
  .filter(Boolean)
  .sort((x, y) => x.start - y.start);

// The spoiler guard: only lines that have started by `now`.
const cuesUpTo = (cues, now) => cues.filter((c) => c.start <= now);

// SDH subtitles name the speaker ("SAM: I'll take one.") and mark sounds ("[CHUCKLES]").
// Without names the model tends to give every line to the main character (docs/DESIGN.md).
const SPEAKER_LABEL = /^[-–\s]*(?:\[[^\]]*\]\s*)?[A-Z][A-Z0-9 .'’-]{0,24}:/;
const speakerLabelCount = (cues) => cues.filter((c) => SPEAKER_LABEL.test(c.text)).length;

// Of several subtitle tracks for the same film, the one with speaker names gives the best context.
// candidates: [{ id, cues, selected }]. Picks the most labels (at least `min`), else the selected
// track, else the first.
const pickContextTrack = (candidates, min = 10) => {
  const withCues = candidates.filter((c) => c.cues && c.cues.length);
  if (!withCues.length) return null;
  const best = withCues.reduce((a, b) => (speakerLabelCount(b.cues) > speakerLabelCount(a.cues) ? b : a));
  if (speakerLabelCount(best.cues) >= min) return best;
  return withCues.find((c) => c.selected) || withCues[0];
};

const stamp = (s) => {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
  const mm = h ? String(m).padStart(2, "0") : String(m);
  return `${h ? h + ":" : ""}${mm}:${String(sec).padStart(2, "0")}`;
};

const transcriptOf = (cues) => cues.map((c) => `[${stamp(c.start)}] ${c.text}`).join("\n");

// --- subtitle timing against the audio ------------------------------------------------------

// A subtitle file made for another release can be seconds off. If it runs early, lines the viewer
// hasn't heard yet fall inside the cutoff. To check, ffmpeg measures speech energy in the centre
// channel (where dialogue sits in 5.1) every 50 ms over a few windows, and each window is matched
// against "a line is on screen" at lags of up to ±30 s, as ffsubsync does with speech detection.
const SYNC_STEP = 0.05;
const SYNC_MAX_LAG = 30;

// ffmpeg's `ametadata=print` output: one "lavfi.astats.Overall.RMS_level=<dB>" per frame.
const parseRmsLevels = (text) => [...(text || "").matchAll(/RMS_level=(-?[\d.]+|-inf)/g)]
  .map((m) => (m[1] === "-inf" ? -120 : Number(m[1])));

// The lag (seconds) at which the window's speech energy best matches the cues: a cue shown at
// time t + lag goes with the audio at t. Negative means the subtitles run early.
const speechLag = (levels, cues, from, step = SYNC_STEP, maxLag = SYNC_MAX_LAG) => {
  if (levels.length < 2) return null;
  const mean = levels.reduce((a, b) => a + b, 0) / levels.length;
  const sd = Math.sqrt(levels.reduce((a, b) => a + (b - mean) ** 2, 0) / levels.length);
  if (!sd) return null;
  const e = levels.map((x) => (x - mean) / sd);
  const lo = from - maxLag;
  const on = new Uint8Array(Math.ceil((levels.length * step + 2 * maxLag) / step) + 2);
  for (const c of cues) {
    for (let k = Math.max(0, Math.ceil((c.start - lo) / step)); k < on.length && lo + k * step < c.end; k++) on[k] = 1;
  }
  let best = null;
  const lags = Math.round(maxLag / step);
  for (let j = -lags; j <= lags; j++) {
    let s = 0, n1 = 0;
    for (let i = 0; i < e.length; i++) { const v = on[i + j + lags]; s += e[i] * v; n1 += v; }
    const p = n1 / e.length;
    if (p === 0 || p === 1) continue;
    const r = s / e.length / Math.sqrt(p * (1 - p));
    if (!best || r > best.r) best = { lag: Math.round(j * step * 100) / 100, r };
  }
  return best;
};

// Windows that agree within `tol` seconds; at least two must, else the check is inconclusive
// (a cut that differs from the subtitles' release, or a frame-rate drift, shows up this way).
const agreedLag = (lags, tol = 0.5) => {
  const ok = lags.filter((l) => l && Number.isFinite(l.lag)).map((l) => l.lag);
  let group = [];
  for (const a of ok) {
    const g = ok.filter((b) => Math.abs(a - b) <= tol);
    if (g.length > group.length) group = g;
  }
  if (group.length < 2) return null;
  const s = group.slice().sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

// How far to move the cues later before cutting off at `now`. The viewer's own subtitle delay
// (mpv `sub-delay`, positive = later) says when lines were on screen; a lag measured early by
// more than `threshold` moves them later by that much. Never earlier: a wrong correction must not
// let an unheard line in, and lines that run late only cost the last few seconds.
const cueShift = ({ subDelay = 0, lag = null, threshold = 1 } = {}) =>
  Math.max(0, Number.isFinite(subDelay) ? subDelay : 0, lag != null && lag < -threshold ? -lag : 0);

const shiftCues = (cues, by) => (by ? cues.map((c) => ({ ...c, start: c.start + by, end: c.end + by })) : cues);

// --- position --------------------------------------------------------------------------------

// Where the viewer is comes from a position source: { name, label, now() }, where now() returns
// (or resolves to) { seconds }. In IINA that is mpv's clock; when the file is cast to a TV it is
// tvcast (below). The subtitle cutoff, the citations and the seek clamp all take their time from
// one reading per question, never from the player directly.
// A reading that isn't a usable time is an error, not 0 or a guess.
const positionNow = async (source) => {
  const reading = await source.now();
  const s = reading && reading.seconds;
  if (typeof s !== "number" || !Number.isFinite(s) || s < 0) {
    throw new Error(`Couldn't tell where you are in the film (position from ${source.label}).`);
  }
  return s;
};

// When the same file is cast to a TV with tvcast, its panel API (`/api/status`) reports what the
// TV plays and where: `now.file` (the file name) and `tv.state` / `tv.position`. Measured against
// the TV's own audio, that position is within tvcast's 1 s resolution, seeks included. A reading
// counts only for the file open in IINA, while the TV plays or is paused on it. A stale reading
// is earlier than the truth, which is the safe side.
const TV_STATES = ["PLAYING", "PAUSED_PLAYBACK"];
const tvReading = (status, path) => {
  const now = status && status.now, tv = status && status.tv;
  if (!now || !tv || !path || now.file !== path.split("/").pop()) return null;
  if (!TV_STATES.includes(tv.state) || typeof tv.position !== "number" || !Number.isFinite(tv.position)) return null;
  return { seconds: tv.position, playing: tv.state === "PLAYING" };
};

// --- film and cast -------------------------------------------------------------------------

// "Big.Buck.Bunny.2008.1080p.mp4" -> { title: "Big Buck Bunny", year: "2008" }
const titleFromPath = (path) => {
  const base = path.split("/").pop().replace(/\.[^.]+$/, "");
  const m = base.match(/^(.*?)[ ._(\[]+((?:19|20)\d\d)(?:[ ._)\]]|$)/);
  return m ? { title: m[1].replace(/[._]+/g, " ").trim(), year: m[2] }
           : { title: base.replace(/[._]+/g, " ").trim(), year: "" };
};

// Wikipedia's Cast section: only top-level bullets, and only "actor as character". The text after
// the names (and the prose paragraphs) describes the plot, so it is dropped.
const unlink = (s) => s.replace(/\[\[(?:[^|\]]*\|)?([^\]]*)\]\]/g, "$1").replace(/'''?/g, "");
const castFromWikitext = (wt) => (wt || "").split("\n")
  .map((l) => l.match(/^\*(?!\*)\s*(.+?)\s+as\s+(.+)$/))
  .filter(Boolean)
  .map((m) => ({
    actor: unlink(m[1]).trim(),
    character: unlink(m[2].split(/:\s*|<ref|<br|,\s+(?:a|an|the)\s/)[0]).trim().replace(/[ .,]+$/, ""),
  }))
  .filter((c) => c.actor && c.character);

// Names a cast entry can be called by: actor, each "/" part of the character, a quoted nickname,
// and single words of four letters or more ("Nora", "Vance", "Kestrel").
const namesOf = (entry) => {
  const parts = [entry.actor, ...entry.character.split("/")].map((p) => p.trim()).filter(Boolean);
  const out = new Set(parts.map((p) => p.replace(/"/g, "")));
  for (const p of parts) {
    for (const q of p.match(/"([^"]+)"/g) || []) out.add(q.replace(/"/g, ""));
    for (const w of p.replace(/"[^"]*"/g, "").split(/\s+/)) if (w.length >= 4) out.add(w);
  }
  return [...out];
};
const mentions = (text, name, flags = "") =>
  new RegExp(`(^|[^\\w-])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`, flags).test(text);

// Cast entries the answer names although the subtitles so far never did and the question didn't.
// A cheap backstop for the "never mention anyone else" instruction.
const unseenCastMentions = (answer, cast, transcript, question) => cast
  .filter((entry) => {
    const names = namesOf(entry);
    if (names.some((n) => mentions(transcript, n))) return false;
    if (names.some((n) => mentions(question, n, "i"))) return false;
    return names.some((n) => mentions(answer, n));
  })
  .map((entry) => entry.character);

// --- the request -------------------------------------------------------------------------------

const SYSTEM =
  "You answer questions from someone watching a film or an episode, while they watch. You get the " +
  "subtitles up to the viewer's current position, usually the current frame, and the cast list. " +
  "The subtitles and the frame are everything the viewer has seen so far. Never reveal, hint at " +
  "or guess anything that happens later; if the answer depends on later events, say it hasn't " +
  "been shown yet. Use the cast list only to put names to people who are visible in the frame or " +
  "named in the subtitles; never mention anyone else from it. Subtitle lines often don't say who " +
  "is speaking: a line without a speaker label may belong to anyone in the scene, so don't give it " +
  "to the main character by default; if it matters and you can't tell, say so. " +
  "Cite your sources inline: after a statement taken from the subtitles, put the time of that line in " +
  "square brackets exactly as it appears in the transcript, for example [22:59]; after a statement from " +
  "the frame, put [frame]. Use outside knowledge only for background that isn't this film's story " +
  "(earlier films, the real world, the comics), and mark it [background]. Never use outside knowledge " +
  "about this film's plot. Answer in plain text without Markdown, in two to four sentences unless the " +
  "viewer asks for more.";

// Models that accept `fallbacks: "default"` (Claude Haiku 5.5 has no server-side fallback).
const FALLBACK_MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-1"];

// The same Messages request goes to Anthropic, or to OpenRouter's Anthropic-compatible endpoint
// with an OpenRouter key. OpenRouter names the models `anthropic/claude-opus-5.5` and does its own
// fallback, so the Anthropic fallback beta is left out there.
const PROVIDERS = {
  anthropic: { url: "https://api.anthropic.com/v1/messages", auth: (key) => ({ "x-api-key": key }) },
  openrouter: { url: "https://openrouter.ai/api/v1/messages", auth: (key) => ({ authorization: `Bearer ${key}` }) },
};
const openRouterModel = (model) => `anthropic/${model.replace(/-(\d+)-(\d+)$/, "-$1.$2")}`;
// OpenRouter keys start with "sk-or-"; anything else is taken as an Anthropic key.
const providerOfKey = (key) => (/^sk-or-/.test(key || "") ? "openrouter" : "anthropic");

// Everything the model sees is built here, and only from cues up to `now`.
const buildRequest = ({ model, effort, film, cast, cues, now, frameB64, question, history, provider = "anthropic" }) => {
  const seen = cuesUpTo(cues || [], now);
  const content = [];
  const filmLine = film && film.title ? `${film.title}${film.year ? ` (${film.year})` : ""}` : "unknown";
  content.push({ type: "text", text: `Title: ${filmLine}\nCurrent position: ${stamp(now)}` });
  if (cast && cast.length) {
    content.push({ type: "text", text: `Cast (actor as character):\n${cast.map((c) => `${c.actor} as ${c.character}`).join("\n")}` });
  }
  content.push({ type: "text", text: seen.length
    ? `Subtitles so far (up to ${stamp(now)}):\n${transcriptOf(seen)}`
    : "No subtitles are available, so answer from the frame alone." });
  if (frameB64) content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: frameB64 } });
  if (history && history.length) {
    content.push({ type: "text", text: `Earlier in this chat:\n${history.map((h) => `Q: ${h.q}\nA: ${h.a}`).join("\n\n")}` });
  }
  content.push({ type: "text", text: question });
  const openrouter = provider === "openrouter";
  const body = { model: openrouter ? openRouterModel(model) : model, max_tokens: 16000, output_config: { effort },
                 system: SYSTEM, messages: [{ role: "user", content }] };
  const headers = { "content-type": "application/json", "anthropic-version": "2023-06-01" };
  if (!openrouter && FALLBACK_MODELS.includes(model)) {
    body.fallbacks = "default";
    headers["anthropic-beta"] = "server-side-fallback-2026-07-01";
  }
  return { url: PROVIDERS[openrouter ? "openrouter" : "anthropic"].url, body, headers,
           transcript: transcriptOf(seen), cueCount: seen.length };
};

// --- citations -----------------------------------------------------------------------------

const STAMP_RE = /\[(\d{1,2}:\d{2}(?::\d{2})?)\]/g;
const parseStamp = (t) => t.split(":").map(Number).reduce((acc, n) => acc * 60 + n, 0);

// Every [m:ss] / [h:mm:ss] in an answer. A citation is valid only if it is not after `now` and a
// subtitle line starts within 1.5 s of it, so a made-up or future time is never turned into a
// link the viewer could seek to.
const citationsIn = (text, cues, now) => {
  const out = [];
  for (const m of (text || "").matchAll(STAMP_RE)) {
    const t = parseStamp(m[1]);
    const valid = t <= now + 0.5 && (cues || []).some((c) => Math.abs(c.start - t) < 1.5 && c.start <= now);
    out.push({ raw: m[0], label: m[1], t, valid });
  }
  return out;
};

// USD per million tokens, input / output (claude-api reference, cached 2026-10-06).
const PRICES = {
  "claude-opus-5-5": [4, 20],
  "claude-sonnet-5-5": [2, 10],
  "claude-haiku-5-5": [0.1, 0.5],
  "claude-fable-5-1": [10, 50],
};
// OpenRouter reports what it charged (`usage.cost`); otherwise the list price.
const costUSD = (model, usage) => {
  if (usage && typeof usage.cost === "number") return usage.cost;
  const p = PRICES[model];
  if (!p || !usage) return null;
  return ((usage.input_tokens || 0) * p[0] + (usage.output_tokens || 0) * p[1]) / 1e6;
};

const answerText = (data) => ((data && data.content) || [])
  .filter((b) => b.type === "text").map((b) => b.text).join("").trim();

module.exports = {
  parseSubs, cuesUpTo, speakerLabelCount, pickContextTrack, stamp, transcriptOf, parseRmsLevels, speechLag, agreedLag,
  cueShift, shiftCues, positionNow, tvReading, titleFromPath, castFromWikitext, namesOf,
  unseenCastMentions, buildRequest, PROVIDERS, openRouterModel, providerOfKey, citationsIn, parseStamp, costUSD, answerText, PRICES, SYSTEM,
};
