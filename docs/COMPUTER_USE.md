# Computer use

With computer use on, OASIS can see your screen and use the mouse and keyboard. That covers desktop apps, system dialogs and anything else the browser tool (`--chrome`) cannot reach. It works with any model that accepts images: screenshots come back to the model in the tool result.

```bash
oasis computer-use doctor     # what this machine still needs
oasis --computer-use          # start a session with the tool on
```

Inside a session, `/computer on`, `/computer off`, `/computer status` and `/computer doctor` do the same. Set `OASIS_COMPUTER_USE=1` or the `computerUse` setting to turn it on by default.

## What the agent can do

The tool is called `computer`. Its actions:

| Action | What it does |
| --- | --- |
| `screenshot` | Capture the screen (scaled to fit 1280x800) |
| `zoom` | Capture one region at full resolution, for small text |
| `click`, `double_click`, `triple_click`, `right_click`, `middle_click` | Click at a point |
| `move`, `drag`, `mouse_down`, `mouse_up` | Move the pointer, drag, or hold a button |
| `scroll` | Scroll up, down, left or right at a point |
| `type`, `key` | Type text, or press a key or chord such as `ctrl+s` |
| `wait`, `cursor_position` | Pause, or report where the pointer is |
| `list_windows`, `focus_window` | List open windows and bring one to the front |

The model works in screenshot pixels. OASIS maps them back to real display coordinates, including Retina scaling on macOS. Input actions take a fresh screenshot afterwards unless the model passes `capture_after: false`, and identical screenshots in a row are not sent again.

## Setup

### Linux (X11)

```bash
sudo apt install xdotool scrot      # or: dnf install xdotool scrot / pacman -S xdotool scrot
```

`DISPLAY` must be set; `OASIS_COMPUTER_DISPLAY` overrides it, for example to point the agent at a virtual display (`Xvfb :99 &` then `OASIS_COMPUTER_DISPLAY=:99`). Screens are captured with scrot, gnome-screenshot, ImageMagick `import` or `xwd`, whichever is installed.

On Wayland, screenshots work with `grim`, but input needs X11 or XWayland with `DISPLAY` set.

### macOS

Nothing to install. The first time, macOS asks for two permissions for your terminal app (System Settings > Privacy & Security):

- Screen Recording, for `screencapture`
- Accessibility, for mouse and keyboard events

### Windows

Nothing to install. OASIS uses PowerShell with `System.Drawing` for capture and `user32` for input. Elevated windows (admin prompts) ignore input from a normal process, which is a Windows rule.

## Safety

- `--restricted` refuses the tool, and plan mode blocks it.
- The first action that sends input asks once per session. An allow rule (`oasis permissions add allow "computer"`) or a bypass mode counts as that approval. Screenshots, zoom and window lists never ask.
- Some chords are always refused: log out, lock screen, force quit and empty trash.
- Typing known shell one-liners is always refused: `curl ... | sh`, `rm -rf /`, fork bombs, `iex (irm ...)`, `mkfs`, `format C:`.
- Text on screen is treated as untrusted content. Instructions that appear in a window are not instructions from you.
- Masked secrets stay masked: the tool never types the real value of a secret the model only saw as a placeholder.

The agent is driving your real desktop. Keep an eye on it, or point it at a virtual display.

## Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `OASIS_COMPUTER_USE` | off | `1` turns the tool on for new sessions |
| `OASIS_COMPUTER_DISPLAY` | `$DISPLAY` | X display to capture and drive (Linux) |
| `OASIS_COMPUTER_MAX_WIDTH` | 1280 | Largest screenshot width sent to the model |
| `OASIS_COMPUTER_SETTLE_MS` | 600 | Pause after an input action before capturing |

## Credits

The approach (xdotool, the scaling targets, zoom) follows [Anthropic's computer-use reference implementation](https://github.com/anthropics/claude-quickstarts/tree/main/computer-use-demo), and the refused chords and patterns follow [Hermes Agent's computer_use tool](https://hermes-agent.nousresearch.com/docs/user-guide/features/computer-use). Both are MIT licensed; see [THIRD-PARTY-NOTICES.md](../THIRD-PARTY-NOTICES.md).
