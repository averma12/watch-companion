// Watch Companion: ask about the scene you're watching. Runs once per player window.
const { core, mpv, event, file, utils, http, sidebar, menu, preferences, console } = iina;
const ctx = require("./lib/context.js");

// Keychain service per provider (the Anthropic one keeps its 0.1 name), and the env-file name.
const KC_SERVICE = { anthropic: "anthropic", openrouter: "openrouter" };
const KC_NAME = "api-key";
const ENV_NAME = { anthropic: "ANTHROPIC_API_KEY", openrouter: "OPENROUTER_API_KEY" };
const FFMPEG = ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"];
const TEXT_SUB_CODECS = ["subrip", "srt", "mov_text", "ass", "ssa", "webvtt", "text"];
const HISTORY = 6;  // earlier Q/A pairs sent with a follow-up
const TVCAST = "http://127.0.0.1:8766/api";  // tvcast's panel API, when it casts this file to a TV
const TV_POLL_MS = 3000;
const UA = "watch-companion/0.5 (https://github.com/averma12/watch-companion)";

const state = { path: null, film: null, cues: [], subsFrom: "", subsTrack: null, subsLag: null, subsSync: "", cast: [], heads: [],
                busy: false, capturing: false, history: [], lastResult: null, furthest: 0, returnTo: null };

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// Code after `await http.*` runs on the URL session thread; AppKit UI calls from there crash IINA
// (docs/DESIGN.md). Hop back with a timer before touching the sidebar, OSD or window.
const toMain = () => wait(0);
const log = (...a) => console.log("[watch-companion]", ...a);
const toSidebar = (name, data) => { try { sidebar.postMessage(name, data); } catch (e) { log("postMessage", e); } };
// Where the viewer is (lib/context.js, "position"). In IINA it is mpv's clock; while tvcast plays
// this file on a TV, it is the TV's position.
const iinaPosition = { name: "iina", label: "IINA", now: () => ({ seconds: mpv.getNumber("time-pos") || 0 }) };
let position = iinaPosition;

const status = () => toSidebar("status", {
  film: state.film ? `${state.film.title}${state.film.year ? ` (${state.film.year})` : ""}` : "",
  subs: state.cues.length ? `${state.cues.length} subtitle lines (${state.subsFrom})` : state.subsFrom || "no subtitles yet",
  sync: state.subsSync,
  cast: state.cast.length ? `${state.cast.length} cast names${state.heads.length ? `, ${state.heads.length} photos` : ""}` : "no cast list",
  position: `position from ${position.label}`,
});
const safeName = (s) => s.replace(/[^\w.-]+/g, "_").slice(0, 120);

// --- API key: Keychain only -------------------------------------------------------------------

const readKeyFromEnvFile = (path, name) => {
  const line = (file.read(path) || "").split("\n").find((l) => new RegExp(`^\\s*(export\\s+)?${name}\\s*=`).test(l));
  return line ? line.split("=").slice(1).join("=").trim().replace(/^["']|["']$/g, "") : "";
};

// { key, provider } for this question. The "provider" preference is auto (an Anthropic key
// first, then an OpenRouter key), anthropic or openrouter. A pasted key is stored under the
// provider its prefix names.
const apiKey = () => {
  const pref = preferences.get("provider") || "auto";
  const order = pref === "auto" ? ["anthropic", "openrouter"] : [pref];
  for (const provider of order) {
    const key = utils.keychainRead(KC_SERVICE[provider], KC_NAME);
    if (key) return { key, provider };
  }
  const importPath = preferences.get("key_import_path");
  if (importPath && file.exists(importPath)) {
    for (const provider of order) {
      const key = readKeyFromEnvFile(importPath, ENV_NAME[provider]);
      if (key) { utils.keychainWrite(KC_SERVICE[provider], KC_NAME, key); return { key, provider }; }
    }
  }
  const key = (utils.prompt("Paste your Anthropic or OpenRouter API key. It is stored in the macOS Keychain.") || "").trim();
  if (!key) return null;
  const provider = ctx.providerOfKey(key);
  utils.keychainWrite(KC_SERVICE[provider], KC_NAME, key);
  return { key, provider };
};

// --- the TV, through tvcast -----------------------------------------------------------------

const tvStatus = async () => {
  try {
    const r = await http.get(`${TVCAST}/status`);
    if (r.statusCode !== 200) return null;
    return typeof r.data === "string" ? JSON.parse(r.data || "{}") : r.data;
  } catch (e) {
    return null;  // tvcast isn't running
  }
};

// The source for this moment: the TV while it plays (or is paused on) this file, else IINA. The
// TV source carries the one reading taken here. Switching to the TV pauses and mutes IINA once;
// the viewer watches the TV, and IINA only supplies frames.
const choosePosition = async () => {
  const reading = state.path ? ctx.tvReading(await tvStatus(), state.path) : null;
  await toMain();
  const next = reading ? { name: "tv", label: "TV", now: () => reading } : iinaPosition;
  const switched = next.name !== position.name;
  position = next;
  if (switched) {
    if (next.name === "tv") { core.pause(); mpv.set("mute", true); }
    log("position from", next.label);
    status();
  }
  return position;
};

const tvSeek = async (seconds) => {
  // Without the JSON content type IINA form-encodes `data`, and tvcast answers 400.
  const r = await http.post(`${TVCAST}/seek`, { headers: { "Content-Type": "application/json", "X-TVCast": "1" },
    data: { seconds: Math.round(seconds) } });
  await toMain();
  if (r.statusCode !== 200) log("tv seek", r.statusCode, r.data);
};

// Keeps the sidebar's "position from …" current and, while the film plays on the TV, keeps IINA
// (paused, muted) on the TV's scene, so the Mac shows what the TV shows.
const pollTv = async () => {
  try {
    // Paused only while a question's frame is taken, so IINA stays on the TV's scene meanwhile.
    if (!state.capturing) {
      const source = await choosePosition();
      if (source.name === "tv" && !state.capturing) followTv(source.now().seconds);
    }
  } catch (e) { log("tv poll", e); }
  setTimeout(pollTv, TV_POLL_MS);
};

// --- subtitles ------------------------------------------------------------------------------

const ffmpegPath = () => FFMPEG.find((p) => file.exists(p));

const subTracks = () => (mpv.getNative("track-list") || []).filter((t) => t.type === "sub");

const trackLabel = (t) => `${t.external ? "file" : "embedded"} track ${t.id}${t.lang ? `, ${t.lang}` : ""}`;
const isText = (t) => t.external || TEXT_SUB_CODECS.includes(t.codec);

// One subtitle track as cues. SubRip/WebVTT files are read directly; other formats and tracks
// inside the video go through ffmpeg once and are cached in @data.
const readTrack = async (t) => {
  const ext = t.external ? t["external-filename"].split(".").pop().toLowerCase() : "";
  if (t.external && (ext === "srt" || ext === "vtt")) return ctx.parseSubs(file.read(t["external-filename"]) || "");
  const cache = `@data/subs-${safeName(state.path.split("/").pop())}-${t.id}.srt`;
  if (file.exists(cache)) return ctx.parseSubs(file.read(cache) || "");
  const ff = ffmpegPath();
  if (!ff) return [];
  const input = t.external ? t["external-filename"] : state.path;
  const map = t.external ? "0:s:0" : `0:${t["ff-index"]}`;
  const r = await utils.exec(ff, ["-v", "error", "-i", input, "-map", map, "-f", "srt", "pipe:1"]);
  if (r.status !== 0 || !r.stdout) { log("ffmpeg", trackLabel(t), r.status, r.stderr); return []; }
  file.write(cache, r.stdout);
  return ctx.parseSubs(r.stdout);
};

// The track shown on screen isn't always the best context: an SDH track in the same language
// names the speakers. Read every text track in the viewer's language and keep the one with
// speaker names (docs/DESIGN.md, "Subtitles: speaker names matter").
const loadSubtitles = async () => {
  const tracks = subTracks().filter(isText);
  if (!tracks.length) { state.cues = []; state.subsFrom = "no text subtitles in this file"; return; }
  const selected = tracks.find((t) => t.selected);
  const lang = (selected && selected.lang) || "eng";
  const sameLang = (t) => !t.lang || t.lang === lang || (/^en/i.test(lang) && /^en/i.test(t.lang));
  const pool = (tracks.filter(sameLang).length ? tracks.filter(sameLang) : tracks).slice(0, 6);
  state.subsFrom = `reading ${pool.length} subtitle track${pool.length > 1 ? "s" : ""}…`;
  await toMain(); status();
  const t0 = Date.now();
  const candidates = [];
  for (const t of pool) candidates.push({ id: t.id, track: t, selected: !!t.selected, cues: await readTrack(t) });
  const pick = ctx.pickContextTrack(candidates);
  if (!pick) { state.cues = []; state.subsFrom = "couldn't read the subtitles"; return; }
  state.cues = pick.cues;
  state.subsTrack = pick.track;
  const labels = ctx.speakerLabelCount(pick.cues);
  state.subsFrom = `${trackLabel(pick.track)}${labels >= 10 ? ", with speaker names" : ""}`;
  log("subtitles", candidates.map((c) => `${c.id}: ${c.cues.length} lines, ${ctx.speakerLabelCount(c.cues)} labels`).join("; "),
    "->", pick.id, `${Date.now() - t0} ms`);
};

// Is the subtitle track in time with the audio? (lib/context.js, "subtitle timing"). Three windows
// of up to 5 minutes each, about 4 s of ffmpeg on an M-series Mac, cached per subtitle and audio
// track.
const SYNC_WINDOW = 300;

// `fresh` skips the cache in both directions (the dev hook's shifted subtitles must not be cached).
const checkSubtitleSync = async (fresh) => {
  state.subsLag = null; state.subsSync = "";
  const ff = ffmpegPath();
  const duration = mpv.getNumber("duration") || 0;
  if (!ff || !state.cues.length || !state.subsTrack || duration < 60) return;
  const audio = (mpv.getNative("track-list") || []).find((t) => t.type === "audio" && t.selected);
  if (!audio) return;
  const cache = `@data/sync-${safeName(state.path.split("/").pop())}-${state.subsTrack.id}-${audio.id}.json`;
  let lag;
  if (!fresh && file.exists(cache)) {
    lag = JSON.parse(file.read(cache) || "{}").lag;
  } else {
    state.subsSync = "checking subtitle timing…"; await toMain(); status();
    // Dialogue sits in the centre channel of 5.1/7.1; otherwise listen to the downmix.
    const mono = (audio["demux-channel-count"] || 0) >= 3 ? "pan=mono|c0=FC" : "aformat=channel_layouts=mono";
    const af = `${mono},highpass=f=300,lowpass=f=3000,aresample=16000,asetnsamples=n=800,` +
      "astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-";
    const win = Math.min(SYNC_WINDOW, duration / 4);
    const lags = [];
    const t0 = Date.now();
    for (const at of [0.2, 0.5, 0.8]) {
      const from = Math.round(duration * at);
      const r = await utils.exec(ff, ["-v", "error", "-ss", String(from), "-t", String(win), "-i", state.path,
        "-map", `0:${audio["ff-index"]}`, "-vn", "-af", af, "-f", "null", "-"]);
      if (r.status !== 0) { log("sync ffmpeg", r.status, r.stderr); continue; }
      lags.push(ctx.speechLag(ctx.parseRmsLevels(r.stdout), state.cues, from));
    }
    lag = ctx.agreedLag(lags);
    log("subtitle timing", JSON.stringify(lags), "->", lag, `${Date.now() - t0} ms`);
    if (!fresh) file.write(cache, JSON.stringify({ lag, lags }));
  }
  state.subsLag = lag;
  const s = lag == null ? 0 : Math.abs(lag).toFixed(1);
  state.subsSync = lag == null ? "couldn't check subtitle timing"
    : ctx.cueShift({ lag }) ? `subtitles ${s} s early, moved later`
    : lag > 1 ? `subtitles ${s} s late (answers may miss the last lines; set a subtitle delay in IINA)`
    : "subtitles in time with the audio";
};

// --- cast from Wikipedia --------------------------------------------------------------------

const wikiGet = async (params) => {
  const q = Object.keys(params).map((k) => `${k}=${encodeURIComponent(params[k])}`).join("&");
  const r = await http.get(`https://en.wikipedia.org/w/api.php?${q}&format=json&formatversion=2`,
    { headers: { "User-Agent": UA } });
  return typeof r.data === "string" ? JSON.parse(r.data) : r.data;
};

const loadCast = async () => {
  state.cast = [];
  if (!preferences.get("fetch_cast") || !state.film || !state.film.title) return;
  const cache = `@data/cast-${safeName(`${state.film.title}-${state.film.year}`)}.json`;
  if (file.exists(cache)) { state.cast = JSON.parse(file.read(cache) || "[]"); return; }
  const found = await wikiGet({ action: "query", list: "search", srlimit: 1,
    srsearch: `${state.film.title} ${state.film.year} ${state.film.year ? "film" : ""}`.trim() });
  const hit = found && found.query && found.query.search[0];
  if (!hit) return;
  const secs = await wikiGet({ action: "parse", page: hit.title, prop: "sections" });
  const section = ((secs.parse && secs.parse.sections) || []).find((s) => /^cast( and characters)?$/i.test(s.line));
  if (!section) return;
  const wt = await wikiGet({ action: "parse", page: hit.title, prop: "wikitext", section: section.index });
  state.cast = ctx.castFromWikitext(wt.parse && wt.parse.wikitext);
  file.write(cache, JSON.stringify(state.cast));
  log("cast from", hit.title, state.cast.length);
};

// --- actors' photos ---------------------------------------------------------------------------

// The lead image of each actor's Wikipedia article (256 px), cached in @data. The model compares
// faces in the frame with them, and the X-Ray shows them. iina.http hands back text, so the JPEG
// itself is fetched with curl, and only from wikimedia.org.
const headFile = (actor) => `@data/head-${safeName(actor)}.jpg`;

const loadHeads = async () => {
  state.heads = [];
  if (!preferences.get("fetch_cast") || !state.cast.length) return;
  const missing = state.cast.filter((c) => !file.exists(headFile(c.actor)) && !file.exists(`${headFile(c.actor)}.none`));
  if (missing.length) {
    const d = await wikiGet({ action: "query", prop: "pageimages|pageprops", piprop: "thumbnail", pithumbsize: 256,
      redirects: 1, titles: missing.map((c) => c.actor).join("|") });
    const q = (d && d.query) || {};
    const finalTitle = (t) => {
      for (const k of ["normalized", "redirects"]) for (const m of q[k] || []) if (m.from === t) t = m.to;
      return t;
    };
    for (const c of missing) {
      const page = (q.pages || []).find((pg) => pg.title === finalTitle(c.actor));
      const src = page && !(page.pageprops && "disambiguation" in page.pageprops) && page.thumbnail && page.thumbnail.source;
      if (src && /^https:\/\/[\w.-]+\.wikimedia\.org\//.test(src)) {
        const r = await utils.exec("/usr/bin/curl", ["-fsSL", "--max-time", "15", "-A", UA, "-o", utils.resolvePath(headFile(c.actor)), src]);
        if (r.status !== 0) log("photo", c.actor, r.status, r.stderr);
      } else {
        file.write(`${headFile(c.actor)}.none`, "");  // no photo on Wikipedia; don't ask again
      }
    }
  }
  for (const c of state.cast) {
    if (!file.exists(headFile(c.actor))) continue;
    const b = await utils.exec("/usr/bin/base64", ["-i", utils.resolvePath(headFile(c.actor))]);
    if (b.status === 0 && b.stdout) state.heads.push({ actor: c.actor, b64: b.stdout.replace(/\s+/g, "") });
  }
  log("photos", state.heads.length, "of", state.cast.length);
};

// --- the current frame ----------------------------------------------------------------------

// The frame at `seconds`. When the film plays on the TV, IINA (paused) first moves to the TV's
// position, exactly, so the frame is the one on the TV.
const seekIinaTo = async (seconds) => {
  const off = () => Math.abs((mpv.getNumber("time-pos") || 0) - seconds);
  if (off() < 0.5) return;
  mpv.command("seek", [String(seconds), "absolute+exact"]);
  for (let i = 0; i < 60 && (mpv.getFlag("seeking") || off() >= 0.5); i++) await wait(50);
};

const followTv = (seconds) => {
  if (Math.abs((mpv.getNumber("time-pos") || 0) - seconds) > 2) mpv.command("seek", [String(seconds), "absolute+exact"]);
};

const currentFrameB64 = async (seconds) => {
  state.capturing = true;
  try { return await frameAt(seconds); } finally { state.capturing = false; }
};

const frameAt = async (seconds) => {
  if (position.name === "tv") await seekIinaTo(seconds);
  const png = utils.resolvePath("@data/frame.png");
  const jpg = utils.resolvePath("@data/frame.jpg");
  // mpv's screenshot is already tone-mapped for HDR; sips makes a 768 px JPEG.
  mpv.command("screenshot-to-file", [png, "video"]);
  const s = await utils.exec("/usr/bin/sips", ["-s", "format", "jpeg", "-s", "formatOptions", "80", "-Z", "768", png, "--out", jpg]);
  if (s.status !== 0) return "";
  const b = await utils.exec("/usr/bin/base64", ["-i", jpg]);
  return (b.stdout || "").replace(/\s+/g, "");
};

// --- asking -----------------------------------------------------------------------------------

// One call to the model at the viewer's position, for a question ("ask") or the X-Ray ("xray").
// Everything it sends is built by ctx.buildRequest, so both have the same spoiler fence.
const callModel = async (mode, question, onStart) => {
  // One reading per call: the cutoff, the citations and the seek clamp all use this `now`.
  const source = await choosePosition();
  const now = await ctx.positionNow(source);
  await toMain();  // a source may use http
  onStart(now);
  const auth = apiKey();
  if (!auth) throw new Error("No API key. Paste an Anthropic or OpenRouter key, or set an env file in the plugin's preferences.");
  const model = preferences.get("model");
  const frameB64 = preferences.get("send_frame") ? await currentFrameB64(now) : "";
  // Lines count from when they were on screen: the viewer's subtitle delay and a measured early
  // track both move them later, never earlier.
  const shift = ctx.cueShift({ subDelay: mpv.getNumber("sub-delay"), lag: state.subsLag });
  const cues = ctx.shiftCues(state.cues, shift);
  const req = ctx.buildRequest({ model, effort: preferences.get("effort"), film: state.film, cast: state.cast,
    heads: state.heads, cues, now, frameB64, question, history: mode === "ask" ? state.history.slice(-HISTORY) : [],
    provider: auth.provider, mode });
  const t0 = Date.now();
  const r = await http.post(req.url,
    { headers: Object.assign(ctx.PROVIDERS[auth.provider].auth(auth.key), req.headers), data: req.body });
  const ms = Date.now() - t0;
  await toMain();
  const d = typeof r.data === "string" ? JSON.parse(r.data || "{}") : (r.data || {});
  if (r.statusCode !== 200) throw new Error((d.error && d.error.message) || `HTTP ${r.statusCode}`);
  if (d.stop_reason === "refusal") throw new Error("Claude declined to answer this one.");
  state.furthest = Math.max(state.furthest, now);
  return { now, cues, req, d, ms, meta: { ms, model: d.model, cost: ctx.costUSD(model, d.usage), usage: d.usage,
    cues: req.cueCount, shift, frame: !!frameB64, source: source.name, provider: auth.provider } };
};

const ask = async (question) => {
  question = (question || "").trim();
  if (!question || state.busy) return null;
  state.busy = true;
  try {
    const c = await callModel("ask", question, (now) => toSidebar("thinking", { question, at: ctx.stamp(now) }));
    const text = ctx.answerText(c.d).replace(/\*\*([^*]+)\*\*/g, "$1");
    const flagged = ctx.unseenCastMentions(text, state.cast, c.req.transcript, question);
    const citations = ctx.citationsIn(text, c.cues, c.now);
    const result = Object.assign({ question, at: ctx.stamp(c.now), now: c.now, text, flagged, citations }, c.meta);
    state.history.push({ q: question, a: text });
    toSidebar("answer", result);
    state.lastResult = result;
    return result;
  } catch (e) {
    await toMain();
    toSidebar("error", { question, message: String(e.message || e) });
    state.lastResult = { question, error: String(e.message || e) };
    return state.lastResult;
  } finally {
    state.busy = false;
  }
};

// Who is in this scene: actor, character, a photo, when the film first showed them and what it
// has shown about them so far.
const xray = async () => {
  if (state.busy) return null;
  state.busy = true;
  try {
    const c = await callModel("xray", "", (now) => toSidebar("xray-thinking", { at: ctx.stamp(now) }));
    let out;
    try { out = JSON.parse(ctx.answerText(c.d)); } catch (e) { throw new Error("The X-Ray answer came back incomplete; try again."); }
    const result = Object.assign({ at: ctx.stamp(c.now), now: c.now, scene: out.scene || "",
      people: ctx.xrayPeople(out, c.req.registry, state.heads, c.cues, c.now) }, c.meta);
    toSidebar("xray", result);
    state.lastXray = result;
    return result;
  } catch (e) {
    await toMain();
    toSidebar("error", { message: String(e.message || e) });
    state.lastXray = { error: String(e.message || e) };
    return state.lastXray;
  } finally {
    state.busy = false;
  }
};

// --- wiring -----------------------------------------------------------------------------------

event.on("iina.window-loaded", () => {
  sidebar.loadFile("sidebar.html");
  sidebar.onMessage("ready", () => status());
  sidebar.onMessage("ask", (d) => { ask(d && d.question); });
  sidebar.onMessage("xray", () => { xray(); });
  // Clicking a citation jumps back to that subtitle line, on the TV when the film plays there;
  // "back" returns to where the viewer was. Never seek past the furthest point the viewer has
  // asked from (no spoilers by seeking).
  const seekTo = (t) => (position.name === "tv" ? tvSeek(t) : core.seekTo(t));
  sidebar.onMessage("seek", async (d) => {
    if (!d || typeof d.t !== "number") return;
    if (d.back) {
      if (state.returnTo == null) return;
      await seekTo(state.returnTo);
      state.returnTo = null;
      toSidebar("seeked", { back: true });
      return;
    }
    const t = Math.min(d.t, state.furthest);
    if (state.returnTo == null) {
      const reading = await (await choosePosition()).now();
      state.returnTo = (reading && reading.seconds) || state.furthest;
    }
    await seekTo(Math.max(0, t - 1));
    toSidebar("seeked", { to: ctx.stamp(t), returnTo: ctx.stamp(state.returnTo) });
  });
  setTimeout(pollTv, TV_POLL_MS);
});

menu.addItem(menu.item("Ask about this scene…", () => {
  sidebar.show();
  toSidebar("focus", {});
}, { keyBinding: "Meta+k" }));
menu.addItem(menu.item("X-Ray: who's in this scene", () => {
  sidebar.show();
  xray();
}));

event.on("mpv.file-loaded", async () => {
  state.path = mpv.getString("path");
  state.film = ctx.titleFromPath(state.path);
  state.cues = []; state.cast = []; state.heads = []; state.history = []; state.subsFrom = ""; state.subsTrack = null;
  state.subsLag = null; state.subsSync = ""; position = iinaPosition;
  status();
  await wait(1500);  // let mpv add external subtitle tracks
  try { await loadSubtitles(); } catch (e) { state.subsFrom = "couldn't read subtitles"; log("subs", e); }
  await toMain(); status();
  try { await loadCast(); } catch (e) { log("cast", e); }
  await toMain(); status();
  try { await loadHeads(); } catch (e) { log("photos", e); }
  await toMain(); status();
  try { await checkSubtitleSync(); } catch (e) { state.subsSync = ""; log("sync", e); }
  await toMain(); status();
  devAutoAsk();
});

// Development hook: if @data/autoask.json exists, run it once and delete it, so a test runs without
// typing. Fields: "frames": [seconds] saves the frame a question would send at each time as
// @data/frame-<seconds>.jpg; "subsShift": seconds moves the subtitles and checks their timing again
// (to test the early/late handling); "at": seconds seeks there; "questions": [...] asks each one;
// "xray": true runs the X-Ray. With "viaSidebar" the sidebar fills its input box and submits, or
// presses its X-Ray button, as a person would. Results go to @data/autoask-result.json.
const devAutoAsk = async () => {
  if (!file.exists("@data/autoask.json")) return;
  const job = JSON.parse(file.read("@data/autoask.json") || "{}");
  try { file.delete("@data/autoask.json"); } catch (e) { file.write("@data/autoask.json", "{}"); }
  core.pause();
  for (const t of job.frames || []) {
    core.seekTo(t); await wait(2500);
    const b64 = await currentFrameB64(t);
    if (b64) utils.exec("/bin/cp", [utils.resolvePath("@data/frame.jpg"), utils.resolvePath(`@data/frame-${t}.jpg`)]);
    await wait(300);
  }
  if (job.subsShift) {
    state.cues = ctx.shiftCues(state.cues, job.subsShift);
    await checkSubtitleSync(true);
    await toMain(); status();
  }
  if (job.at) { core.seekTo(job.at); await wait(2500); }
  const results = { started: new Date().toISOString(), viaSidebar: !!job.viaSidebar, film: state.film,
    subsFrom: state.subsFrom, subsSync: state.subsSync, subsLag: state.subsLag, cueCount: state.cues.length, cast: state.cast, answers: [] };
  if (job.viaSidebar) { sidebar.show(); await wait(1500); }
  if (job.xray) {
    state.lastXray = null;
    if (job.viaSidebar) toSidebar("dev-xray", {}); else await xray();
    for (let i = 0; i < 120 && !state.lastXray; i++) await wait(500);
    results.xray = state.lastXray || { error: "no X-Ray within 60 s" };
    file.write("@data/autoask-result.json", JSON.stringify(results, null, 2));
  }
  for (const q of job.questions || []) {
    if (job.viaSidebar) {
      state.lastResult = null;
      toSidebar("dev-submit", { question: q });
      for (let i = 0; i < 120 && !state.lastResult; i++) await wait(500);
      results.answers.push(state.lastResult || { question: q, error: "no answer within 60 s" });
    } else {
      results.answers.push(await ask(q));
      await toMain();
    }
    file.write("@data/autoask-result.json", JSON.stringify(results, null, 2));
  }
  results.done = true;
  file.write("@data/autoask-result.json", JSON.stringify(results, null, 2));
};
