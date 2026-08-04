#!/usr/bin/env node
"use strict";

/**
 * `npm start` runs the app inside node_modules' stock Electron.app, so macOS
 * shows "Electron" in the Cmd-Tab switcher, the Dock and the menu bar.
 * app.setName() cannot change that — the bundle is read before any JS runs.
 *
 * Setting CFBundleName/CFBundleDisplayName is not enough either: the Cmd-Tab
 * switcher ignores them (LaunchServices reports the right LSDisplayName while
 * the switcher still draws "Electron") and goes by the bundle and executable
 * name. So rename the bundle to Muleteer.app and its binary to Muleteer, then
 * repoint the electron package's path.txt, which is the single source of truth
 * for both `require('electron')` and the `electron` CLI.
 *
 * Safe to do: the dist is ad-hoc *linker-signed* with "Info.plist=not bound"
 * and "Sealed Resources=none", so neither the plist edit nor renaming files
 * touches what the signature actually covers.
 *
 * Runs as `prestart` and is idempotent; node_modules is gitignored, so it
 * simply re-applies after a fresh npm ci. Packaged builds get their name and
 * icon from electron-builder and never need any of this.
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const APP_NAME = "Muleteer";
const ICON_NAME = "muleteer.icns";
const PLIST_BUDDY = "/usr/libexec/PlistBuddy";

function warn(msg) {
  console.warn(`[dev-brand] ${msg}`);
}

function plistSet(plist, key, value) {
  try {
    execFileSync(PLIST_BUDDY, ["-c", `Set :${key} ${value}`, plist], { stdio: "pipe" });
  } catch (_) {
    execFileSync(PLIST_BUDDY, ["-c", `Add :${key} string ${value}`, plist], { stdio: "pipe" });
  }
}

function main() {
  if (process.platform !== "darwin") return;

  // require.resolve, not require: a half-renamed dist makes require('electron') throw.
  const pkgDir = path.dirname(require.resolve("electron"));
  const dist = path.join(pkgDir, "dist");
  if (!fs.existsSync(dist)) {
    warn(`no Electron dist at ${dist}; skipping.`);
    return;
  }

  const stock = path.join(dist, "Electron.app");
  const bundle = path.join(dist, `${APP_NAME}.app`);

  // A fresh npm ci restores Electron.app; any previously branded bundle beside
  // it is stale, so drop it and rebrand the newly installed one.
  if (fs.existsSync(stock)) {
    fs.rmSync(bundle, { recursive: true, force: true });
    fs.renameSync(stock, bundle);
  }
  if (!fs.existsSync(bundle)) {
    warn(`no Electron.app or ${APP_NAME}.app in ${dist}; skipping.`);
    return;
  }

  const contents = path.join(bundle, "Contents");
  const plist = path.join(contents, "Info.plist");
  if (!fs.existsSync(plist)) {
    warn(`no Info.plist at ${plist}; skipping.`);
    return;
  }

  const stockBin = path.join(contents, "MacOS", "Electron");
  const brandedBin = path.join(contents, "MacOS", APP_NAME);
  if (fs.existsSync(stockBin) && !fs.existsSync(brandedBin)) {
    fs.renameSync(stockBin, brandedBin);
  }

  const icns = path.join(__dirname, "..", "build", "icon.icns");
  if (fs.existsSync(icns)) {
    fs.copyFileSync(icns, path.join(contents, "Resources", ICON_NAME));
    plistSet(plist, "CFBundleIconFile", ICON_NAME);
  }

  plistSet(plist, "CFBundleExecutable", APP_NAME);
  plistSet(plist, "CFBundleName", APP_NAME);
  plistSet(plist, "CFBundleDisplayName", APP_NAME);

  // path.txt is relative to dist/ and drives both require('electron') and the CLI.
  fs.writeFileSync(
    path.join(pkgDir, "path.txt"),
    `${APP_NAME}.app/Contents/MacOS/${APP_NAME}`,
    "utf8"
  );

  // macOS caches bundle names and icons; nudge LaunchServices to re-read them.
  try {
    fs.utimesSync(bundle, new Date(), new Date());
    execFileSync(
      "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister",
      ["-f", bundle],
      { stdio: "ignore" }
    );
  } catch (_) {
    /* cosmetic only */
  }

  console.log(`[dev-brand] dev bundle is ${APP_NAME}.app with executable ${APP_NAME}.`);
}

try {
  main();
} catch (err) {
  // Never block `npm start` over branding.
  warn(`skipped: ${err?.message || err}`);
}
