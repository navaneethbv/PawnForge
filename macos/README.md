# macOS launcher

PawnForge uses a Chrome extension for browser access and page overlays.
The native companion is a small menu bar launcher that starts and stops the local Node.js server, opens the PawnForge web app, and opens Chrome's extension manager.
It does not read browser pages directly, which keeps page access scoped to the Chrome extension permission model.

## Run from the repository

```bash
swift run --package-path macos -- --repo /Users/navaneethbv/Desktop/Projects/PawnForge
```

When launched from the repository directory, `--repo` can be omitted.
The launcher starts the server on port `4173` and looks for Node.js 22 or newer in `PATH`, Homebrew, and the standard system locations.

After the server starts, load the repository root as an unpacked extension in Chrome once.
The menu item **Open Chrome extensions** takes you to that setup page.

The menu is attached to the menu bar status item and refreshes when the server exits.
Choosing a different repository stops the previous server before starting the selected one.
Stopping the server also terminates its Stockfish workers.
Verify the native menu manually after `swift build --package-path macos`; compilation alone does not verify menu interaction.
