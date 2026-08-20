const { test } = require("node:test")
const assert = require("node:assert")
const fs = require("node:fs")
const path = require("node:path")
const S = require("../FeynmanSession.js")

const FIXTURE = path.join(__dirname, "fixtures", "stream-sample.jsonl")

// ---------------------------------------------------------------- stream parsing

test("skips the mise banner that the shim writes to stdout", () => {
  const first = fs.readFileSync(FIXTURE, "utf8").split("\n")[0]
  assert.match(first, /^mise /, "fixture should still start with the banner")
  assert.strictEqual(S.parseLine(first), null)
})

test("skips blank and truncated lines instead of throwing", () => {
  assert.strictEqual(S.parseLine(""), null)
  assert.strictEqual(S.parseLine(null), null)
  assert.strictEqual(S.parseLine('{"type":"stream_ev'), null, "half a line must not throw")
})

test("extracts only text deltas from the real capture, never thinking", () => {
  const lines = fs.readFileSync(FIXTURE, "utf8").split("\n")
  const events = lines.map(S.parseLine).filter(Boolean)

  const kinds = new Set(
    events
      .filter((e) => e.type === "stream_event" && e.event?.type === "content_block_delta")
      .map((e) => e.event.delta.type)
  )
  assert.ok(kinds.has("thinking_delta"), "fixture must contain thinking to be a real test")

  const text = events.map(S.textDelta).filter((t) => t !== null).join("")
  assert.strictEqual(text, "apple")
})

test("reads the authoritative final text off the result line", () => {
  const events = fs.readFileSync(FIXTURE, "utf8").split("\n").map(S.parseLine).filter(Boolean)
  const result = events.map(S.resultText).find((t) => t !== null)
  assert.strictEqual(result, "apple")
})

test("flags an error result", () => {
  assert.ok(S.isErrorResult({ type: "result", is_error: true }))
  assert.ok(!S.isErrorResult({ type: "result", is_error: false }))
  assert.strictEqual(S.resultText({ type: "result", is_error: true, result: "x" }), null)
})

// ---------------------------------------------------------------- markers

test("strips the satisfied marker and reports satisfaction", () => {
  const r = S.stripMarker("Ohhh I get it!\n\n<<<SATISFIED>>>")
  assert.strictEqual(r.text, "Ohhh I get it!")
  assert.strictEqual(r.satisfied, true)
  assert.strictEqual(r.hadMarker, true)
})

test("strips the continue marker without satisfying", () => {
  const r = S.stripMarker("But why does it stop?\n<<<CONTINUE>>>")
  assert.strictEqual(r.text, "But why does it stop?")
  assert.strictEqual(r.satisfied, false)
  assert.strictEqual(r.hadMarker, true)
})

test("a missing marker falls back to continue rather than hanging", () => {
  const r = S.stripMarker("But why?")
  assert.strictEqual(r.text, "But why?")
  assert.strictEqual(r.satisfied, false)
  assert.strictEqual(r.hadMarker, false)
})

test("marker text never leaks when the model puts it mid-reply", () => {
  const r = S.stripMarker("<<<CONTINUE>>>\nwhy though")
  assert.ok(!r.text.includes("<<<"), "no marker fragment may reach the UI")
})

// ---------------------------------------------------------------- session flow

function runTurns(session, n) {
  for (let i = 0; i < n; i++) {
    S.recordExplanation(session, "because reasons " + i)
    S.recordKid(session, "but why " + i + "\n<<<CONTINUE>>>")
  }
  return session
}

test("a satisfied kid ends the session", () => {
  const s = S.setTopic(S.newSession({}), "TCP congestion control")
  S.recordExplanation(s, "it slows down when packets drop")
  S.recordKid(s, "ohh okay\n<<<SATISFIED>>>")
  assert.strictEqual(s.state, "judging")
  assert.strictEqual(s.endReason, "satisfied")
  assert.ok(S.isFinished(s))
})

test("the turn cap stops a kid that never satisfies", () => {
  const s = S.setTopic(S.newSession({ maxTurns: 8 }), "entropy")
  runTurns(s, 8)
  assert.strictEqual(s.turns, 8)
  assert.strictEqual(s.state, "judging")
  assert.strictEqual(s.endReason, "cap")
})

test("stays open at one turn below the cap", () => {
  const s = S.setTopic(S.newSession({ maxTurns: 8 }), "entropy")
  runTurns(s, 7)
  assert.strictEqual(s.state, "explaining")
  assert.ok(!S.isFinished(s))
})

test("a session with no marker at all still terminates at the cap", () => {
  const s = S.setTopic(S.newSession({ maxTurns: 8 }), "entropy")
  for (let i = 0; i < 8; i++) {
    S.recordExplanation(s, "x")
    S.recordKid(s, "why")
  }
  assert.strictEqual(s.state, "judging")
  assert.strictEqual(s.endReason, "cap")
})

test("bailing goes to judging, so Esc still produces a gap list", () => {
  const s = S.setTopic(S.newSession({}), "entropy")
  S.recordExplanation(s, "half an idea")
  S.bail(s)
  assert.strictEqual(s.state, "judging")
  assert.strictEqual(s.endReason, "bailed")
})

test("an empty topic keeps the session on the topic step", () => {
  const s = S.setTopic(S.newSession({}), "   ")
  assert.strictEqual(s.state, "topic")
})

// ---------------------------------------------------------------- CLI plumbing

test("userLine emits one newline-terminated stream-json user message", () => {
  const line = S.userLine("hello")
  assert.ok(line.endsWith("\n"))
  assert.strictEqual(line.indexOf("\n"), line.length - 1, "exactly one trailing newline")
  const parsed = JSON.parse(line)
  assert.strictEqual(parsed.type, "user")
  assert.strictEqual(parsed.message.content[0].text, "hello")
})

test("userLine keeps embedded newlines from breaking the protocol", () => {
  const line = S.userLine("line one\nline two")
  assert.strictEqual(line.trim().split("\n").length, 1, "must stay a single JSON line")
  assert.strictEqual(JSON.parse(line).message.content[0].text, "line one\nline two")
})

// ---------------------------------------------------------------- judge parsing

const GOOD = {
  topic: "TCP congestion control",
  verdict: "Shaky in the middle.",
  gaps: [{ claim: "said it 'just backs off'", why_it_matters: "that is the whole algorithm" }],
  jargon_leaned_on: ["AIMD"],
  next_steps: ["read the Reno state machine"]
}

test("parses bare judge JSON", () => {
  const j = S.parseJudge(JSON.stringify(GOOD))
  assert.strictEqual(j.gaps.length, 1)
  assert.strictEqual(j.jargon_leaned_on[0], "AIMD")
})

test("recovers judge JSON from a markdown fence", () => {
  const j = S.parseJudge("```json\n" + JSON.stringify(GOOD) + "\n```")
  assert.strictEqual(j.verdict, "Shaky in the middle.")
})

test("recovers judge JSON wrapped in prose", () => {
  const j = S.parseJudge("Sure thing:\n" + JSON.stringify(GOOD) + "\nHope that helps!")
  assert.strictEqual(j.topic, "TCP congestion control")
})

test("returns null on unparseable judge output rather than guessing", () => {
  assert.strictEqual(S.parseJudge("total nonsense, no json here"), null)
  assert.strictEqual(S.parseJudge(""), null)
  assert.strictEqual(S.parseJudge("{ broken: "), null)
})

test("tolerates a judge that omits or mistypes fields", () => {
  const j = S.parseJudge('{"verdict":"ok","gaps":"not an array","next_steps":[1,2,""]}')
  assert.deepStrictEqual(j.gaps, [])
  assert.deepStrictEqual(j.next_steps, [])
  assert.strictEqual(j.topic, "")
})

test("rejects a JSON array as a judge object", () => {
  assert.strictEqual(S.parseJudge("[1,2,3]"), null)
})

// ---------------------------------------------------------------- file naming

test("slugifies topics", () => {
  assert.strictEqual(S.slugify("TCP Congestion Control"), "tcp-congestion-control")
  assert.strictEqual(S.slugify("  What *is* entropy?? "), "what-is-entropy")
  assert.strictEqual(S.slugify("!!!"), "untitled")
  assert.strictEqual(S.slugify(""), "untitled")
})

test("caps slug length without leaving a trailing dash", () => {
  const slug = S.slugify("a ".repeat(80))
  assert.ok(slug.length <= 60)
  assert.ok(!slug.endsWith("-"))
})

test("suffixes same-day collisions", () => {
  const d = "2026-08-20"
  assert.strictEqual(S.pickFilename(d, "entropy", []), "2026-08-20-entropy.md")
  assert.strictEqual(
    S.pickFilename(d, "entropy", ["2026-08-20-entropy.md"]),
    "2026-08-20-entropy-2.md"
  )
  assert.strictEqual(
    S.pickFilename(d, "entropy", ["2026-08-20-entropy.md", "2026-08-20-entropy-2.md"]),
    "2026-08-20-entropy-3.md"
  )
})

// ---------------------------------------------------------------- markdown

test("renders a gap list with front matter, gaps and transcript", () => {
  const s = S.setTopic(S.newSession({}), "TCP congestion control")
  S.recordExplanation(s, "it backs off")
  S.recordKid(s, "why does it back off?\n<<<CONTINUE>>>")
  const md = S.renderGapMarkdown(s, S.parseJudge(JSON.stringify(GOOD)), "2026-08-20")

  assert.ok(md.startsWith("---\n"), "front matter first")
  assert.ok(md.includes('topic: "TCP congestion control"'))
  assert.ok(md.includes("## Gaps"))
  assert.ok(md.includes("- [ ] read the Reno state machine"))
  assert.ok(md.includes("<details>") && md.includes("</details>"))
  assert.ok(md.includes("**Kid:** why does it back off?"))
  assert.ok(!md.includes("<<<"), "no marker may survive into the saved file")
})

test("renders honestly when the judge found no gaps", () => {
  const s = S.setTopic(S.newSession({}), "gravity")
  S.recordExplanation(s, "things pull on each other")
  const md = S.renderGapMarkdown(s, S.parseJudge('{"verdict":"Solid.","gaps":[]}'), "2026-08-20")
  assert.ok(md.includes("No gaps found"))
})

test("still renders a file when the judge output was unparseable", () => {
  const s = S.setTopic(S.newSession({}), "gravity")
  S.bail(s)
  const md = S.renderGapMarkdown(s, null, "2026-08-20")
  assert.ok(md.includes("# gravity"))
  assert.ok(md.includes("ended: you stopped early"))
})

// ------------------------------------------------- judge CLI envelope (regression)

const ENVELOPE = path.join(__dirname, "fixtures", "judge-envelope.json")

test("unwraps a real judge capture despite the mise banner on stdout", () => {
  const raw = fs.readFileSync(ENVELOPE, "utf8")
  assert.match(raw.split("\n")[0], /^mise /, "fixture must keep the banner to be a real test")

  const j = S.judgeFromCliOutput(raw)
  assert.ok(j, "must recover the judge object")
  assert.strictEqual(j.topic, "how a bicycle stays up")
  assert.ok(j.gaps.length > 0)
  assert.ok(j.jargon_leaned_on.includes("angular momentum"))
})

test("does NOT mistake the CLI envelope for the verdict", () => {
  // The bug this guards: brace-extraction over the whole blob returns the envelope,
  // which normalizes into an empty-but-truthy verdict — a silent wrong answer.
  const raw = fs.readFileSync(ENVELOPE, "utf8")
  const naive = S.parseJudge(raw)
  assert.ok(naive && naive.verdict === "", "the naive path really does produce an empty verdict")

  const correct = S.judgeFromCliOutput(raw)
  assert.notStrictEqual(correct.verdict, "", "the real path must produce a real verdict")
})

test("handles a bare judge reply with no CLI envelope", () => {
  const bare = "mise banner noise\n" + JSON.stringify(GOOD)
  const j = S.judgeFromCliOutput(bare)
  assert.strictEqual(j.topic, "TCP congestion control")
})

test("handles a pretty-printed bare judge reply", () => {
  const j = S.judgeFromCliOutput("noise\n" + JSON.stringify(GOOD, null, 2))
  assert.strictEqual(j.verdict, "Shaky in the middle.")
})

test("returns null when the CLI reports an error", () => {
  assert.strictEqual(
    S.judgeFromCliOutput('{"is_error":true,"result":"boom"}'),
    null
  )
})

test("returns null on noise with no JSON at all", () => {
  assert.strictEqual(S.judgeFromCliOutput("mise banner\njust noise"), null)
  assert.strictEqual(S.judgeFromCliOutput(""), null)
})
