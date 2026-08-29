# Claude Limits

A floating panel that shows how much of your Claude plan you have used, pinned to
the corner of the Claude Desktop window. It appears when the app starts and closes
with it.

*[Русская версия](README.ru.md)*

![Panel](docs/panel.png)

Installed as an ordinary Claude Desktop extension (`.mcpb`). It does not modify the
application, so app updates cannot break it, and removing it leaves nothing behind.

## Contents

- [What it shows](#what-it-shows)
- [Requirements](#requirements)
- [Installation](#installation)
- [Using the panel](#using-the-panel)
- [Chat tools](#chat-tools)
- [Where the data comes from](#where-the-data-comes-from)
- [Limitations](#limitations)
- [Settings and environment variables](#settings-and-environment-variables)
- [Troubleshooting](#troubleshooting)
- [Building from source](#building-from-source)
- [Repository layout](#repository-layout)
- [License](#license)

## What it shows

One bar per limit window your plan reports: **5 hours**, **7 days**, and the
per-model windows (Sonnet, Opus, OAuth apps, Cowork) when the app records them.

Bars fill with **consumption**, not with what is left: empty means the window is
untouched, full means it is spent. Colours change at fixed thresholds.

| Used | Colour |
|------|--------|
| below 80% | green |
| 80–89% | yellow |
| 90% and above | red |

Four looks — card, compact, bar and icon — switchable from the panel itself:

![Styles](docs/styles.png)

In icon mode a left click opens the limits, a right click opens settings.

## Requirements

**The extension** needs Claude Desktop with support for MCP extensions and MCP
Apps. Node.js ships with the app, so nothing extra is needed for the chat tools.

**The floating panel** additionally needs a Linux desktop running X11, with GTK 3
and WebKitGTK available to Python:

```bash
# Debian / Ubuntu / Linux Mint
sudo apt install python3-gi gir1.2-gtk-3.0 gir1.2-webkit2-4.1 xdotool

# Fedora
sudo dnf install python3-gobject gtk3 webkit2gtk4.1 xdotool

# Arch
sudo pacman -S python-gobject gtk3 webkit2gtk-4.1 xdotool
```

`xdotool` is optional: without it the panel still runs, but it sits in the corner
of the screen instead of following the Claude Desktop window.

If any of this is missing, the app keeps working normally — only the panel stays
down, and `overlay_status` reports exactly what was not found.

## Installation

1. Download `claude-limits.mcpb` from the [latest release](../../releases/latest).
2. In Claude Desktop open **Settings → Extensions → Advanced → Install Extension**
   and pick the file. Dragging the file onto the app window works too.
3. Enable the extension.
4. **Restart Claude Desktop completely.** The extension's server is started by the
   app, so the panel appears only after a full restart.

To update, install the newer `.mcpb` over the old one and restart the app again.
To remove it, delete the extension in the same settings screen. Installation needs
no `sudo` and touches no system files.

## Using the panel

The gear button opens the settings:

![Settings](docs/settings.png)

- **View** — card, compact, bar or icon.
- **Show** — reset time and last-update time.
- **Font size** — four steps; the whole panel scales, not just the text.
- **Language** — English, Russian, German or Chinese. Defaults to the system
  language.

Choices are stored in `claude-limits-overlay.json` next to the Claude config and
survive restarts.

The panel refreshes three ways: it watches the usage cache file and redraws almost
immediately when it changes, it re-reads once a minute, and the ↻ button forces a
refresh. While a refresh is in flight the button shows `…`, so a click is visible
even when the numbers do not change.

## Chat tools

| Tool | What it does |
|------|--------------|
| `show_limits` | Show a usage panel in the chat. |
| `get_limits` | Return usage as text and JSON. |
| `overlay_status` | Whether the floating panel is running, and why it is not. |
| `overlay_restart` | Restart the panel; `off: true` closes it. |
| `diagnose` | Which local data sources and desktop environment were found. |

## Where the data comes from

Nothing is sent anywhere. Usage is read from files on your machine:

1. **The app's own usage cache** — `plan-usage-history.json` in the Claude config
   directory, written by Claude Desktop itself. This is the primary source.
2. **The extension's cache** — `claude-limits-cache.json`, written next to it when
   the in-chat panel manages a live reading.

Config directory by platform:

| Platform | Path |
|----------|------|
| Linux | `~/.config/Claude` |
| macOS | `~/Library/Application Support/Claude` |
| Windows | `%APPDATA%\Claude` |

The cache stores limit windows under short keys (`fh`, `sd`, `sds`, `sdo`, …); the
extension maps them to readable names.

## Limitations

Worth knowing before you install:

- **The floating panel is Linux/X11 only.** On Wayland a window cannot position
  itself, so the panel will not sit in the corner of the Claude window; on macOS it
  needs PyGObject and WebKitGTK, which are not standard there; on Windows it does
  not start at all. The chat tools work on every platform.
- **The panel only shows what the app already recorded.** If Claude Desktop has not
  written its usage cache yet, there is nothing to display. Run `diagnose` to see
  whether the file exists.
- **No reset times in the local cache.** "resets at …" lines appear only when data
  comes from a live reading through the in-chat panel.
- **Unknown metrics are ignored.** A key that is not a known limit window is not
  shown, because there is no way to tell whether it means "used" or "left".
  `diagnose` lists such keys under `unmappedKeys`.
- **One panel per machine.** If Claude Desktop starts the extension server more
  than once, only the first panel appears.
- **The cache format is not a public API.** It is written by the app for its own
  use and may change without notice. If it does, the panel reports that data is
  unavailable rather than showing wrong numbers.
- This is an independent project, not affiliated with or endorsed by Anthropic.

## Settings and environment variables

Two options live in the extension card in Claude Desktop:

- **Floating panel on startup** — turn the window off and keep only the chat tools.
- **Path to python3** — set this when GTK is installed for a different `python3`
  than the first one found.

For debugging, the server also reads:

| Variable | Meaning |
|----------|---------|
| `CLAUDE_LIMITS_OVERLAY` | `off` / `false` / `0` disables the panel. |
| `CLAUDE_LIMITS_PYTHON` | Interpreter used for the panel process. |
| `CLAUDE_LIMITS_REFRESH_MS` | Poll interval, minimum 5000, default 60000. |
| `CLAUDE_LIMITS_STATE_DIR` | Where panel settings and the lock file are stored. |
| `CLAUDE_CONFIG_DIR` | Claude config directory to read the usage cache from. |

## Troubleshooting

Start with `overlay_status` in the chat. It reports the session variables the
server found, the interpreter, the WebKit version, whether it is tracking the
Claude window, and the data counters `pushes` / `lastPush` / `lastPayloadAt`.

| Symptom | Likely cause |
|---------|--------------|
| `reason` mentions GTK or python3 | Install the packages from [Requirements](#requirements). |
| `reason` mentions the graphical session | The server could not find `DISPLAY`; it normally reads it from the app's process. Report this along with the `sessionEnv` field. |
| Panel runs, numbers never change | If `pushes` keeps growing, the app is not updating its usage cache — the panel has nothing new to show. |
| Panel is not in the window corner | `xdotool` is missing, or the session is Wayland rather than X11. |
| Nothing at all after install | The app was not restarted; the server only starts with the app. |

`diagnose` shows the deeper picture: which config directories and cache files were
found, the structure of the cache, and any unmapped keys.

## Building from source

The bundle is plain JavaScript, Python and HTML — no build step, no dependencies to
install:

```bash
git clone https://github.com/maxsoft87/claude-limits.git
cd claude-limits
npx @anthropic-ai/mcpb validate manifest.json
npx @anthropic-ai/mcpb pack . claude-limits.mcpb
```

The resulting `.mcpb` is the file you install.

## Repository layout

```
manifest.json        extension manifest (MCPB)
server/
  index.js           MCP server over stdio, no dependencies
  sources.js         reads and normalises the local usage cache
  overlay.js         starts the panel process and feeds it data
overlay/
  overlay.py         GTK + WebKit window, positioning, lifecycle
  overlay.html       the panel itself, four styles, four languages
ui/
  panel.html         the in-chat panel (MCP Apps resource)
docs/                screenshots used by this README
```

The panel process is started by the extension's server and receives data as JSON
lines on stdin. When Claude Desktop exits, the server's stdin closes and the window
goes down with it.

## License

MIT. See [LICENSE](LICENSE).
