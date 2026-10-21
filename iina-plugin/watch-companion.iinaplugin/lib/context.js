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

// --- who the film has established so far ------------------------------------------------------

// From the subtitles up to `now` only: SDH speaker labels ("NORA: …") say who spoke and when;
// names in the dialogue say who was mentioned. It tells the model who is around in this scene,
// so a line or a face can be put to the right person.
const CUE_LABEL = /^[-–\s]*(?:\[[^\]]*\]\s*)?([A-Z][A-Z0-9 .'’-]{0,24}):/;
// Labels that name a role, not a character ("MAN 2", "FEMALE REPORTER", "APP VOICE").
const ROLE_LABEL = /\b(MAN|WOMAN|MEN|WOMEN|BOY|GIRL|GUY|GUARD|ANCHOR|NARRATOR|VOICE|REPORTER|DISPATCHER|OFFICER|COP|ALL|CROWD|ANNOUNCER|DRIVER|STUDENT|KID|PEOPLE|SOLDIER|NURSE|DOCTOR|WAITER|BOYFRIEND|GIRLFRIEND|PILOT|CASHIER|CLERK|HOST|TEACHER|PROFESSOR|AGENT|RADIO|TV|COMPUTER|SYSTEM|AUTOMATED|APP)\b|\d$/;
const RECENT_SECONDS = 120;

// Every way a cast entry can be labelled: its names plus each word of two letters or more
// ("TJ", "Al", "Bo"), upper-cased as SDH labels are.
const labelNames = (entry) => {
  const out = new Set(namesOf(entry).map((n) => n.toUpperCase()));
  for (const part of [entry.actor, ...entry.character.split("/")]) {
    for (const w of part.replace(/"/g, " ").split(/\s+/)) if (w.length >= 2) out.add(w.toUpperCase());
  }
  return out;
};

// [{ character, actor, calledSoFar, lines, firstSeen, recent }], most lines first.
const characterRegistry = (cues, cast, now) => {
  const seen = cuesUpTo(cues || [], now);
  cast = cast || [];
  const people = new Map();
  const person = (key, init) => {
    if (!people.has(key)) people.set(key, Object.assign({ names: new Set(), lines: 0, first: Infinity, recent: false }, init));
    return people.get(key);
  };
  const byLabel = new Map();
  for (const e of cast) for (const n of labelNames(e)) if (!byLabel.has(n)) byLabel.set(n, e);
  // A name two cast entries share ("Vance" for Nora and May) says nothing about which one.
  const owners = new Map();
  for (const e of cast) for (const n of namesOf(e)) owners.set(n, (owners.get(n) || 0) + 1);
  for (const c of seen) {
    const hit = (p, name) => {
      p.names.add(name);
      p.first = Math.min(p.first, c.start);
      if (now - c.start <= RECENT_SECONDS) p.recent = true;
    };
    const m = c.text.match(CUE_LABEL);
    if (m) {
      const label = m[1].trim();
      const entry = byLabel.get(label) || cast.find((e) => [...labelNames(e)].some((n) => n.length >= 4 && label.includes(n)));
      if (entry || !ROLE_LABEL.test(label)) {
        const p = person(entry ? `cast:${entry.character}` : `label:${label}`, entry ? { entry } : { label });
        p.lines++;
        hit(p, label);
      }
    }
    const said = c.text.replace(CUE_LABEL, "");
    for (const e of cast) {
      for (const n of namesOf(e)) {
        if (n !== e.actor && owners.get(n) === 1 && mentions(said, n)) hit(person(`cast:${e.character}`, { entry: e }), n);
      }
    }
  }
  // A label outside the cast list counts once it has two lines; one-off labels are roles
  // ("LANDLORD"). Its spelling comes from the dialogue when the dialogue has it ("DeWitt").
  const spelled = (label) => {
    const re = new RegExp(`\\b(${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})\\b`, "i");
    for (const c of seen) {
      const m = c.text.replace(CUE_LABEL, "").match(re);
      if (m && m[1] !== label) return m[1];
    }
    return /[^A-Z ]/.test(label) ? label : label.charAt(0) + label.slice(1).toLowerCase();
  };
  return [...people.values()].filter((p) => p.entry || p.lines >= 2).map((p) => ({
    character: p.entry ? p.entry.character : spelled(p.label), actor: p.entry ? p.entry.actor : "",
    calledSoFar: [...p.names], lines: p.lines, firstSeen: p.first, recent: p.recent,
  })).sort((a, b) => b.lines - a.lines || a.firstSeen - b.firstSeen);
};

const registryText = (registry) => registry.map((p) => `- ${p.character}${p.actor ? ` (${p.actor})` : ""}: ` +
  `called ${p.calledSoFar.join(", ")}; first at [${stamp(p.firstSeen)}]; ${p.lines} lines with a speaker label` +
  `${p.recent ? "; in the last two minutes" : ""}`).join("\n");

// --- the request -------------------------------------------------------------------------------

// Shared by questions and the X-Ray: what the model gets and the rules that keep it spoiler-free.
const CONTEXT_RULES =
  "You get the cast list with a photo of each actor, the characters the film has established so far " +
  "(worked out from the subtitles' speaker labels and the names said in the dialogue), the subtitles up to " +
  "the viewer's current position, and usually the current frame. The subtitles and the frame are everything " +
  "the viewer has seen so far. Never reveal, hint at or guess anything that happens later. Never use " +
  "outside knowledge about this film's plot. To tell who someone is, compare faces in the frame with the " +
  "actor photos (a face may be older, younger, made up or partly hidden; someone in a mask or costume is " +
  "known by the costume and the dialogue), and use the established characters and the last two minutes of " +
  "subtitles to tell who is in the scene and who is speaking. Subtitle lines often don't say who is speaking: " +
  "a line without a speaker label may belong to anyone in the scene, so don't give it to the main character " +
  "by default; if it matters and you can't tell, say so. Cite subtitles inline with the time of the line in " +
  "square brackets exactly as it appears in the transcript, for example [22:59].";

// One system prompt for questions and the X-Ray, so both share the cached prefix. The X-Ray names
// cast members who are visible even before the film names the character, as streaming services'
// X-Ray does (the owner's choice); what it says about them stays fenced.
const SYSTEM =
  "You help someone watching a film or an episode, while they watch: you answer their questions, or, when " +
  "asked for the X-Ray, list who is in the scene. " + CONTEXT_RULES + "\n\n" +
  "Questions: if the answer depends on later events, say it hasn't been shown yet. Use the cast list only to " +
  "put names to people who are visible in the frame or named in the subtitles; never mention anyone else " +
  "from it. After a statement from the frame, put [frame]. Use outside knowledge only for background that " +
  "isn't this film's story (earlier films, the real world, the comics), and mark it [background]. Answer in " +
  "plain text without Markdown, in two to four sentences unless the viewer asks for more.\n\n" +
  "X-Ray: list the people in the current scene: everyone visible in the frame, and anyone speaking or spoken " +
  "to in the last two minutes of subtitles. You may name a cast member who is visible even if the film hasn't " +
  "named the character yet. If you can't tell who someone visible is, include them with an empty actor, the " +
  "character as a short description (\"a woman in a yellow coat\"), and confidence low. For each person, " +
  "known_so_far is one or two sentences on what the film has shown about this character up to now, from the " +
  "subtitles and the frame only, with subtitle citations; leave it empty if the film has shown nothing yet. " +
  "scene is one sentence on what is happening right now.";

const XRAY_SCHEMA = {
  type: "object", additionalProperties: false, required: ["scene", "people"],
  properties: {
    scene: { type: "string" },
    people: { type: "array", items: {
      type: "object", additionalProperties: false,
      required: ["character", "actor", "in_frame", "speaking_recently", "confidence", "known_so_far"],
      properties: {
        character: { type: "string" }, actor: { type: "string" },
        in_frame: { type: "boolean" }, speaking_recently: { type: "boolean" },
        confidence: { type: "string", enum: ["high", "medium", "low"] },
        known_so_far: { type: "string" },
      },
    } },
  },
};

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

// Subtitles go in 10-minute blocks. A block that has ended never changes, so the request up to the
// last ended block (after the cast and photos, which don't change during a film) is a stable
// prefix that the API caches; only the block in progress and what follows it are new each time.
const SUB_BLOCK = 600;
const subtitleBlocks = (seen, now) => {
  const blocks = [];
  for (const c of seen) {
    const i = Math.floor(c.start / SUB_BLOCK);
    if (!blocks.length || blocks[blocks.length - 1].i !== i) blocks.push({ i, cues: [] });
    blocks[blocks.length - 1].cues.push(c);
  }
  return blocks.map((b) => ({ ended: (b.i + 1) * SUB_BLOCK <= now,
    text: `Subtitles ${stamp(b.i * SUB_BLOCK)}–${stamp((b.i + 1) * SUB_BLOCK)}:\n${transcriptOf(b.cues)}` }));
};
const cached = (block) => Object.assign(block, { cache_control: { type: "ephemeral" } });

// Everything the model sees is built here, and only from cues up to `now`. `heads` are the actors'
// photos ({ actor, b64 }); `mode` "xray" asks for the X-Ray's JSON instead of an answer.
const buildRequest = ({ model, effort, film, cast, heads, cues, now, frameB64, question, history,
                        provider = "anthropic", mode = "ask" }) => {
  const seen = cuesUpTo(cues || [], now);
  const xray = mode === "xray";
  const content = [];
  const filmLine = film && film.title ? `${film.title}${film.year ? ` (${film.year})` : ""}` : "unknown";
  content.push({ type: "text", text: `Title: ${filmLine}` });
  if (cast && cast.length) {
    content.push({ type: "text", text: "Cast (actor as character), with the actor's photo where there is one:" });
    for (const c of cast) {
      content.push({ type: "text", text: `${c.actor} as ${c.character}` });
      const h = (heads || []).find((x) => x.actor === c.actor);
      if (h && h.b64) content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: h.b64 } });
    }
    cached(content[content.length - 1]);
  }
  const blocks = subtitleBlocks(seen, now);
  blocks.forEach((b, i) => {
    content.push({ type: "text", text: b.text });
    if (b.ended && !(blocks[i + 1] && blocks[i + 1].ended)) cached(content[content.length - 1]);
  });
  if (!seen.length) content.push({ type: "text", text: "No subtitles are available, so go by the frame alone." });
  const registry = characterRegistry(cues, cast, now);
  content.push({ type: "text", text: `Characters established so far (from the subtitles up to ${stamp(now)}):\n` +
    (registry.length ? registryText(registry) : "none yet") });
  content.push({ type: "text", text: `Current position: ${stamp(now)}` });
  if (frameB64) content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: frameB64 } });
  if (!xray && history && history.length) {
    content.push({ type: "text", text: `Earlier in this chat:\n${history.map((h) => `Q: ${h.q}\nA: ${h.a}`).join("\n\n")}` });
  }
  content.push({ type: "text", text: xray ? "X-Ray: who is in this scene?" : question });
  const openrouter = provider === "openrouter";
  const output_config = xray ? { effort, format: { type: "json_schema", schema: XRAY_SCHEMA } } : { effort };
  const body = { model: openrouter ? openRouterModel(model) : model, max_tokens: 16000, output_config,
                 system: SYSTEM, messages: [{ role: "user", content }] };
  const headers = { "content-type": "application/json", "anthropic-version": "2023-06-01" };
  if (!openrouter && FALLBACK_MODELS.includes(model)) {
    body.fallbacks = "default";
    headers["anthropic-beta"] = "server-side-fallback-2026-07-01";
  }
  return { url: PROVIDERS[openrouter ? "openrouter" : "anthropic"].url, body, headers, registry,
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

// --- the X-Ray ---------------------------------------------------------------------------------

// The model's X-Ray JSON, with what comes from data rather than the model: the actor's photo, when
// the character was first heard or named (from the registry, so never after `now`), and which of
// the cited times are real lines. People in the frame first, then those speaking.
const xrayPeople = (out, registry, heads, cues, now) => ((out && out.people) || [])
  .map((p) => {
    const known = (registry || []).find((r) => r.character === p.character || (p.actor && r.actor === p.actor));
    const head = p.actor && (heads || []).find((h) => h.actor === p.actor);
    const firstSeen = known && known.firstSeen <= now ? known.firstSeen : null;
    return Object.assign({}, p, {
      photo: head ? head.b64 : "",
      firstSeen, firstAt: firstSeen == null ? "" : stamp(firstSeen),
      citations: citationsIn(p.known_so_far, cues, now),
    });
  })
  .sort((a, b) => Number(b.in_frame) - Number(a.in_frame) || Number(b.speaking_recently) - Number(a.speaking_recently));

// USD per million tokens: input, output, cache read (claude-api reference, cached 2026-10-06).
// Cache writes (5-minute) cost 1.25x input.
const PRICES = {
  "claude-opus-5-5": [4, 20, 0.2],
  "claude-sonnet-5-5": [2, 10, 0.2],
  "claude-haiku-5-5": [0.1, 0.5, 0.01],
  "claude-fable-5-1": [10, 50, 0.25],
};
// OpenRouter reports what it charged (`usage.cost`); otherwise the list price.
const costUSD = (model, usage) => {
  if (usage && typeof usage.cost === "number") return usage.cost;
  const p = PRICES[model];
  if (!p || !usage) return null;
  return ((usage.input_tokens || 0) * p[0] + (usage.output_tokens || 0) * p[1] +
          (usage.cache_creation_input_tokens || 0) * p[0] * 1.25 + (usage.cache_read_input_tokens || 0) * p[2]) / 1e6;
};

const answerText = (data) => ((data && data.content) || [])
  .filter((b) => b.type === "text").map((b) => b.text).join("").trim();

module.exports = {
  parseSubs, cuesUpTo, speakerLabelCount, pickContextTrack, stamp, transcriptOf, parseRmsLevels, speechLag, agreedLag,
  cueShift, shiftCues, positionNow, tvReading, titleFromPath, castFromWikitext, namesOf,
  unseenCastMentions, characterRegistry, registryText, subtitleBlocks, buildRequest, XRAY_SCHEMA, xrayPeople, PROVIDERS, openRouterModel, providerOfKey, citationsIn, parseStamp, costUSD, answerText, PRICES, SYSTEM,
};
