// Run with: node --test iina-plugin/test/
const test = require("node:test");
const assert = require("node:assert/strict");
const ctx = require("../watch-companion.iinaplugin/lib/context.js");

const SRT = `1
00:00:05,000 --> 00:00:07,000
<i>Hi. My name is Nora Vance.</i>

2
00:01:00,500 --> 00:01:02,000
TJ, wait!

3
00:10:00,000 --> 00:10:02,000
Owen Hale is the Warden.

4
00:12:00,000 --> 00:12:03,000
A later line nobody has heard yet.
`;

const CAST = [
  { actor: "Ada Reyes", character: "Nora Vance / Kestrel" },
  { actor: "Sam Lee", character: "Theodore \"TJ\" Okafor" },
  { actor: "Ravi Menon", character: "Owen Hale / Warden" },
  { actor: "Lena Cho", character: "May Vance" },
];

test("parseSubs reads SubRip and strips tags", () => {
  const cues = ctx.parseSubs(SRT);
  assert.equal(cues.length, 4);
  assert.deepEqual(cues[0], { start: 5, end: 7, text: "Hi. My name is Nora Vance." });
  assert.equal(cues[1].start, 60.5);
});

test("parseSubs reads WebVTT", () => {
  const cues = ctx.parseSubs("WEBVTT\n\n00:01.000 --> 00:02.500 align:start\n<v Nora>Hello</v>\n\n01:00:00.000 --> 01:00:01.000\nBye\n");
  assert.deepEqual(cues.map((c) => [c.start, c.end, c.text]), [[1, 2.5, "Hello"], [3600, 3601, "Bye"]]);
});

test("spoiler guard: the request holds no line that starts after now", () => {
  const cues = ctx.parseSubs(SRT);
  const now = 61;
  const { body, cueCount } = ctx.buildRequest({ model: "claude-opus-5-5", effort: "low", film: { title: "X", year: "2026" },
    cast: CAST, cues, now, frameB64: "AAAA", question: "Who is this?", history: [] });
  const sent = JSON.stringify(body);
  assert.equal(cueCount, 2);
  assert.ok(sent.includes("TJ, wait!"));
  assert.ok(!sent.includes("Owen Hale is the Warden."));
  assert.ok(!sent.includes("A later line"));
  for (const c of cues.filter((c) => c.start > now)) assert.ok(!sent.includes(c.text));
});

test("spoiler guard holds at every position", () => {
  const cues = ctx.parseSubs(SRT);
  for (let now = 0; now <= 800; now += 7.3) {
    const sent = JSON.stringify(ctx.buildRequest({ model: "claude-opus-5-5", effort: "low", cues, now, question: "?" }).body);
    for (const c of cues) assert.equal(sent.includes(c.text), c.start <= now, `${c.text} at ${now}`);
  }
});

test("a line that has started is included even before it ends", () => {
  const cues = ctx.parseSubs(SRT);
  assert.equal(ctx.cuesUpTo(cues, 6).length, 1);
  assert.equal(ctx.cuesUpTo(cues, 4.99).length, 0);
});

test("request shape: image, fallbacks only where supported", () => {
  const r = ctx.buildRequest({ model: "claude-opus-5-5", effort: "low", cues: [], now: 0, frameB64: "AAAA", question: "Q" });
  assert.equal(r.body.fallbacks, "default");
  assert.equal(r.headers["anthropic-beta"], "server-side-fallback-2026-07-01");
  assert.ok(r.body.messages[0].content.some((b) => b.type === "image"));
  const h = ctx.buildRequest({ model: "claude-haiku-5-5", effort: "low", cues: [], now: 0, question: "Q" });
  assert.equal(h.body.fallbacks, undefined);
  assert.equal(h.headers["anthropic-beta"], undefined);
  assert.ok(!h.body.messages[0].content.some((b) => b.type === "image"));
});

test("titleFromPath", () => {
  assert.deepEqual(ctx.titleFromPath("/m/Big.Buck.Bunny.2008.1080p.60fps.mp4"),
    { title: "Big Buck Bunny", year: "2008" });
  assert.deepEqual(ctx.titleFromPath("/m/Sintel.2010.720p.mkv"), { title: "Sintel", year: "2010" });
  assert.deepEqual(ctx.titleFromPath("/m/The Matrix (1999).mkv"), { title: "The Matrix", year: "1999" });
  assert.deepEqual(ctx.titleFromPath("/m/home_video.mov"), { title: "home video", year: "" });
});

test("castFromWikitext keeps names only", () => {
  const wt = "== Cast ==\n* [[Ada Reyes]] as [[Nora Vance (character)|Nora Vance / Kestrel]]:<br />A former pilot who\n" +
    "** [[Nested]] as Someone\n* [[Ann Lee]] as Bea, a nurse who dies\n" +
    "Additionally, [[Jo Park]] reprises her role as [[Mia Gray]], who was captured\n";
  assert.deepEqual(ctx.castFromWikitext(wt), [
    { actor: "Ada Reyes", character: "Nora Vance / Kestrel" },
    { actor: "Ann Lee", character: "Bea" },
  ]);
});

test("unseenCastMentions flags only cast not seen and not asked about", () => {
  const seen = ctx.transcriptOf(ctx.cuesUpTo(ctx.parseSubs(SRT), 61));
  assert.deepEqual(ctx.unseenCastMentions("That's Nora, with TJ.", CAST, seen, "who?"), []);
  assert.deepEqual(ctx.unseenCastMentions("Owen Hale shows up later.", CAST, seen, "who?"), ["Owen Hale / Warden"]);
  assert.deepEqual(ctx.unseenCastMentions("No sign of the Warden yet.", CAST, seen, "Is the Warden in this?"), []);
  // "may" as an ordinary word is not the character May Vance
  assert.deepEqual(ctx.unseenCastMentions("He may be hiding.", CAST, seen, "where?"), []);
});

test("costUSD", () => {
  assert.equal(ctx.costUSD("claude-opus-5-5", { input_tokens: 3329, output_tokens: 257 }), (3329 * 4 + 257 * 20) / 1e6);
  assert.equal(ctx.costUSD("claude-opus-5-5", { input_tokens: 800, output_tokens: 500, cache_creation_input_tokens: 16000,
    cache_read_input_tokens: 3000 }), (800 * 4 + 500 * 20 + 16000 * 5 + 3000 * 0.2) / 1e6);
  assert.equal(ctx.costUSD("unknown-model", { input_tokens: 1 }), null);
});

test("speakerLabelCount counts SDH speaker names, not ordinary lines", () => {
  const cues = ctx.parseSubs("1\n00:00:01,000 --> 00:00:02,000\nTJ: Actually, I'll take one.\n\n" +
    "2\n00:00:03,000 --> 00:00:04,000\n-[SOFTLY] NORA: Hey.\n\n" +
    "3\n00:00:05,000 --> 00:00:06,000\nDown at the end.\n\n" +
    "4\n00:00:07,000 --> 00:00:08,000\nE.V.: Scanning.\n\n" +
    "5\n00:00:09,000 --> 00:00:10,000\nTime: 5:00 sharp, OK?\n");
  assert.equal(ctx.speakerLabelCount(cues), 3);
});

test("pickContextTrack prefers the track with speaker names", () => {
  const plain = { id: 1, selected: true, cues: Array.from({ length: 50 }, (_, i) => ({ start: i, end: i + 1, text: "Hi." })) };
  const sdh = { id: 2, selected: false, cues: Array.from({ length: 50 }, (_, i) => ({ start: i, end: i + 1, text: i % 3 ? "Hi." : "TJ: Hi." })) };
  assert.equal(ctx.pickContextTrack([plain, sdh]).id, 2);
  const fewLabels = { id: 3, selected: false, cues: [{ start: 0, end: 1, text: "MAN: Hi." }] };
  assert.equal(ctx.pickContextTrack([plain, fewLabels]).id, 1);
  assert.equal(ctx.pickContextTrack([{ id: 4, cues: [] }]), null);
});

test("citationsIn validates times against the subtitles so far", () => {
  const cues = ctx.parseSubs(SRT);
  const c = ctx.citationsIn("She says hi [0:05], then TJ [1:00]. Later [10:00]. Made up [0:30]. [frame] [background]", cues, 61);
  assert.deepEqual(c.map((x) => [x.label, x.t, x.valid]), [["0:05", 5, true], ["1:00", 60, true], ["10:00", 600, false], ["0:30", 30, false]]);
  assert.equal(ctx.citationsIn("[1:02:03]", [{ start: 3723, end: 3724, text: "x" }], 4000)[0].t, 3723);
});

test("the prompt asks for citations and fences outside knowledge", () => {
  assert.match(ctx.SYSTEM, /\[22:59\]/);
  assert.match(ctx.SYSTEM, /\[background\]/);
  assert.match(ctx.SYSTEM, /Never use outside knowledge about this film's plot/);
});

// A position source as main.js builds one; `values` are what successive now() calls return.
const fakeSource = (...values) => ({ name: "fake", label: "a test clock", now: () => values.shift() });

test("positionNow reads sync and async sources", async () => {
  assert.equal(await ctx.positionNow(fakeSource({ seconds: 61 })), 61);
  assert.equal(await ctx.positionNow({ label: "async", now: async () => ({ seconds: 0 }) }), 0);
});

test("positionNow refuses a reading it can't use instead of guessing", async () => {
  for (const bad of [null, {}, { seconds: NaN }, { seconds: -1 }, { seconds: "61" }, { seconds: Infinity }]) {
    await assert.rejects(ctx.positionNow(fakeSource(bad)), /position from a test clock/, JSON.stringify(bad));
  }
});

test("spoiler guard holds for any position source", async () => {
  const cues = ctx.parseSubs(SRT);
  for (const s of [0, 4.99, 5, 61, 599.9, 600, 721, 5000]) {
    const now = await ctx.positionNow(fakeSource({ seconds: s }));
    const sent = JSON.stringify(ctx.buildRequest({ model: "claude-opus-5-5", effort: "low", cues, now, question: "?" }).body);
    assert.ok(sent.includes(`Current position: ${ctx.stamp(s)}`));
    for (const c of cues) assert.equal(sent.includes(c.text), c.start <= s, `${c.text} at ${s}`);
    for (const c of ctx.citationsIn("[10:00] [12:00]", cues, now)) assert.equal(c.valid, c.t <= s);
  }
});

// Speech energy (dB per 50 ms frame) that is loud while `speech` cues are spoken, with noise.
const fakeLevels = (speech, from, seconds, seed = 7) => {
  let x = seed;
  const rnd = () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648);
  return Array.from({ length: Math.round(seconds / 0.05) }, (_, i) => {
    const t = from + i * 0.05;
    return (speech.some((c) => c.start <= t && t < c.end) ? -25 : -45) + rnd() * 12;
  });
};
const speechCues = (from, seconds) => {
  const out = [];
  for (let t = from + 1, i = 0; t < from + seconds; i++) { const len = 1 + (i * 7 % 5) * 0.6; out.push({ start: t, end: t + len, text: `l${i}` }); t += len + 0.5 + (i * 3 % 4); }
  return out;
};

test("parseRmsLevels reads ffmpeg's ametadata output", () => {
  const out = "frame:0    pts:0       pts_time:0\nlavfi.astats.Overall.RMS_level=-27.917275\n" +
    "frame:1    pts:800     pts_time:0.05\nlavfi.astats.Overall.RMS_level=-inf\n";
  assert.deepEqual(ctx.parseRmsLevels(out), [-27.917275, -120]);
});

test("speechLag finds how far the subtitles are off", () => {
  const from = 1000, speech = speechCues(from - 40, 380);
  for (const shift of [0, 4.7, -3.2, 12]) {
    const subs = ctx.shiftCues(speech, shift);
    const r = ctx.speechLag(fakeLevels(speech, from, 300), subs, from);
    assert.ok(Math.abs(r.lag - shift) <= 0.1, `shift ${shift} -> ${r.lag}`);
  }
  assert.equal(ctx.speechLag([-30], speech, from), null);
  assert.equal(ctx.speechLag([-30, -30, -30], speech, from), null);
});

test("agreedLag needs two windows to agree", () => {
  assert.equal(ctx.agreedLag([{ lag: -0.3 }, { lag: -0.3 }, { lag: -0.2 }]), -0.3);
  assert.equal(ctx.agreedLag([{ lag: 4.7 }, null, { lag: 4.8 }]), 4.8);
  assert.equal(ctx.agreedLag([{ lag: -5 }, { lag: 2 }, { lag: 9 }]), null);
  assert.equal(ctx.agreedLag([{ lag: 1 }]), null);
});

test("cueShift moves lines later, never earlier", () => {
  assert.equal(ctx.cueShift({}), 0);
  assert.equal(ctx.cueShift({ lag: -0.3 }), 0);         // in time
  assert.equal(ctx.cueShift({ lag: -4.7 }), 4.7);       // early: move later
  assert.equal(ctx.cueShift({ lag: 4.7 }), 0);          // late: leave, never move earlier
  assert.equal(ctx.cueShift({ subDelay: 2 }), 2);       // the viewer's subtitle delay
  assert.equal(ctx.cueShift({ subDelay: -2 }), 0);
  assert.equal(ctx.cueShift({ subDelay: 2, lag: -4.7 }), 4.7);
  assert.equal(ctx.cueShift({ subDelay: NaN, lag: null }), 0);
});

test("spoiler guard with subtitles that run early", () => {
  const cues = ctx.parseSubs(SRT).map((c) => ({ ...c, start: c.start - 5, end: c.end - 5 }));  // 5 s early
  const shifted = ctx.shiftCues(cues, ctx.cueShift({ lag: -5 }));
  const sent = JSON.stringify(ctx.buildRequest({ model: "claude-opus-5-5", effort: "low", cues: shifted, now: 598, question: "?" }).body);
  assert.ok(!sent.includes("Owen Hale is the Warden."));  // spoken at 600, early file says 595
});

test("tvReading: the TV's position, only for this file while it plays or is paused", () => {
  const status = (file, state, position) => ({ now: { file }, tv: { state, position } });
  const path = "/films/Big.Buck.Bunny.2008.mkv";
  assert.deepEqual(ctx.tvReading(status("Big.Buck.Bunny.2008.mkv", "PLAYING", 2513), path), { seconds: 2513, playing: true });
  assert.deepEqual(ctx.tvReading(status("Big.Buck.Bunny.2008.mkv", "PAUSED_PLAYBACK", 61), path), { seconds: 61, playing: false });
  assert.equal(ctx.tvReading(status("Sintel.2010.mkv", "PLAYING", 61), path), null);        // another film
  assert.equal(ctx.tvReading(status("Big.Buck.Bunny.2008.mkv", "STOPPED", 0), path), null);
  assert.equal(ctx.tvReading(status("Big.Buck.Bunny.2008.mkv", "NO_MEDIA_PRESENT", 0), path), null);
  assert.equal(ctx.tvReading(status("Big.Buck.Bunny.2008.mkv", "PLAYING", null), path), null);
  assert.equal(ctx.tvReading({ now: null, tv: { state: "PLAYING", position: 5 } }, path), null);
  assert.equal(ctx.tvReading(null, path), null);                                          // tvcast not running
});

test("spoiler guard with the TV as the position source", async () => {
  const cues = ctx.parseSubs(SRT);
  const reading = ctx.tvReading({ now: { file: "x.mkv" }, tv: { state: "PLAYING", position: 61 } }, "/m/x.mkv");
  const now = await ctx.positionNow({ label: "TV", now: () => reading });
  const sent = JSON.stringify(ctx.buildRequest({ model: "claude-opus-5-5", effort: "low", cues, now, question: "?" }).body);
  assert.ok(sent.includes("TJ, wait!"));
  assert.ok(!sent.includes("Owen Hale is the Warden."));
});

test("OpenRouter: same request, its URL, model names and auth, no Anthropic fallback beta", () => {
  const cues = ctx.parseSubs(SRT);
  const args = { model: "claude-opus-5-5", effort: "low", cues, now: 61, frameB64: "AAAA", question: "Who is this?" };
  const a = ctx.buildRequest(args);
  const o = ctx.buildRequest({ ...args, provider: "openrouter" });
  assert.equal(a.url, "https://api.anthropic.com/v1/messages");
  assert.equal(o.url, "https://openrouter.ai/api/v1/messages");
  assert.equal(o.body.model, "anthropic/claude-opus-5.5");
  assert.equal(o.body.fallbacks, undefined);
  assert.equal(o.headers["anthropic-beta"], undefined);
  assert.deepEqual(o.body.output_config, { effort: "low" });
  assert.deepEqual(o.body.messages, a.body.messages);  // same context, so the same spoiler fence
  assert.equal(o.body.system, a.body.system);
  assert.deepEqual(ctx.PROVIDERS.openrouter.auth("sk-or-x"), { authorization: "Bearer sk-or-x" });
  assert.deepEqual(ctx.PROVIDERS.anthropic.auth("sk-ant-x"), { "x-api-key": "sk-ant-x" });
  for (const [m, id] of [["claude-sonnet-5-5", "anthropic/claude-sonnet-5.5"], ["claude-haiku-5-5", "anthropic/claude-haiku-5.5"],
    ["claude-fable-5-1", "anthropic/claude-fable-5.1"]]) assert.equal(ctx.openRouterModel(m), id);
});

test("providerOfKey and OpenRouter's reported cost", () => {
  assert.equal(ctx.providerOfKey("sk-or-v1-abc"), "openrouter");
  assert.equal(ctx.providerOfKey("sk-ant-api03-abc"), "anthropic");
  assert.equal(ctx.providerOfKey(""), "anthropic");
  assert.equal(ctx.costUSD("claude-opus-5-5", { input_tokens: 1000, output_tokens: 100, cost: 0.0123 }), 0.0123);
});

// SDH-style subtitles: speaker labels, a shared surname, a one-off role, a name only said later.
const SDH = `1
00:00:10,000 --> 00:00:11,000
NORA: Hi, I'm Nora Vance.

2
00:01:00,000 --> 00:01:01,000
TJ: Wait up!

3
00:01:30,000 --> 00:01:31,000
NORA: Has anyone seen Vance?

4
00:02:00,000 --> 00:02:01,000
LANDLORD: Rent's due.

5
00:03:00,000 --> 00:03:01,000
QUILL: Hello.

6
00:04:00,000 --> 00:04:01,000
QUILL: Me again.

7
00:20:00,000 --> 00:20:01,000
WARDEN: You're late.
`;

test("characterRegistry: who spoke and was named, from the subtitles so far", () => {
  const cues = ctx.parseSubs(SDH);
  const reg = ctx.characterRegistry(cues, CAST, 300);
  const by = (c) => reg.find((p) => p.character === c);
  assert.equal(by("Nora Vance / Kestrel").lines, 2);
  assert.equal(by("Nora Vance / Kestrel").firstSeen, 10);
  assert.equal(by("Theodore \"TJ\" Okafor").lines, 1);            // a short label still maps to the cast entry
  assert.equal(by("May Vance"), undefined);                         // "Vance" is shared by Nora and May
  assert.equal(by("Landlord"), undefined);                          // a one-off role label
  assert.equal(by("Quill").lines, 2);                               // a named character outside the cast list
  assert.equal(by("Owen Hale / Warden"), undefined);                // speaks only at 20:00, after now
  assert.equal(ctx.characterRegistry(cues, CAST, 300).some((p) => p.recent && p.character === "Quill"), true);
  assert.equal(by("Nora Vance / Kestrel").recent, false);           // last heard 3.5 min ago
});

test("subtitle blocks: ended 10-minute blocks are stable, the last ended one is cached", () => {
  const cues = Array.from({ length: 30 }, (_, i) => ({ start: i * 60, end: i * 60 + 1, text: `line ${i}` }));
  const at = (now) => ctx.buildRequest({ model: "claude-opus-5-5", effort: "low", cast: CAST, cues, now, question: "?" });
  const a = at(1500), b = at(1700);
  const texts = (r) => r.body.messages[0].content.filter((x) => x.type === "text").map((x) => x.text);
  const blocksOf = (r) => texts(r).filter((t) => t.startsWith("Subtitles "));
  assert.deepEqual(blocksOf(a).map((t) => t.split(":\n")[0]), ["Subtitles 0:00–10:00", "Subtitles 10:00–20:00", "Subtitles 20:00–30:00"]);
  assert.equal(blocksOf(a)[0], blocksOf(b)[0]);                    // the ended blocks don't change
  assert.equal(blocksOf(a)[1], blocksOf(b)[1]);
  const marked = a.body.messages[0].content.filter((x) => x.cache_control).map((x) => x.text || x.type);
  assert.equal(marked.length, 2);                                   // after the cast, after the last ended block
  assert.ok(marked[1].startsWith("Subtitles 10:00–20:00"));
  for (const t of texts(a)) assert.ok(!/line 2[6-9]/.test(t), t);    // the fence: nothing after 25:00
});

test("photos and the registry go in; the registry holds no one from later", () => {
  const cues = ctx.parseSubs(SDH);
  const r = ctx.buildRequest({ model: "claude-opus-5-5", effort: "low", cast: CAST, cues, now: 300, question: "Who?",
    heads: [{ actor: "Ada Reyes", b64: "HEAD" }] });
  const content = r.body.messages[0].content;
  const i = content.findIndex((x) => x.text === "Ada Reyes as Nora Vance / Kestrel");
  assert.deepEqual(content[i + 1], { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "HEAD" } });
  const reg = content.find((x) => x.type === "text" && x.text.startsWith("Characters established so far"));
  assert.match(reg.text, /Nora Vance \/ Kestrel \(Ada Reyes\): called NORA.*first at \[0:10\]; 2 lines/);
  assert.ok(!/Warden|WARDEN/.test(reg.text));
  assert.ok(!JSON.stringify(r.body).includes("You're late."));
});

test("X-Ray request: its own prompt and JSON schema, no chat history, same fence", () => {
  const cues = ctx.parseSubs(SRT);
  const r = ctx.buildRequest({ model: "claude-opus-5-5", effort: "low", cast: CAST, cues, now: 61, frameB64: "AAAA",
    question: "ignored", history: [{ q: "earlier-q-7731", a: "earlier-a-7731" }], mode: "xray" });
  assert.equal(r.body.system, ctx.SYSTEM);  // one system prompt for both, so they share the cache
  assert.deepEqual(r.body.output_config.format, { type: "json_schema", schema: ctx.XRAY_SCHEMA });
  const sent = JSON.stringify(r.body);
  assert.ok(!sent.includes("earlier-a-7731"));
  assert.ok(sent.includes("X-Ray: who is in this scene?"));
  assert.ok(!sent.includes("Owen Hale is the Warden."));
  assert.match(ctx.SYSTEM, /X-Ray: list the people in the current scene/);
});

test("xrayPeople adds photos, first-seen times and checked citations from data", () => {
  const cues = ctx.parseSubs(SDH);
  const registry = ctx.characterRegistry(cues, CAST, 300);
  const out = { scene: "x", people: [
    { character: "Quill", actor: "", in_frame: false, speaking_recently: true, confidence: "medium", known_so_far: "Says hello [3:00]." },
    { character: "Nora Vance / Kestrel", actor: "Ada Reyes", in_frame: true, speaking_recently: false, confidence: "high",
      known_so_far: "Introduced herself [0:10], later [20:00]." },
    { character: "Owen Hale / Warden", actor: "Ravi Menon", in_frame: true, speaking_recently: false, confidence: "high", known_so_far: "" },
  ] };
  const people = ctx.xrayPeople(out, registry, [{ actor: "Ada Reyes", b64: "HEAD" }], cues, 300);
  assert.deepEqual(people.map((p) => p.character), ["Nora Vance / Kestrel", "Owen Hale / Warden", "Quill"]);
  assert.equal(people[0].photo, "HEAD");
  assert.equal(people[0].firstSeen, 10);
  assert.equal(people[0].firstAt, "0:10");
  assert.deepEqual(people[0].citations.map((c) => [c.label, c.valid]), [["0:10", true], ["20:00", false]]);
  assert.equal(people[1].firstSeen, null);  // visible, named by the cast list, not yet by the film
  assert.equal(people[1].photo, "");
  assert.equal(people[2].firstSeen, 180);
});
