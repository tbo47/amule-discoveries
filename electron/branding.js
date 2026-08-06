"use strict";

const fs = require("fs");
const path = require("path");
const { app } = require("electron");

const APP_NAME = "Muleteer";
const ICON_PNG = path.join(__dirname, "..", "build", "icon.png");

// userData directories this app wrote to before it was renamed. Unpackaged
// `npm start` used "Electron" (there is no package.json beside main.js, so
// Electron fell back to its own name); packaged builds used "aMule Discoveries".
const LEGACY_DIR_NAMES = ["aMule Discoveries", "Electron"];

// The legacy "Electron" directory is shared with every other unpackaged
// Electron app on this machine, so only these known-ours files are ever
// copied out of it — never the directory wholesale.
//
// discoveries.json and peers.json are deliberately absent: those stores moved
// to muleteer.db, so copying them across would only carry dead weight.
const OWNED_FILES = [
  "connection.json",
  "collection.json",
  "playback.json",
];

const MIGRATION_MARKER = ".migrated-from-legacy";

/** Must be called before app ready, and before anything reads app.getPath("userData"). */
function applyAppName() {
  app.setName(APP_NAME);
}

/**
 * Renaming the app moves userData, which would orphan the user's collection,
 * discoveries and peer history. Copy those across once, leaving the originals
 * in place as a fallback.
 */
function migrateLegacyUserData() {
  try {
    const userData = app.getPath("userData");
    const marker = path.join(userData, MIGRATION_MARKER);
    if (fs.existsSync(marker)) return;

    const appData = app.getPath("appData");
    const legacyDirs = LEGACY_DIR_NAMES.map((n) => path.join(appData, n)).filter(
      (d) => d !== userData && fs.existsSync(d)
    );

    fs.mkdirSync(userData, { recursive: true });

    const copied = [];
    for (const name of OWNED_FILES) {
      const dest = path.join(userData, name);
      if (fs.existsSync(dest)) continue;
      const src = legacyDirs.map((d) => path.join(d, name)).find((p) => fs.existsSync(p));
      if (!src) continue;
      fs.copyFileSync(src, dest);
      copied.push(name);
    }

    fs.writeFileSync(marker, new Date().toISOString(), "utf8");
    if (copied.length) {
      console.log(`[branding] migrated to ${userData}: ${copied.join(", ")}`);
    }
  } catch (err) {
    // Never block startup over this; a fresh profile is a survivable outcome.
    console.error("[branding] user data migration failed:", err?.message || err);
  }
}

/**
 * build/ is electron-builder's buildResources directory, so it is deliberately
 * not packed into the app. The PNG is therefore only present when running from
 * a checkout — which is the only place it is needed, since packaged macOS
 * builds carry build/icon.icns in the bundle itself.
 */
function windowIcon() {
  return fs.existsSync(ICON_PNG) ? ICON_PNG : undefined;
}

/**
 * Unpackaged runs live inside Electron.app, so macOS shows its icon in the Dock
 * and the Cmd-Tab switcher. Packaged builds already carry the right one.
 */
function applyDevDockIcon() {
  if (process.platform !== "darwin" || app.isPackaged || !app.dock) return;
  try {
    const icon = windowIcon();
    if (icon) app.dock.setIcon(icon);
  } catch (err) {
    console.error("[branding] dock icon failed:", err?.message || err);
  }
}

module.exports = { APP_NAME, windowIcon, applyAppName, migrateLegacyUserData, applyDevDockIcon };
