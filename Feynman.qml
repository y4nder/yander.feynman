import Quickshell
import Quickshell.Io
import Quickshell.Wayland
import QtQuick
import qs.Commons
import qs.Ui
import "FeynmanSession.js" as Session

// Feynman Buddy. Explain a concept to a five-year-old that keeps asking why,
// then get a written list of the places you were hand-waving.
//
// Follows the overlay contract in plugins/reminders/ReminderFlow.qml: open/close/
// dismiss/toggle, with `shell` and `manifest` injected by the registry.
Item {
  id: root

  property var shell: null
  property var manifest: null

  readonly property string home: Quickshell.env("HOME")
  readonly property string pluginDir: (manifest && manifest.__sourceDir) ? manifest.__sourceDir : ""
  readonly property var cfg: (manifest && manifest.feynman) ? manifest.feynman : ({})

  readonly property string gapDir: home + "/" + (cfg.gapDir || "Documents/feynman")
  readonly property string stateDir: home + "/.local/state/omarchy-feynman"
  readonly property string isoConfigDir: stateDir + "/claude-config"
  readonly property string scratchDir: stateDir + "/scratch"
  readonly property int maxTurns: cfg.maxTurns || 8
  readonly property string kidModel: cfg.kidModel || "claude-haiku-4-5"
  readonly property string judgeModel: cfg.judgeModel || "claude-sonnet-5"

  // The child only ever talks. Every tool is refused explicitly rather than
  // trusted to stay unused.
  readonly property var noTools: [
    "Bash", "Read", "Write", "Edit", "Glob", "Grep",
    "WebFetch", "WebSearch", "Task", "TodoWrite", "NotebookEdit"
  ]

  property bool opened: false
  property var session: Session.newSession({ maxTurns: root.maxTurns })

  // QML cannot bind through mutations of a plain JS object, so the pieces the UI
  // reads are mirrored onto real properties and refreshed by sync().
  property string uiState: "topic"
  property int turnCount: 0
  property string topicText: ""
  property var exchanges: []

  property string draft: ""
  property string streaming: ""
  property string errorText: ""
  property string savedPath: ""
  property var judgeResult: null
  property string micState: "idle"
  property bool ready: false

  property string kidPrompt: ""
  property string judgePrompt: ""

  readonly property string fontFamily: Style.font.menuFamily
  readonly property color background: Color.menu.background
  readonly property color foreground: Color.menu.text
  readonly property color scrim: Color.menu.scrim

  // Label plus three dots that pulse in sequence. Used for every state where the
  // plugin is waiting on a model, so "nothing is happening" always looks different
  // from "something is happening".
  component ThinkingLine: Item {
    id: tl
    property string label: ""
    property color tint: "#ffffff"
    property string face: ""
    property int size: 12
    property bool active: false

    implicitWidth: line.implicitWidth
    implicitHeight: line.implicitHeight

    Row {
      id: line
      spacing: Math.max(2, tl.size * 0.45)

      Text {
        anchors.verticalCenter: parent.verticalCenter
        text: tl.label
        color: tl.tint
        font.family: tl.face
        font.pixelSize: tl.size
        opacity: 0.5
        SequentialAnimation on opacity {
          running: tl.active
          loops: Animation.Infinite
          NumberAnimation { to: 0.75; duration: 850; easing.type: Easing.InOutSine }
          NumberAnimation { to: 0.4; duration: 850; easing.type: Easing.InOutSine }
        }
      }

      Row {
        anchors.verticalCenter: parent.verticalCenter
        spacing: Math.max(2, tl.size * 0.3)

        Repeater {
          model: 3
          delegate: Rectangle {
            required property int index
            width: Math.max(3, tl.size * 0.3)
            height: width
            radius: width / 2
            color: tl.tint
            opacity: 0.2
            SequentialAnimation on opacity {
              running: tl.active
              loops: Animation.Infinite
              PauseAnimation { duration: index * 170 }
              NumberAnimation { to: 0.85; duration: 380; easing.type: Easing.InOutSine }
              NumberAnimation { to: 0.2; duration: 380; easing.type: Easing.InOutSine }
              PauseAnimation { duration: (2 - index) * 170 }
            }
          }
        }
      }
    }
  }

  function sync() {
    root.uiState = root.session.state
    root.turnCount = root.session.turns
    root.topicText = root.session.topic
    root.exchanges = root.session.exchanges.slice()
  }

  // ------------------------------------------------------------ lifecycle

  function open(payloadJson) {
    root.opened = true
    root.session = Session.newSession({ maxTurns: root.maxTurns })
    root.draft = ""
    root.streaming = ""
    root.errorText = ""
    root.savedPath = ""
    root.judgeResult = null
    root.sync()

    kidProcess.running = false
    prepProcess.running = true

    Qt.callLater(function () { topicField.forceActiveFocus() })
  }

  function close() {
    root.opened = false
  }

  function dismiss() {
    kidProcess.running = false
    judgeProcess.running = false
    root.opened = false
    if (root.shell && typeof root.shell.hide === "function")
      root.shell.hide((root.manifest && root.manifest.id) || "yander.feynman")
  }

  function toggle() {
    if (root.opened) root.dismiss()
    else root.open("{}")
  }

  // ------------------------------------------------------------ flow

  function commitTopic() {
    var topic = topicField.text.trim()
    if (!topic) {
      root.dismiss()
      return
    }
    Session.setTopic(root.session, topic)
    root.sync()
    startKid()
    Qt.callLater(function () { draftArea.forceActiveFocus() })
  }

  function startKid() {
    if (!root.kidPrompt) {
      root.errorText = "Could not read prompts/kid.txt"
      return
    }
    kidProcess.command = ["bash", "-lc", 'exec claude "$@"', "claude",
      "-p", "--verbose",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--include-partial-messages",
      "--strict-mcp-config",
      "--model", root.kidModel,
      "--system-prompt", root.kidPrompt,
      "--disallowed-tools"].concat(root.noTools)
    kidProcess.running = true
  }

  function submitDraft() {
    var text = root.draft.trim()
    if (!text || root.session.state !== "explaining") return
    if (!kidProcess.running) {
      root.errorText = "The buddy is not running"
      return
    }

    Session.recordExplanation(root.session, text)
    root.draft = ""
    root.streaming = ""
    root.sync()

    var opener = root.session.turns === 0
      ? "I want to explain something to you: " + root.session.topic + "\n\n" + text
      : text
    kidProcess.write(Session.userLine(opener))
  }

  function finishKidTurn(finalText) {
    Session.recordKid(root.session, finalText)
    root.streaming = ""
    root.sync()
    if (root.session.state === "judging") runJudge()
    else Qt.callLater(function () { draftArea.forceActiveFocus() })
  }

  function bailOut() {
    if (Session.isFinished(root.session)) return
    Session.bail(root.session)
    root.sync()
    runJudge()
  }

  function runJudge() {
    kidProcess.running = false
    if (!root.judgePrompt) {
      root.errorText = "Could not read prompts/judge.txt"
      finishWithoutJudge()
      return
    }
    // The transcript reaches the judge through a file in the plugin's own 0700
    // state dir: a one-shot `claude` needs EOF on stdin, and a file sidesteps
    // having to close a pipe mid-flight.
    judgeProcess.command = ["bash", "-lc",
      'umask 077; printf "%s" "$1" > "$2/transcript.txt"; exec claude "${@:3}" < "$2/transcript.txt"',
      "_", Session.transcriptForJudge(root.session), root.scratchDir,
      "-p", "--output-format", "json",
      "--strict-mcp-config",
      "--model", root.judgeModel,
      "--system-prompt", root.judgePrompt,
      "--disallowed-tools"].concat(root.noTools)
    judgeProcess.running = true
  }

  function applyJudge(raw) {
    root.judgeResult = Session.judgeFromCliOutput(raw)
    if (!root.judgeResult) root.errorText = "The verdict came back unreadable — saving the transcript anyway."
    saveGapFile()
  }

  function finishWithoutJudge() {
    root.judgeResult = null
    saveGapFile()
  }

  function todayString() {
    var d = new Date()
    var m = ("0" + (d.getMonth() + 1)).slice(-2)
    var day = ("0" + d.getDate()).slice(-2)
    return d.getFullYear() + "-" + m + "-" + day
  }

  function saveGapFile() {
    listProcess.pendingDate = todayString()
    listProcess.running = true
  }

  function writeGapFile(existingNames) {
    var date = listProcess.pendingDate
    var name = Session.pickFilename(date, root.session.topic, existingNames)
    var markdown = Session.renderGapMarkdown(root.session, root.judgeResult, date)

    saveProcess.targetPath = root.gapDir + "/" + name
    saveProcess.command = ["bash", "-lc",
      'mkdir -p "$(dirname "$1")" && printf "%s" "$2" > "$1"',
      "_", saveProcess.targetPath, markdown]
    saveProcess.running = true
  }

  // ------------------------------------------------------------ processes

  // Isolates the child from ~/.claude. Verified necessary: without it a
  // SessionStart hook injects "You have superpowers" into every reply.
  Process {
    id: prepProcess
    running: false
    command: ["bash", "-lc",
      'set -e; umask 077; mkdir -p "$1" "$2" "$3"; cp -f "$HOME/.claude/.credentials.json" "$1/.credentials.json" 2>/dev/null || true',
      "_", root.isoConfigDir, root.scratchDir, root.gapDir]
    environment: ({ "CLAUDE_CONFIG_DIR": root.isoConfigDir })
    onExited: function (code) {
      root.ready = (code === 0)
      if (code !== 0) root.errorText = "Could not prepare the isolated config"
    }
  }

  Process {
    id: kidProcess
    running: false
    stdinEnabled: true
    workingDirectory: root.scratchDir
    environment: ({ "CLAUDE_CONFIG_DIR": root.isoConfigDir })

    property string assembled: ""

    stdout: SplitParser {
      onRead: function (line) {
        var evt = Session.parseLine(line)
        if (!evt) return

        var delta = Session.textDelta(evt)
        if (delta !== null) {
          kidProcess.assembled += delta
          root.streaming = Session.stripMarker(kidProcess.assembled).text
          return
        }

        if (Session.isErrorResult(evt)) {
          root.errorText = "The buddy hit an error"
          kidProcess.assembled = ""
          return
        }

        var finalText = Session.resultText(evt)
        if (finalText !== null) {
          kidProcess.assembled = ""
          root.finishKidTurn(finalText)
        }
      }
    }

    stderr: StdioCollector {
      onStreamFinished: {
        if (text && text.trim() && !root.errorText) root.errorText = text.trim().split("\n")[0]
      }
    }
  }

  Process {
    id: judgeProcess
    running: false
    workingDirectory: root.scratchDir
    environment: ({ "CLAUDE_CONFIG_DIR": root.isoConfigDir })

    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.applyJudge(text)
    }
    onExited: function (code) {
      if (code !== 0 && !root.judgeResult) {
        root.errorText = "The verdict pass failed — saving the transcript anyway."
        root.finishWithoutJudge()
      }
    }
  }

  // Collision suffixing needs the names already on disk; the choice itself is
  // made by the pure Session.pickFilename.
  Process {
    id: listProcess
    running: false
    property string pendingDate: ""
    command: ["bash", "-lc", 'ls -1 "$1" 2>/dev/null || true', "_", root.gapDir]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        var names = text.split("\n").filter(function (n) { return n.trim() !== "" })
        root.writeGapFile(names)
      }
    }
  }

  Process {
    id: saveProcess
    running: false
    property string targetPath: ""
    onExited: function (code) {
      if (code === 0) {
        root.savedPath = saveProcess.targetPath
        root.session.state = "done"
        root.sync()
      } else {
        root.errorText = "Could not write " + saveProcess.targetPath
      }
    }
  }

  // Same status stream the bar's Dictation indicator uses, so the mic glyph
  // reflects the real voxtype state rather than guessing.
  Process {
    id: voxtypeProcess
    command: ["bash", "-lc", "exec omarchy-voxtype-status"]
    running: true
    stdout: SplitParser {
      onRead: function (data) {
        try {
          var parsed = JSON.parse(data)
          root.micState = String(parsed.alt || parsed.class || "idle")
        } catch (e) { /* status noise */ }
      }
    }
  }

  FileView {
    path: root.pluginDir ? root.pluginDir + "/prompts/kid.txt" : ""
    watchChanges: false
    printErrors: false
    onLoaded: root.kidPrompt = text()
  }

  FileView {
    path: root.pluginDir ? root.pluginDir + "/prompts/judge.txt" : ""
    watchChanges: false
    printErrors: false
    onLoaded: root.judgePrompt = text()
  }

  // ------------------------------------------------------------ ui

  PanelWindow {
    id: panel
    visible: root.opened
    anchors { top: true; bottom: true; left: true; right: true }
    color: "transparent"
    WlrLayershell.namespace: "omarchy-feynman"
    WlrLayershell.layer: WlrLayer.Overlay
    WlrLayershell.keyboardFocus: WlrKeyboardFocus.Exclusive
    exclusionMode: ExclusionMode.Ignore

    Rectangle { anchors.fill: parent; color: root.scrim }
    MouseArea { anchors.fill: parent; onClicked: root.dismiss() }

    BorderSurface {
      id: card
      width: Math.min(Style.space(760), panel.width - Style.gapsOut * 2)
      height: Math.min(Style.space(620), panel.height - Style.gapsOut * 2)
      radius: Style.cornerRadius
      anchors.centerIn: parent
      color: root.background
      borderSpec: Border.surfaceSpec("menu", "border", Color.menu.border, Math.max(1, Style.space(2)))
      padding: Style.spacing.panelPadding

      MouseArea { anchors.fill: parent; onClicked: {} }

      Item {
        anchors.fill: parent
        anchors.topMargin: card.contentTopInset
        anchors.rightMargin: card.contentRightInset
        anchors.bottomMargin: card.contentBottomInset
        anchors.leftMargin: card.contentLeftInset

        // -------------------------------------------------- header
        Item {
          id: header
          anchors { top: parent.top; left: parent.left; right: parent.right }
          height: Style.font.heading + Style.space(12)

          Text {
            anchors.verticalCenter: parent.verticalCenter
            anchors.left: parent.left
            text: root.topicText || "Feynman Buddy"
            color: root.foreground
            font.family: root.fontFamily
            font.pixelSize: Style.font.heading
            elide: Text.ElideRight
            width: parent.width - Style.space(120)
          }

          Text {
            anchors.verticalCenter: parent.verticalCenter
            anchors.right: parent.right
            color: root.foreground
            opacity: 0.6
            font.family: root.fontFamily
            font.pixelSize: Style.font.body
            text: {
              var mic = root.micState === "recording" ? "󰍬 " : (root.micState === "transcribing" ? "󰔟 " : "")
              if (root.uiState === "topic") return mic
              return mic + root.turnCount + "/" + root.maxTurns
            }
          }
        }

        // -------------------------------------------------- topic step
        Item {
          anchors { top: header.bottom; left: parent.left; right: parent.right; bottom: footer.top }
          visible: root.uiState === "topic"

          TextField {
            id: topicField
            anchors.left: parent.left
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            placeholderText: "What are we learning about?"
            font.family: root.fontFamily
            font.pixelSize: Style.font.heading
            onAccepted: root.commitTopic()
            Keys.onEscapePressed: root.dismiss()
          }
        }

        // -------------------------------------------------- conversation
        Item {
          id: convo
          anchors { top: header.bottom; left: parent.left; right: parent.right; bottom: footer.top }
          visible: root.uiState === "explaining" || root.uiState === "waiting" || root.uiState === "judging"

          Flickable {
            id: scroller
            anchors { top: parent.top; left: parent.left; right: parent.right }
            height: parent.height - inputBox.height - Style.space(10)
            contentWidth: width
            contentHeight: column.height
            clip: true
            boundsBehavior: Flickable.StopAtBounds
            onContentHeightChanged: contentY = Math.max(0, contentHeight - height)

            Column {
              id: column
              width: scroller.width
              spacing: Style.space(10)

              Repeater {
                model: root.exchanges
                delegate: Text {
                  width: column.width
                  wrapMode: Text.WordWrap
                  color: root.foreground
                  opacity: modelData.who === "kid" ? 1 : 0.72
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.body
                  font.italic: modelData.who === "person"
                  text: (modelData.who === "kid" ? "🧒  " : "") + modelData.text
                }
              }

              Text {
                width: column.width
                wrapMode: Text.WordWrap
                visible: root.streaming !== ""
                color: root.foreground
                font.family: root.fontFamily
                font.pixelSize: Style.font.body
                text: "🧒  " + root.streaming
              }

              ThinkingLine {
                visible: root.uiState === "waiting" && root.streaming === ""
                active: visible
                label: "thinking"
                tint: root.foreground
                face: root.fontFamily
                size: Style.font.body
              }

              ThinkingLine {
                visible: root.uiState === "judging"
                active: visible
                label: "working out what you missed"
                tint: root.foreground
                face: root.fontFamily
                size: Style.font.body
              }
            }
          }

          BorderSurface {
            id: inputBox
            anchors { bottom: parent.bottom; left: parent.left; right: parent.right }
            height: Math.min(Style.space(150), Math.max(Style.space(64), draftArea.contentHeight + Style.space(20)))
            radius: Style.cornerRadius
            color: "transparent"
            visible: root.uiState === "explaining"
            borderSpec: Border.controlSpec(draftArea.activeFocus ? "focus" : "normal", root.foreground, Color.accent)
            padding: Style.space(10)

            TextEdit {
              id: draftArea
              anchors.fill: parent
              anchors.margins: Style.space(10)
              wrapMode: TextEdit.Wrap
              color: root.foreground
              font.family: root.fontFamily
              font.pixelSize: Style.font.body
              selectByMouse: true
              selectionColor: Style.selectionFillFor(root.foreground, Color.accent)
              text: root.draft
              onTextChanged: root.draft = text

              Text {
                anchors.fill: parent
                visible: draftArea.text === ""
                color: root.foreground
                opacity: 0.4
                font: draftArea.font
                text: "Explain it. Enter to send, Shift+Enter for a new line."
              }

              // Runs ahead of TextEdit's own handling, so a bare Enter never
              // reaches the editor as a newline. Shift+Enter is deliberately left
              // unaccepted and falls through to TextEdit, which inserts the break.
              Keys.priority: Keys.BeforeItem
              Keys.onPressed: function (event) {
                if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter) {
                  if (event.modifiers & Qt.ShiftModifier) return
                  root.submitDraft()
                  event.accepted = true
                } else if (event.key === Qt.Key_Escape) {
                  root.bailOut()
                  event.accepted = true
                }
              }
            }
          }
        }

        // -------------------------------------------------- verdict
        Flickable {
          anchors { top: header.bottom; left: parent.left; right: parent.right; bottom: footer.top }
          visible: root.uiState === "done"
          contentWidth: width
          contentHeight: verdictColumn.height
          clip: true
          boundsBehavior: Flickable.StopAtBounds

          Column {
            id: verdictColumn
            width: parent.width
            spacing: Style.space(10)

            Text {
              width: parent.width
              wrapMode: Text.WordWrap
              color: root.foreground
              font.family: root.fontFamily
              font.pixelSize: Style.font.body
              text: root.judgeResult && root.judgeResult.verdict ? root.judgeResult.verdict : "Session saved."
            }

            Repeater {
              model: root.judgeResult ? root.judgeResult.gaps : []
              delegate: Text {
                width: verdictColumn.width
                wrapMode: Text.WordWrap
                color: root.foreground
                font.family: root.fontFamily
                font.pixelSize: Style.font.body
                text: "•  " + modelData.claim + "\n     " + modelData.why_it_matters
              }
            }

            Text {
              width: parent.width
              wrapMode: Text.WordWrap
              visible: root.savedPath !== ""
              color: root.foreground
              opacity: 0.55
              font.family: root.fontFamily
              font.pixelSize: Style.font.bodySmall
              text: "Saved to " + root.savedPath
            }
          }
        }

        // -------------------------------------------------- footer
        Text {
          id: footer
          anchors { bottom: parent.bottom; left: parent.left; right: parent.right }
          height: Style.font.bodySmall + Style.space(10)
          verticalAlignment: Text.AlignVCenter
          color: root.errorText ? Color.urgent : root.foreground
          opacity: root.errorText ? 0.9 : 0.45
          font.family: root.fontFamily
          font.pixelSize: Style.font.bodySmall
          elide: Text.ElideRight
          text: {
            if (root.errorText) return root.errorText
            if (root.uiState === "topic") return "Enter to start · Esc to close"
            if (root.uiState === "done") return "Esc to close"
            return "Enter to send · Shift+Enter for a new line · Esc to stop"
          }
        }

        // Catches Esc for the states that have no focused editor of their own.
        Item {
          anchors.fill: parent
          focus: root.uiState === "waiting" || root.uiState === "judging" || root.uiState === "done"
          Keys.onEscapePressed: function (event) {
            if (root.uiState === "done") root.dismiss()
            else root.bailOut()
            event.accepted = true
          }
        }
      }
    }
  }
}
