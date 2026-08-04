#!/usr/bin/env node
"use strict";

/**
 * Regenerates build/icon.icns and build/icon.png from build/icon.svg.
 * The SVG is the source of truth; the generated files are committed so that
 * neither a build nor CI needs rsvg-convert installed.
 *
 * Requires: rsvg-convert (brew install librsvg) and iconutil (macOS).
 *   npm run icon
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const BUILD_DIR = path.join(__dirname, "..", "build");
const SVG = path.join(BUILD_DIR, "icon.svg");
const ICONSET = path.join(BUILD_DIR, "icon.iconset");

// name -> pixel size, following Apple's iconset conventions.
const VARIANTS = [
  ["icon_16x16.png", 16],
  ["icon_16x16@2x.png", 32],
  ["icon_32x32.png", 32],
  ["icon_32x32@2x.png", 64],
  ["icon_128x128.png", 128],
  ["icon_128x128@2x.png", 256],
  ["icon_256x256.png", 256],
  ["icon_256x256@2x.png", 512],
  ["icon_512x512.png", 512],
  ["icon_512x512@2x.png", 1024],
];

function render(size, out) {
  execFileSync("rsvg-convert", ["-w", String(size), "-h", String(size), SVG, "-o", out], {
    stdio: "pipe",
  });
}

if (!fs.existsSync(SVG)) {
  console.error(`Missing ${SVG}`);
  process.exit(1);
}

fs.rmSync(ICONSET, { recursive: true, force: true });
fs.mkdirSync(ICONSET, { recursive: true });

for (const [name, size] of VARIANTS) render(size, path.join(ICONSET, name));

execFileSync("iconutil", ["-c", "icns", ICONSET, "-o", path.join(BUILD_DIR, "icon.icns")], {
  stdio: "pipe",
});
render(1024, path.join(BUILD_DIR, "icon.png"));
fs.rmSync(ICONSET, { recursive: true, force: true });

console.log("Wrote build/icon.icns and build/icon.png");
