# Feynman Buddy

An Omarchy 4 shell plugin. You explain a concept to a five-year-old who keeps asking
"but why?", and when the session ends you get a dated markdown file listing the places
you were actually hand-waving.

## How it works

Two separate calls to the `claude` CLI, deliberately not one:

- **The child** — a long-lived `claude -p --input-format stream-json` process. Each turn
  writes one JSON line to its stdin; the reply streams back token by token. Runs on
  `claude-haiku-4-5` with every tool refused.
- **The judge** — a one-shot call on `claude-sonnet-5` that reads the transcript and
  returns strict JSON: gaps, jargon you leaned on, next steps.

A single prompt asked to both *be a convincing five-year-old* and *emit parseable
structure* does neither well. Split, the child is free to be genuinely dumb and the gap
list is reliably machine-readable.

The child ends every reply with `<<<CONTINUE>>>` or `<<<SATISFIED>>>`, stripped before
display. A missing marker is treated as CONTINUE so a malformed reply can never hang the
session; the turn cap (default 8) ends it regardless.

## Config isolation — not optional

The plugin runs `claude` under `CLAUDE_CONFIG_DIR=~/.local/state/omarchy-feynman/claude-config`,
seeded with a copy of `~/.claude/.credentials.json`.

This is load-bearing. Without it, a SessionStart hook from an installed Claude Code plugin
injects text such as *"You have superpowers"* into every reply — verified by asking the
model to quote its own preamble back verbatim. A yes/no probe was not enough to catch it;
Haiku answered "YES" to a leading question even when nothing had leaked.

## Voice

No speech code here. [voxtype](https://github.com/) is already Omarchy's dictation path
(`omarchy-voxtype-status`, `omarchy-voxtype-config`), it types into the focused surface,
and synthetic keystrokes were confirmed to land in a Quickshell
`WlrKeyboardFocus.Exclusive` layer surface. So dictation into the overlay just works, and
the mic glyph reads the same status stream the bar's Dictation indicator uses.

## Install

```sh
omarchy plugin validate ./yander.feynman
cp -r yander.feynman ~/.config/omarchy/plugins/
omarchy-shell shell rescanPlugins
omarchy plugin enable yander.feynman
```

### Editing it: restart the shell, every time

**`rescanPlugins` is not enough.** It refreshes the registry and the manifest, but it
does **not** re-instantiate plugin QML that is already loaded — and this plugin sets
`keepLoaded: true`. The shell will happily keep executing the build it compiled when
the plugin first loaded, with no error and no warning.

```sh
cp -r yander.feynman ~/.config/omarchy/plugins/ && omarchy restart shell
```

This is worth knowing because of how it fails: the old code just keeps running. A
key-binding change appeared to be a logic bug (`turns: 0`, empty transcript) that was
really the previous build still handling keys, and even `console.log` added for
debugging produced nothing — because the instrumented file was never executed. If an
edit seems to have no effect, restart the shell before suspecting the code.

### Two ways in

### Keys inside the overlay

| Key | Action |
|---|---|
| `Enter` | Send |
| `Shift+Enter` | New line |
| `Esc` | Stop early and get the gap list anyway |

`Enter` is intercepted ahead of `TextEdit`'s own handling via `Keys.priority:
Keys.BeforeItem`. `Shift+Enter` is deliberately left *unaccepted* so it falls through
to the editor, which inserts the break itself.

One interaction to be aware of with dictation: voxtype types a literal Return for any
newline in a transcript (`shift_enter_newlines = false`), and a bare Return now sends.
A dictated paragraph is normally a single line so this rarely bites, but it is the
reason to keep `auto_submit = false`.

### Summoning it

**Keybind** — `~/.config/hypr/bindings.lua`:

```lua
o.bind("SUPER + Y", "Feynman Buddy", "omarchy-shell shell toggle yander.feynman '{}'")
```

Y for "why?". Check for conflicts by *canonical* combo, not string match: the
listing prints multi-modifier binds as `SUPER SHIFT + F`, with only the last
separator a `+`, so a naive grep for `SUPER + SHIFT + F` matches nothing and
reports every taken combo as free.

**Omarchy menu** — `~/.config/omarchy/extensions/omarchy-menu.jsonc`:

```jsonc
"trigger.feynman": {"icon":"󰧑","label":"Feynman Buddy","aliases":["feynman","explain","why"],"description":"Explain something to a five-year-old and find out what you do not actually know","action":"omarchy-shell shell summon yander.feynman '{}'"},
```

Lands under **Trigger** with the other one-shot actions, and is reachable as
`omarchy menu summon feynman`. Run `omarchy menu refresh` after editing. The menu
uses `summon` (always opens); the keybind uses `toggle`.

## Tests

```sh
node --test tests/session.test.js
```

`FeynmanSession.js` holds all the logic and is free of QML types and side effects.
`Feynman.qml` owns only rendering and process lifecycle. The fixture in
`tests/fixtures/stream-sample.jsonl` is a real capture, banner line and all — it pins two
behaviours that are easy to get wrong: the `mise` shim writes a non-JSON line to **stdout**
ahead of the stream, and Haiku 4.5 emits `thinking_delta` blocks that must never reach the
UI.

(Use the file path, not `node --test tests/` — the directory form fails on Node 26.)

## Config

`manifest.json` → `feynman`:

| key | default |
|---|---|
| `gapDir` | `Documents/feynman` (relative to `$HOME`) |
| `maxTurns` | `8` |
| `kidModel` | `claude-haiku-4-5` |
| `judgeModel` | `claude-sonnet-5` |

Note: `--effort` is deliberately never passed — it errors on Haiku 4.5. And the prompt must
go over stdin, because `--disallowed-tools` is variadic and silently eats a trailing prompt
argument as tool names.
