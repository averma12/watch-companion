// Watch Companion: ask about the scene you're watching. Runs once per player window.
const { core, mpv, event, file, utils, http, sidebar, menu, preferences, console } = iina;
const ctx = require("./lib/context.js");

const KC_SERVICE = "anthropic";
const KC_NAME = "api-key";
const FFMPEG = ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"];
const TEXT_SUB_CODECS = ["subrip", "srt", "mov_text", "ass", "ssa", "webvtt", "text"];
const HISTORY = 3;  // earlier Q/A pairs sent with a follow-up

const state = { path: null, film: null, cues: [], subsFrom: "", cast: [], busy: false, history: [], lastResult: null,
                furthest: 0, returnTo: null };

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// Code after `await http.*` runs on the URL session thread; AppKit UI calls from there crash IINA
// (docs/DESIGN.md). Hop back with a timer before touching the sidebar, OSD or window.
const toMain = () => wait(0);
const log = (...a) => console.log("[watch-companion]", ...a);
const toSidebar = (name, data) => { try { sidebar.postMessage(name, data); } catch (e) { log("postMessage", e); } };
// Where the viewer is (lib/context.js, "position"). In IINA it is mpv's clock.
const iinaPosition = { name: "iina", label: "IINA", now: () => ({ seconds: mpv.getNumber("time-pos") || 0 }) };
const position = iinaPosition;

const status = () => toSidebar("status", {
  film: state.film ? `${state.film.title}${state.film.year ? ` (${state.film.year})` : ""}` : "",
  subs: state.cues.length ? `${state.cues.length} subtitle lines (${state.subsFrom})` : state.subsFrom || "no subtitles yet",
  cast: state.cast.length ? `${state.cast.length} cast names` : "no cast list",
  position: `position from ${position.label}`,
});
const safeName = (s) => s.replace(/[^\w.-]+/g, "_").slice(0, 120);

// --- API key: Keychain only -------------------------------------------------------------------

const readKeyFromEnvFile = (path) => {
  const line = (file.read(path) || "").split("\n").find((l) => /^\s*(export\s+)?ANTHROPIC_API_KEY\s*=/.test(l));
  return line ? line.split("=").slice(1).join("=").trim().replace(/^["']|["']$/g, "") : "";
};

const apiKey = () => {
  let key = utils.keychainRead(KC_SERVICE, KC_NAME);
  if (key) return key;
  const importPath = preferences.get("key_import_path");
  if (importPath && file.exists(importPath)) key = readKeyFromEnvFile(importPath);
  if (!key) key = (utils.prompt("Paste your Anthropic API key. It is stored in the macOS Keychain.") || "").trim();
  if (key) utils.keychainWrite(KC_SERVICE, KC_NAME, key);
  return key;
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
  const labels = ctx.speakerLabelCount(pick.cues);
  state.subsFrom = `${trackLabel(pick.track)}${labels >= 10 ? ", with speaker names" : ""}`;
  log("subtitles", candidates.map((c) => `${c.id}: ${c.cues.length} lines, ${ctx.speakerLabelCount(c.cues)} labels`).join("; "),
    "->", pick.id, `${Date.now() - t0} ms`);
};

// --- cast from Wikipedia --------------------------------------------------------------------

const wikiGet = async (params) => {
  const q = Object.keys(params).map((k) => `${k}=${encodeURIComponent(params[k])}`).join("&");
  const r = await http.get(`https://en.wikipedia.org/w/api.php?${q}&format=json&formatversion=2`,
    { headers: { "User-Agent": "watch-companion/0.1 (https://github.com/averma12/watch-companion)" } });
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

// --- the current frame ----------------------------------------------------------------------

const currentFrameB64 = async () => {
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

const ask = async (question) => {
  question = (question || "").trim();
  if (!question || state.busy) return null;
  state.busy = true;
  try {
    // One reading per question: the cutoff, the citations and the seek clamp all use this `now`.
    const now = await ctx.positionNow(position);
    await toMain();  // a source may use http
    toSidebar("thinking", { question, at: ctx.stamp(now) });
    const key = apiKey();
    if (!key) throw new Error("No API key. Set one in the plugin's preferences.");
    const model = preferences.get("model");
    const frameB64 = preferences.get("send_frame") ? await currentFrameB64() : "";
    const req = ctx.buildRequest({ model, effort: preferences.get("effort"), film: state.film, cast: state.cast,
      cues: state.cues, now, frameB64, question, history: state.history.slice(-HISTORY) });
    const t0 = Date.now();
    const r = await http.post("https://api.anthropic.com/v1/messages",
      { headers: Object.assign({ "x-api-key": key }, req.headers), data: req.body });
    const ms = Date.now() - t0;
    await toMain();
    const d = typeof r.data === "string" ? JSON.parse(r.data || "{}") : (r.data || {});
    if (r.statusCode !== 200) throw new Error((d.error && d.error.message) || `HTTP ${r.statusCode}`);
    if (d.stop_reason === "refusal") throw new Error("Claude declined to answer this one.");
    const text = ctx.answerText(d).replace(/\*\*([^*]+)\*\*/g, "$1");
    const flagged = ctx.unseenCastMentions(text, state.cast, req.transcript, question);
    const citations = ctx.citationsIn(text, state.cues, now);
    state.furthest = Math.max(state.furthest, now);
    const result = { question, at: ctx.stamp(now), now, text, flagged, citations, ms, model: d.model,
      cost: ctx.costUSD(model, d.usage), usage: d.usage, cues: req.cueCount, frame: !!frameB64 };
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

// --- wiring -----------------------------------------------------------------------------------

event.on("iina.window-loaded", () => {
  sidebar.loadFile("sidebar.html");
  sidebar.onMessage("ready", () => status());
  sidebar.onMessage("ask", (d) => { ask(d && d.question); });
  // Clicking a citation jumps back to that subtitle line; "back" returns to where the viewer was.
  // Never seek past the furthest point the viewer has asked from (no spoilers by seeking).
  sidebar.onMessage("seek", (d) => {
    if (!d || typeof d.t !== "number") return;
    if (d.back) {
      if (state.returnTo == null) return;
      core.seekTo(state.returnTo);
      state.returnTo = null;
      toSidebar("seeked", { back: true });
      return;
    }
    const t = Math.min(d.t, state.furthest);
    if (state.returnTo == null) state.returnTo = mpv.getNumber("time-pos") || state.furthest;
    core.seekTo(Math.max(0, t - 1));
    toSidebar("seeked", { to: ctx.stamp(t), returnTo: ctx.stamp(state.returnTo) });
  });
});

menu.addItem(menu.item("Ask about this scene…", () => {
  sidebar.show();
  toSidebar("focus", {});
}, { keyBinding: "Meta+k" }));

event.on("mpv.file-loaded", async () => {
  state.path = mpv.getString("path");
  state.film = ctx.titleFromPath(state.path);
  state.cues = []; state.cast = []; state.history = []; state.subsFrom = "";
  status();
  await wait(1500);  // let mpv add external subtitle tracks
  try { await loadSubtitles(); } catch (e) { state.subsFrom = "couldn't read subtitles"; log("subs", e); }
  await toMain(); status();
  try { await loadCast(); } catch (e) { log("cast", e); }
  await toMain(); status();
  devAutoAsk();
});

// Development hook: if @data/autoask.json exists ({"at": seconds, "questions": [...],
// "viaSidebar": true}), seek there, ask each question, write @data/autoask-result.json, then
// delete the request file. With viaSidebar the sidebar fills its own input box and submits the
// form, the same path as a person pressing Enter. It lets a test run without typing.
const devAutoAsk = async () => {
  if (!file.exists("@data/autoask.json")) return;
  const job = JSON.parse(file.read("@data/autoask.json") || "{}");
  try { file.delete("@data/autoask.json"); } catch (e) { file.write("@data/autoask.json", "{}"); }
  core.pause();
  if (job.at) { core.seekTo(job.at); await wait(2500); }
  const results = { started: new Date().toISOString(), viaSidebar: !!job.viaSidebar, film: state.film,
    subsFrom: state.subsFrom, cueCount: state.cues.length, cast: state.cast, answers: [] };
  if (job.viaSidebar) { sidebar.show(); await wait(1500); }
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
