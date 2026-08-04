<img src="build/icon.svg" width="96" align="left" alt="Muleteer" />

## Muleteer

A media center for aMule: play your files, and discover new music and video from
the network and from other users. Smart download suggestions are driven by your
own search preferences.

<br clear="left" />

Make sure aMule is running and [is configured to accept connections](./amule-conf.webp).

Requires [nodejs](https://github.com/nvm-sh/nvm) and VLC.

Run:
```
npm ci
npm start
```

`npm start` first runs `scripts/dev-brand.js`, which renames the stock
`node_modules/electron/dist/Electron.app` to `Muleteer.app` (binary and
`CFBundleExecutable` included) and repoints the electron package's `path.txt`.
Without it macOS shows "Electron" in the Cmd-Tab switcher, the Dock and the menu
bar — `app.setName()` cannot change that, because the bundle is read before any
JS runs, and the switcher goes by the bundle/executable name rather than
`CFBundleName`. It is idempotent and re-applies itself after a fresh `npm ci`.
Packaged builds get their name and icon from electron-builder instead.

### Icon

`build/icon.svg` is the source of truth; `build/icon.icns` and `build/icon.png`
are generated from it and committed. After editing the SVG:

```
npm run icon
```

Requires `rsvg-convert` (`brew install librsvg`).

Note: this app is vibe coded using [this project as a base](https://github.com/got3nks/amule-ec-node).
