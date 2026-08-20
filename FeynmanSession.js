// Pure session logic for the Feynman Buddy overlay.
//
// Deliberately free of QML types and side effects: Feynman.qml owns rendering and
// process lifecycle, this file owns everything that can be reasoned about (and
// tested) on its own. Runs unchanged under QML's `import ... as` and under node.

var MARKER_CONTINUE = "<<<CONTINUE>>>"
var MARKER_SATISFIED = "<<<SATISFIED>>>"

// ---------------------------------------------------------------- stream parsing

// The CLI is reached through a mise shim that writes a banner to STDOUT, ahead of
// the JSON. Anything that is not a JSON object is noise by definition, so drop it
// rather than trying to enumerate the sources of it.
function parseLine(line) {
  if (!line) return null
  var trimmed = String(line).trim()
  if (trimmed.charAt(0) !== "{") return null
  try {
    return JSON.parse(trimmed)
  } catch (e) {
    return null
  }
}

// Haiku 4.5 streams thinking blocks by default. Only text_delta is the reply the
// user should see; thinking_delta and signature_delta must never reach the UI.
function textDelta(evt) {
  if (!evt || evt.type !== "stream_event" || !evt.event) return null
  var e = evt.event
  if (e.type !== "content_block_delta" || !e.delta) return null
  if (e.delta.type !== "text_delta") return null
  return e.delta.text || ""
}

// The per-turn result line carries the complete final text, which is more reliable
// for marker detection than deltas we reassembled ourselves.
function resultText(evt) {
  if (!evt || evt.type !== "result") return null
  if (evt.is_error) return null
  return typeof evt.result === "string" ? evt.result : null
}

function isErrorResult(evt) {
  return !!(evt && evt.type === "result" && evt.is_error)
}

// ---------------------------------------------------------------- markers

// A missing marker must never hang the session: treat it as CONTINUE and let the
// turn cap end things.
function stripMarker(raw) {
  var text = String(raw === undefined || raw === null ? "" : raw)
  var satisfied = false
  var hadMarker = false

  if (text.indexOf(MARKER_SATISFIED) !== -1) {
    satisfied = true
    hadMarker = true
  } else if (text.indexOf(MARKER_CONTINUE) !== -1) {
    hadMarker = true
  }

  text = text.split(MARKER_SATISFIED).join("")
  text = text.split(MARKER_CONTINUE).join("")

  return { text: text.replace(/\s+$/, ""), satisfied: satisfied, hadMarker: hadMarker }
}

// ---------------------------------------------------------------- session state

function newSession(cfg) {
  var c = cfg || {}
  return {
    state: "topic",
    topic: "",
    turns: 0,
    maxTurns: c.maxTurns || 8,
    exchanges: [],
    pending: "",
    endReason: ""
  }
}

function setTopic(session, topic) {
  session.topic = String(topic || "").trim()
  session.state = session.topic ? "explaining" : "topic"
  return session
}

function recordExplanation(session, text) {
  session.exchanges.push({ who: "person", text: String(text || "").trim() })
  session.state = "waiting"
  return session
}

function recordKid(session, rawReply) {
  var parsed = stripMarker(rawReply)
  session.exchanges.push({ who: "kid", text: parsed.text })
  session.turns += 1

  if (parsed.satisfied) {
    session.state = "judging"
    session.endReason = "satisfied"
  } else if (session.turns >= session.maxTurns) {
    session.state = "judging"
    session.endReason = "cap"
  } else {
    session.state = "explaining"
  }
  return session
}

function bail(session) {
  session.state = "judging"
  session.endReason = "bailed"
  return session
}

function isFinished(session) {
  return session.state === "judging" || session.state === "done"
}

// ---------------------------------------------------------------- CLI plumbing

// One JSON line per turn, written to the long-lived process's stdin. Text goes over
// stdin and never argv: it keeps the user's words out of `ps`, and --disallowed-tools
// is variadic, so a trailing prompt argument gets eaten as tool names.
function userLine(text) {
  return JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "text", text: String(text || "") }] }
  }) + "\n"
}

function transcriptForJudge(session) {
  var lines = ["Concept the person was explaining: " + session.topic, ""]
  for (var i = 0; i < session.exchanges.length; i++) {
    var ex = session.exchanges[i]
    lines.push((ex.who === "person" ? "PERSON:" : "CHILD:") + " " + ex.text)
    lines.push("")
  }
  return lines.join("\n")
}

// ---------------------------------------------------------------- judge output

// The judge is told to emit bare JSON, but a model can still fence it or add a
// sentence. Recover where recovery is unambiguous; return null rather than guess.
function parseJudge(raw) {
  if (!raw) return null
  var text = String(raw).trim()

  try {
    return normalizeJudge(JSON.parse(text))
  } catch (e) { /* fall through */ }

  var fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenced) {
    try {
      return normalizeJudge(JSON.parse(fenced[1].trim()))
    } catch (e2) { /* fall through */ }
  }

  var first = text.indexOf("{")
  var last = text.lastIndexOf("}")
  if (first !== -1 && last > first) {
    try {
      return normalizeJudge(JSON.parse(text.slice(first, last + 1)))
    } catch (e3) { /* fall through */ }
  }

  return null
}

// The judge runs with --output-format json, so its reply arrives wrapped in a CLI
// envelope — and the mise shim prints a banner line ahead of it on stdout. Walk to
// the envelope rather than parsing the blob, or brace-extraction silently returns
// the envelope itself as an empty verdict.
function judgeFromCliOutput(raw) {
  if (!raw) return null
  var lines = String(raw).split("\n")
  var firstBrace = -1

  for (var i = 0; i < lines.length; i++) {
    // Tracked by opening brace, not by parseability: a pretty-printed object
    // starts with a lone "{" that is not valid JSON on its own line.
    if (firstBrace === -1 && lines[i].trim().charAt(0) === "{") firstBrace = i

    var evt = parseLine(lines[i])
    if (!evt) continue
    if (evt.is_error === true) return null
    if (typeof evt.result === "string") return parseJudge(evt.result)
  }

  // No envelope: the judge may already be bare (possibly pretty-printed) JSON.
  if (firstBrace !== -1) return parseJudge(lines.slice(firstBrace).join("\n"))
  return null
}

function normalizeJudge(obj) {
  if (!obj || typeof obj !== "object" || obj instanceof Array) return null
  return {
    topic: typeof obj.topic === "string" ? obj.topic : "",
    verdict: typeof obj.verdict === "string" ? obj.verdict : "",
    gaps: sanitizeGaps(obj.gaps),
    jargon_leaned_on: sanitizeStrings(obj.jargon_leaned_on),
    next_steps: sanitizeStrings(obj.next_steps)
  }
}

function sanitizeGaps(value) {
  if (!(value instanceof Array)) return []
  var out = []
  for (var i = 0; i < value.length; i++) {
    var g = value[i]
    if (!g || typeof g !== "object") continue
    out.push({
      claim: typeof g.claim === "string" ? g.claim : "",
      why_it_matters: typeof g.why_it_matters === "string" ? g.why_it_matters : ""
    })
  }
  return out
}

function sanitizeStrings(value) {
  if (!(value instanceof Array)) return []
  var out = []
  for (var i = 0; i < value.length; i++) {
    if (typeof value[i] === "string" && value[i].trim()) out.push(value[i].trim())
  }
  return out
}

// ---------------------------------------------------------------- file naming

function slugify(topic) {
  var s = String(topic || "").toLowerCase()
  s = s.replace(/[^a-z0-9]+/g, "-")
  s = s.replace(/^-+/, "").replace(/-+$/, "")
  if (!s) s = "untitled"
  if (s.length > 60) {
    s = s.slice(0, 60).replace(/-+$/, "")
    if (!s) s = "untitled"
  }
  return s
}

// Kept pure by taking the existing names rather than reading the directory.
function pickFilename(dateStr, topic, existingNames) {
  var base = dateStr + "-" + slugify(topic)
  var taken = {}
  var list = existingNames || []
  for (var i = 0; i < list.length; i++) taken[list[i]] = true

  var candidate = base + ".md"
  var n = 2
  while (taken[candidate]) {
    candidate = base + "-" + n + ".md"
    n += 1
  }
  return candidate
}

// ---------------------------------------------------------------- markdown

function endReasonLabel(reason) {
  if (reason === "satisfied") return "the child understood"
  if (reason === "cap") return "hit the turn limit"
  if (reason === "bailed") return "you stopped early"
  return "ended"
}

function renderGapMarkdown(session, judge, dateStr) {
  var j = judge || { topic: "", verdict: "", gaps: [], jargon_leaned_on: [], next_steps: [] }
  var out = []

  out.push("---")
  out.push("topic: " + JSON.stringify(session.topic))
  out.push("date: " + dateStr)
  out.push("turns: " + session.turns)
  out.push("ended: " + endReasonLabel(session.endReason))
  out.push("---")
  out.push("")
  out.push("# " + (session.topic || "Untitled"))
  out.push("")

  if (j.verdict) {
    out.push(j.verdict)
    out.push("")
  }

  out.push("## Gaps")
  out.push("")
  if (j.gaps.length === 0) {
    out.push("No gaps found. You explained this one cleanly.")
    out.push("")
  } else {
    for (var i = 0; i < j.gaps.length; i++) {
      out.push("### " + (i + 1) + ". " + j.gaps[i].claim)
      out.push("")
      out.push(j.gaps[i].why_it_matters)
      out.push("")
    }
  }

  if (j.jargon_leaned_on.length) {
    out.push("## Jargon you leaned on")
    out.push("")
    for (var k = 0; k < j.jargon_leaned_on.length; k++) out.push("- " + j.jargon_leaned_on[k])
    out.push("")
  }

  if (j.next_steps.length) {
    out.push("## Next steps")
    out.push("")
    for (var m = 0; m < j.next_steps.length; m++) out.push("- [ ] " + j.next_steps[m])
    out.push("")
  }

  out.push("<details>")
  out.push("<summary>Full transcript</summary>")
  out.push("")
  for (var n = 0; n < session.exchanges.length; n++) {
    var ex = session.exchanges[n]
    out.push("**" + (ex.who === "person" ? "You" : "Kid") + ":** " + ex.text)
    out.push("")
  }
  out.push("</details>")
  out.push("")

  return out.join("\n")
}

// node-only export; QML leaves `module` undefined and skips this entirely.
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    MARKER_CONTINUE: MARKER_CONTINUE,
    MARKER_SATISFIED: MARKER_SATISFIED,
    parseLine: parseLine,
    textDelta: textDelta,
    resultText: resultText,
    isErrorResult: isErrorResult,
    stripMarker: stripMarker,
    newSession: newSession,
    setTopic: setTopic,
    recordExplanation: recordExplanation,
    recordKid: recordKid,
    bail: bail,
    isFinished: isFinished,
    userLine: userLine,
    transcriptForJudge: transcriptForJudge,
    parseJudge: parseJudge,
    judgeFromCliOutput: judgeFromCliOutput,
    slugify: slugify,
    pickFilename: pickFilename,
    renderGapMarkdown: renderGapMarkdown
  }
}
