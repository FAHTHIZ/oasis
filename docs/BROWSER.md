# Browser

`oasis --browser` (or `/browser on`, or `"chrome": true` in settings) gives the
agent a browser it drives over the Chrome DevTools Protocol (CDP). It opens
pages, reads them, fills forms, signs in, downloads files, takes screenshots
and checks the console and network. `--chrome` and `/chrome` are the same
switch under their older names.

There are two engines behind the one `browser` tool:

| Engine | What it is | When it runs |
| --- | --- | --- |
| [Obscura](https://github.com/h4ckf0r0day/obscura) | A headless browser written in Rust, with V8 for JavaScript and its own DOM, layout and renderer. One process of about 80 MB on disk. | The default when it is installed (`oasis browser install`). |
| Chrome, Chromium or Edge | The full browser, headless or in a window. | When Obscura is not installed; when a window is wanted (a desktop session, `--computer-use=virtual`); when a site needs a full browser (see [fallback](#fallback-to-chrome)); or when `OASIS_BROWSER_ENGINE=chrome`. |

```bash
oasis browser status          # which engines are installed and which one runs
oasis browser install         # fetch the pinned Obscura release (SHA-256 checked)
OASIS_BROWSER_ENGINE=chrome oasis --browser   # always use Chrome
```

`oasis doctor` prints one line about the browser, and inside a session
`/browser status` shows the same information plus whether a browser is open.

## Why two engines

Obscura starts about eight times faster and uses a fifth to a tenth of the
memory, so an agent can open a browser for a quick lookup without the cost of a
full Chrome, and four agents with a browser each finish in a quarter of
Chrome's time. It is not a full browser, though:
some sites refuse it, pages with hundreds of images load slowly in it, and it
cannot show a window. Replacing Chrome outright would have made everyday
browsing worse, so Chrome stays, and Oasis switches to it on its own when a
page needs it. The [benchmarks](#benchmarks) below are the measurements this
choice is based on.

## What the agent can do

The tool's actions are `navigate`, `snapshot`, `read`, `click`, `type`,
`select`, `hover`, `press`, `scroll`, `wait`, `screenshot`, `evaluate`,
`back`, `forward`, `reload`, `download`, `recording`, `console`, `network`,
`tabs`, `new_tab`, `switch_tab`, `close_tab`, `engine` and `close`.

- `snapshot` lists the interactive elements with short refs (`e12`), their
  accessible names, roles and states; `click`, `type`, `select` and `hover`
  take a ref or visible text. Refs are kept in a page-side registry, not in
  DOM attributes, so pages cannot read or forge them.
- `read` returns the page as Markdown, with a note when it was cut.
- `type` clears a field the way a person would, so React, Vue and similar
  frameworks see the change; `submit: true` presses Enter and only falls back
  to submitting the form when Enter did nothing.
- Clicking a download link, or `download` with a URL, saves the file under
  `.oasis/downloads/` with a safe, unique name (Content-Disposition is
  honoured; Windows device names and path tricks are neutralised) and the tab
  stays on the page. `OASIS_BROWSER_DOWNLOAD_MAX_MB` (default 512) caps size.
- `engine` reports the running engine, and `engine` with `engine: "chrome"`
  or `"obscura"` switches; the open tabs are reopened at their addresses with the cookies carried over.
- Calls to one session's browser are queued, so two tool calls in the same
  turn never interleave on a tab.
- Each step that changes the page keeps a small captioned screenshot; the
  `recording` action or closing the browser saves them as a self-contained
  HTML player in `.oasis/recordings/` (`OASIS_BROWSER_RECORD=0` turns it off).
  Typed text is never written into captions.

## Fallback to Chrome

With the automatic engine (`OASIS_BROWSER_ENGINE=auto`, the default), a page
that Obscura loads as a bot challenge (Cloudflare "Just a moment...",
Turnstile, hCaptcha or reCAPTCHA interstitials, "verify you are human" pages)
or that it leaves empty or never finishes loading, is opened again in Chrome, and the result says so.
The switch keeps the tabs and carries the cookies over. It does not happen when the agent asked for an
engine explicitly, when Oasis is attached to your own Chrome
(`OASIS_CHROME_PORT`), when no Chrome is installed, or with
`OASIS_BROWSER_FALLBACK=0`. A challenge Chrome also gets (some sites block
datacenter addresses whatever the browser) is reported, not retried.

## Sessions, isolation and persistence

- Every Oasis session gets its own browser process with a fresh, private
  profile (mode 700), deleted when the browser closes. Subagents get their
  own browser and never share the parent's profile.
- `OASIS_BROWSER_PROFILE=<folder>` keeps cookies and storage (and so
  sign-ins) between sessions, in `<folder>/obscura` and `<folder>/chrome`.
  The two engines do not share cookies.
- One CDP WebSocket per browser carries all tabs as flattened sessions, so
  opening a tab does not open another connection, and closing the browser
  rejects every pending call instead of leaving it hanging.
- A browser that fails to start is killed and its profile removed; a crashed
  browser is noticed on the next call and started again.

## Security

The browser is treated as untrusted input and as a way out of the machine:

- Navigation approval is per origin for web pages and per exact URL for
  opaque targets (`data:`, `file:`, `about:srcdoc`, `blob:`). Same-origin
  links and forms pass; a cross-origin link, form, script navigation or
  redirect asks first. A refused navigation leaves the tab on the page it
  was on, at the same address, so relative links keep working.
- Requests to private, loopback and link-local addresses need approval: every
  DNS record of a host is checked, not just the first. Obscura also refuses
  private addresses and `file:` itself until Oasis widens it after such an
  approval (the browser is restarted with `--allow-private-network` or
  `--allow-file-access` for that session only).
- Text from pages goes through the prompt-injection guard; after a flagged
  page, typing and `evaluate` need a person for the rest of the turn.
  `evaluate` always asks in the default mode.
- The DevTools endpoint listens on `127.0.0.1` on a random port and is never
  exposed. Attaching to your own Chrome (`OASIS_CHROME_PORT`) is opt-in.
- Obscura is downloaded only with your approval (or
  `OASIS_OBSCURA_AUTO_INSTALL=1`), from the pinned release, and its SHA-256
  must match the digest in `src/browser-engine.mjs` before it is unpacked.
  The install is atomic: a failed or tampered download leaves nothing behind.
  `OASIS_OBSCURA_PATH` uses a binary you built yourself.

Known gap: Obscura does not pause redirect hops for inspection (upstream
issue #1540). Oasis checks where the page landed and goes back if that origin
was not approved, but when the session has already been allowed to reach
private addresses, the redirected request itself has been made by then. For
untrusted sites that redirect into your network, use Chrome
(`OASIS_BROWSER_ENGINE=chrome`) or run Oasis in a sandbox.

## Obscura limitations and what Oasis does about them

| Limitation (upstream issue) | Effect | What Oasis does |
| --- | --- | --- |
| Bot checks and some sites refuse a non-Chrome browser | Challenge pages | Automatic fallback to Chrome |
| Image-heavy pages load slowly (one thread per connection) | A page with hundreds of images can take 5-12 s, where Chrome takes 1-2 s | The fallback does not trigger on slowness; set `OASIS_BROWSER_ENGINE=chrome` for image-heavy browsing |
| Tabs in one process run one at a time, and cookies are per CDP connection, so tabs cannot be split across connections | Several tabs of one browser loading at once are not faster | No effect on the tool, which runs one session's calls in order anyway; separate sessions and subagents each get their own process and run in parallel |
| Events sometimes carry the browser's default session id | Lost navigation and request events | Routed to the attached tab, duplicates dropped |
| `Page.navigateToHistoryEntry` stalls while request interception is on | Back/forward hung | Interception is paused around the history step |
| A 204 answer to a blocked request blanks the page; `location.href` and history keep the blocked address (#1628) | Ghost URLs after a refusal | Blocked requests fail instead, and the address is put back |
| `data:` navigations can load even when refused | A refused page shown under the old address | The approved page is reloaded |
| Downloads open as pages (#1541) | No file | Oasis saves the file itself and returns to the page |
| No visible window, no cert-error bypass (#1483, #1635) | | Chrome is used for visible windows; certificate errors stay errors |
| Shadow-root clicks (#1662), pointer events from mouse moves (#1594) | Some custom widgets do not react | Elements with no layout box are clicked through the DOM; for other widgets the agent can switch with the `engine` action |
| Accessibility tree gaps (#1667, #1663, #1520) | | Snapshots are built from the DOM, not the engine's accessibility tree |

## Benchmarks

`npm run bench:browser` measures both engines on the same generated page
(`--runs`, `--parallel`, `--live` for public sites, `--json`). Medians of 5 runs
recorded 24 November 2026 on Linux x64 (2 CPUs, 8 GB), Obscura 0.2.7 and
Chrome for Testing 147 headless, with memory as the proportional set size of
the whole process tree ([raw JSON](../bench/results/browser-2026-11-24.json)):

| | Obscura | Chrome |
| --- | --- | --- |
| Launch to first CDP answer | 34 ms | 284 ms |
| Navigate, cold / warm | 38 / 28 ms | 62 / 35 ms |
| Snapshot of the interactive elements | 48 ms | 10 ms |
| Screenshot | 101 ms | 84 ms |
| Memory idle / with the page loaded | 12 / 44 MB | 212 / 258 MB |
| 4 tabs in one browser, loading at once: wall time / memory | 768 ms / 92 MB | 330 ms / 321 MB |
| 4 sessions, one browser each (launch included): wall time / memory | 548 ms / 139 MB | 2,029 ms / 816 MB |

Memory figures vary between runs by 10-15 MB because shared pages are split
between processes; an earlier 3-run measurement gave Obscura 25 / 64 MB and
Chrome 299 / 340 MB.

On public sites (one run, through the full tool, same network): example.com
133 vs 246 ms, Wikipedia "Web browser" 543 vs 348 ms, Hacker News 953 vs
781 ms, MDN 892 vs 348 ms. Wikipedia's "Dhaka" article, with 243 images,
took about 12.6 s on Obscura and 1.6 s on Chrome. Stack Overflow serves
Obscura a Cloudflare challenge and was opened in Chrome by the fallback.
Reddit and Amazon blocked both engines from a datacenter address.

In short: Obscura wins on startup, memory and many agents browsing at once by
a wide margin, and is close on light pages; Chrome wins on heavy pages, several
tabs of one browser loading at once, script speed (snapshots) and site
compatibility.

Outside comparisons of headless browsers for agents, for further reading:
[doccraft](https://doccraft.dev/blog/best-headless-browser-ai-agents),
[Jacar](https://jacar.es/en/lightpanda-vs-obscura-headless-browser-benchmark/),
[Wavect](https://wavect.io/blog/obscura-rust-browser-ai-agents/) and
[Review Ramble](https://www.reviewramble.com/headless-browsers-for-ai-agents-run-or-rent/).
Lightpanda, the other fast engine they compare, is AGPL-3.0, which does not
fit an Apache-2.0 project that ships it to users, so it was not adopted.

## Other clients

Oasis speaks plain CDP, so the engines also serve other tools: `obscura serve
--port 9222` is a CDP endpoint for Playwright (`chromium.connectOverCDP`) and
Puppeteer (`puppeteer.connect`), and `OASIS_CHROME_PORT=9222` makes Oasis
attach to an endpoint you started (Chrome or Obscura) instead of launching
one. Browser MCP servers can be added as usual (`oasis mcp add`); the
built-in tool does not need one.

## Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `OASIS_BROWSER_ENGINE` | `auto` | `auto`, `obscura` or `chrome` (`chromium`, `edge` and `brave` mean Chrome) |
| `OASIS_BROWSER_FALLBACK` | on | `0` keeps Obscura even on challenge pages |
| `OASIS_OBSCURA_PATH` | | An Obscura binary to use instead of the installed one |
| `OASIS_OBSCURA_CACHE` | per-user cache | Where `oasis browser install` puts Obscura (`~/.cache/oasis/obscura` on Linux) |
| `OASIS_OBSCURA_AUTO_INSTALL` | off | `1` installs Obscura without asking when it is needed |
| `OASIS_BROWSER_STEALTH` | off | `1` starts Obscura with `--stealth` (a consistent fingerprint; TLS impersonation and tracker blocking need Obscura's `-stealth` build, used through `OASIS_OBSCURA_PATH`) |
| `OASIS_BROWSER_PROFILE` | none | Folder that keeps cookies and storage between sessions |
| `OASIS_BROWSER_DOWNLOAD_MAX_MB` | 512 | Largest file the browser saves |
| `OASIS_BROWSER_RECORD` | on | `0` stops step screenshots and recordings |
| `OASIS_CHROME_PATH` | auto-detected | Chrome, Chromium or Edge executable |
| `OASIS_CHROME_HEADLESS` | headless without a display | `0` shows a Chrome window, `1` hides it |
| `OASIS_CHROME_PORT` | | Attach to a running browser's DevTools port instead of launching |
| `OASIS_CHROME_NO_SANDBOX` | off | `1` starts Chrome with `--no-sandbox` (containers that need it) |
