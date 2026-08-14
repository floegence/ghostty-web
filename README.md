# @floegence/ghostty-web

> [!IMPORTANT]
> This fork is no longer maintained. It has been superseded by
> [FloeTerm 0.15.4](https://github.com/floegence/floeterm/tree/v0.15.4), which
> uses a server-side native Ghostty engine and sends semantic presentations to
> browser views. New integrations should use
> [`@floegence/floeterm-terminal-web@0.15.4`](https://www.npmjs.com/package/@floegence/floeterm-terminal-web/v/0.15.4)
> with
> [`terminal-go@v0.10.3`](https://github.com/floegence/floeterm/tree/terminal-go/v0.10.3/terminal-go).
> Existing tags and releases remain available only for historical reproduction.

[![license](https://img.shields.io/github/license/floegence/ghostty-web)](./LICENSE)

This is the FloeTerm-maintained fork of Coder's ghostty-web. It publishes only
`@floegence/ghostty-web` and adds a versioned, validated logical checkpoint API
for durable terminal reconstruction.

[Ghostty](https://github.com/ghostty-org/ghostty) for the web with [xterm.js](https://github.com/xtermjs/xterm.js) API compatibility — giving you a proper VT100 implementation in the browser.

- Migrate from xterm by changing your import: `@xterm/xterm` → `@floegence/ghostty-web`
- WASM-compiled parser from Ghostty—the same code that runs the native app
- Zero runtime dependencies, ~400KB WASM bundle

Originally created for [Mux](https://github.com/coder/mux) (a desktop app for isolated, parallel agentic development), but designed to be used anywhere.

![ghostty](https://github.com/user-attachments/assets/aceee7eb-d57b-4d89-ac3d-ee1885d0187a)

## Comparison with xterm.js

xterm.js is everywhere—VS Code, Hyper, countless web terminals. But it has fundamental issues:

| Issue                                    | xterm.js                                                         | ghostty-web                |
| ---------------------------------------- | ---------------------------------------------------------------- | -------------------------- |
| **Complex scripts** (Devanagari, Arabic) | Rendering issues                                                 | ✓ Proper grapheme handling |
| **XTPUSHSGR/XTPOPSGR**                   | [Not supported](https://github.com/xtermjs/xterm.js/issues/2570) | ✓ Full support             |

xterm.js reimplements terminal emulation in JavaScript. Every escape sequence, every edge case, every Unicode quirk—all hand-coded. Ghostty's emulator is the same battle-tested code that runs the native Ghostty app.

## Installation

```bash
npm install @floegence/ghostty-web
```

## Usage

`@floegence/ghostty-web` aims to be API-compatible with the xterm.js API.

```javascript
import { init, Terminal } from '@floegence/ghostty-web';

await init();

const term = new Terminal({
  fontSize: 14,
  theme: {
    background: '#1a1b26',
    foreground: '#a9b1d6',
  },
});

term.open(document.getElementById('terminal'));
term.onData((data) => websocket.send(data));
websocket.onmessage = (e) => term.write(e.data);
```

For a comprehensive client <-> server example, refer to the [demo](./demo/index.html#L141).

## Development

This fork builds from pinned Ghostty commit
`5714ed07a1012573261b7b7e3ed2add9c1504496` with
[`patches/ghostty-wasm-api.patch`](./patches/ghostty-wasm-api.patch). The patch
owns the C/WASM terminal and checkpoint ABI; TypeScript never serializes raw
WASM memory or implements a second VT parser.

> Requires Zig and Bun.

```bash
bun run build
```

The original Coder project and Ghostty remain credited under their MIT licenses
in [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).

## License

[MIT](./LICENSE)
