# tabby-output-trail

Smooth scrolling of terminal output for [Tabby](https://github.com/Eugeny/tabby).

When new output pushes the screen up, the content glides into place instead
of jumping a whole row at a time. It pairs well with
[tabby-cursor-trail](https://github.com/paolocalosso/tabby-cursor-trail).

Tested with Tabby 1.0.238 (xterm.js 5.5) on Linux.

## Light by design

- **Output is never slowed down.** The plugin only observes the terminal; it
  doesn't touch the data stream. Pushing 100,000 lines takes the same time
  with and without it (measured in Chromium with xterm.js 5.5: within ±1%,
  i.e. noise).
- **Almost no CPU.** Each write only sets a flag, the real work runs once per
  animation frame and only while output is arriving, and the glide itself is
  a CSS transform animated by the browser's compositor (GPU), with no
  JavaScript per frame. With no output, the plugin does nothing at all.
- **Knows when to stay out of the way.** Big chunks of output and continuous
  streams (`cat`, build logs) jump as usual; full-screen apps (vim, htop,
  less) and a scrolled-back view are never animated. It also respects the
  system's "reduce motion" setting.

## Install

### From Tabby

Settings → Plugins, search for **output-trail**, click Install, restart Tabby.

### Manually

Copy (or symlink) this folder to `~/.config/tabby/plugins/node_modules/tabby-output-trail`
and restart Tabby. It's plain JavaScript, there is nothing to build.

## Settings

**Settings → Output trail**, with a live preview:

| Option | Default | |
|---|---|---|
| Enable | on | |
| Glide duration | 110 ms | how long new lines take to slide into place |
| Maximum lines per glide | 3 | bigger chunks jump instead of gliding |
| Stream filter | 400 ms | output that keeps scrolling longer than this stops gliding until it pauses |

The same options live in Tabby's `config.yaml` under `outputTrail`
(`enabled`, `duration`, `maxLines`, `streamMs`).

## How it works

A `TerminalDecorator` attaches to every terminal. After xterm.js parses a
write, the plugin schedules one animation frame; in that frame it measures how
many lines scrolled and, if it's a small step while you're following the
output, animates `.xterm-screen` from that many rows lower back to its place
with the Web Animations API. A new step during a glide continues from the
current offset, so consecutive lines stay smooth.

Counting scrolled lines uses `baseY` plus an xterm.js marker: when the
scrollback is full xterm drops the oldest lines and `baseY` stops growing,
but the marker moves up by the number of dropped lines, so the count stays
right. It also reads one internal xterm.js field for the cell height
(`_core._renderService.dimensions`), with a fallback, so a major xterm.js
upgrade inside Tabby may need a small fix. If something breaks, look for
`[tabby-output-trail]` in the dev tools console (`Ctrl+Shift+I`).

## License

MIT © Paolo Calosso
