# BambuBoard 3.3.3

## G-code Toolpath

- Large plates render incrementally. The viewer streams sliced G-code up to 250 MiB, buffers the current nozzle movement, and reuses the loaded toolpath while you edit the widget.
- The estimated nozzle follows the ordered toolpath. Fresh extrusion starts red and cools through orange, yellow, and green to the filament color over 144 seconds.
- Choose the angle and zoom in the Scene Editor. In Setup, **Test G-code connection** checks FTPS access for the saved printer.
- Exceptionally dense plates can still exceed the preview's geometry limits. Recovery options and limits are documented in the [toolpath guide](gcode-resilience.md).

## Printer, camera, and setup

- Stalled camera streams and individual viewers recover automatically. Recognized built-in calibration jobs show **Calibrating** and skip toolpath retries.
- The H3C profile covers printer detection, camera, G-code, and AMS 3H in fixtures. Physical H3C verification is pending.
- Bambu Cloud sign-in guides you through email codes and optional authenticator verification. A single reported AMS is selected automatically.

## Updating

Keep your existing Docker data mount and back it up before upgrading. Legacy files owned by root may need the one-time migration. [Docker upgrade instructions](../README.md#upgrading-an-existing-docker-installation)
