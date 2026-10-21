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

// --- position --------------------------------------------------------------------------------

// Where the viewer is comes from a position source: { name, label, now() }, where now() returns
// (or resolves to) { seconds }. In IINA that is mpv's clock; when the film plays on a TV it will be
// the casting tool or listening. The subtitle cutoff, the citations and the seek clamp all take
// their time from one reading per question, never from the player directly.
// A reading that isn't a usable time is an error, not 0 or a guess.
const positionNow = async (source) => {
  const reading = await source.now();
  const s = reading && reading.seconds;
  if (typeof s !== "number" || !Number.isFinite(s) || s < 0) {
    throw new Error(`Couldn't tell where you are in the film (position from ${source.label}).`);
  }
  return s;
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

// Everything the model sees is built here, and only from cues up to `now`.
const buildRequest = ({ model, effort, film, cast, cues, now, frameB64, question, history }) => {
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
  const body = { model, max_tokens: 16000, output_config: { effort }, system: SYSTEM,
                 messages: [{ role: "user", content }] };
  const headers = { "content-type": "application/json", "anthropic-version": "2023-06-01" };
  if (FALLBACK_MODELS.includes(model)) {
    body.fallbacks = "default";
    headers["anthropic-beta"] = "server-side-fallback-2026-07-01";
  }
  return { body, headers, transcript: transcriptOf(seen), cueCount: seen.length };
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
const costUSD = (model, usage) => {
  const p = PRICES[model];
  if (!p || !usage) return null;
  return ((usage.input_tokens || 0) * p[0] + (usage.output_tokens || 0) * p[1]) / 1e6;
};

const answerText = (data) => ((data && data.content) || [])
  .filter((b) => b.type === "text").map((b) => b.text).join("").trim();

module.exports = {
  parseSubs, cuesUpTo, speakerLabelCount, pickContextTrack, stamp, transcriptOf, positionNow, titleFromPath, castFromWikitext, namesOf,
  unseenCastMentions, buildRequest, citationsIn, parseStamp, costUSD, answerText, PRICES, SYSTEM,
};
