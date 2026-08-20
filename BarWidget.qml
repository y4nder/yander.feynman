import QtQuick
import qs.Commons
import qs.Ui

// Click to summon the overlay. Same target as the keybind, so there is exactly
// one way in and nothing to keep in sync.
BarWidget {
  id: root
  moduleName: "yander.feynman"

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: "󱜙"
    tooltipText: "Explain something to a five-year-old"
    onPressed: function (b) {
      if (root.bar) root.bar.run("omarchy-shell shell toggle yander.feynman '{}'")
    }
  }
}
