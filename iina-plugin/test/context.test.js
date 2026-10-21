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
