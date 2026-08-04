"use strict";

/**
 * Local media playback support for the in-app player:
 *
 *  - classify()  tells which files Chromium can decode (everything else is
 *                revealed in the file manager instead of being played),
 *  - the "media://" scheme streams a local file to the <video> element with
 *    HTTP range support, so seeking inside a multi-GB file stays instant,
 *  - playback positions are persisted per file so a video resumes where it
 *    was left off.
 */

const fs = require("fs");
const path = require("path");
const { app, protocol } = require("electron");
const { Readable } = require("stream");

const SCHEME = "media";

/**
 * Containers/codecs the bundled Chromium can play. .mov is served as video/mp4
 * on purpose — video/quicktime makes Chromium reject an otherwise fine H.264
 * stream. Anything missing here (mkv, avi, wmv, flv, mpg, ape, wma…) is handed
 * over to the file manager.
 */
const VIDEO_MIME = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/mp4",
  ".webm": "video/webm",
  ".ogv": "video/ogg",
};

const AUDIO_MIME = {
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".m4b": "audio/mp4",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".opus": "audio/ogg",
  ".weba": "audio/webm",
};

/** @returns {{ kind: "audio"|"video"|"other", mime: string }} */
function classify(filePath) {
  const ext = path.extname(filePath || "").toLowerCase();
  if (VIDEO_MIME[ext]) return { kind: "video", mime: VIDEO_MIME[ext] };
  if (AUDIO_MIME[ext]) return { kind: "audio", mime: AUDIO_MIME[ext] };
  return { kind: "other", mime: "application/octet-stream" };
}

/** The renderer builds its playlists from this list, so both sides agree on what is playable. */
function extensions() {
  return { audio: Object.keys(AUDIO_MIME), video: Object.keys(VIDEO_MIME) };
}

// ── media:// URLs ──
// Paths are exchanged as opaque tokens: no path escaping in URLs, and the
// handler can only ever serve a file the app itself opened.

const tokenByPath = new Map();
const pathByToken = new Map();
let nextToken = 1;

/**
 * @param {string} version identifier of the file's current contents. It ends up
 *   in the query string, which the handler ignores — it is there to give a file
 *   that was replaced on disk (a conversion, see convert.js) a URL Chromium has
 *   never seen, otherwise the media element happily replays the old bytes.
 */
function urlFor(fullPath, version = "") {
  let token = tokenByPath.get(fullPath);
  if (!token) {
    token = String(nextToken++);
    tokenByPath.set(fullPath, token);
    pathByToken.set(token, fullPath);
  }
  return `${SCHEME}://stream/${token}` + (version ? `?v=${encodeURIComponent(version)}` : "");
}

/** Must run before app "ready". */
function registerScheme() {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, corsEnabled: true, bypassCSP: true },
    },
  ]);
}

/** Parse a Range header; returns null (whole file), "invalid", or {start,end}. */
function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const hasStart = m[1] !== "";
  const hasEnd = m[2] !== "";
  if (!hasStart && !hasEnd) return null;

  let start;
  let end;
  if (hasStart) {
    start = Number(m[1]);
    end = hasEnd ? Number(m[2]) : size - 1;
  } else {
    // "bytes=-N": the last N bytes.
    const n = Number(m[2]);
    if (!n) return "invalid";
    start = Math.max(0, size - n);
    end = size - 1;
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return "invalid";
  return { start, end: Math.min(end, size - 1) };
}

function registerHandler() {
  protocol.handle(SCHEME, async (request) => {
    const token = decodeURIComponent(new URL(request.url).pathname).replace(/^\//, "");
    const fullPath = pathByToken.get(token);
    if (!fullPath) return new Response("Unknown media", { status: 404 });

    let stat;
    try {
      stat = await fs.promises.stat(fullPath);
    } catch (_) {
      return new Response("File not found", { status: 404 });
    }

    const headers = {
      "Content-Type": classify(fullPath).mime,
      "Accept-Ranges": "bytes",
      // The page is a file:// document, so the media element loads this
      // cross-origin; without this the Web Audio visualizer gets silence.
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
    };

    if (request.method === "HEAD") {
      return new Response(null, { status: 200, headers: { ...headers, "Content-Length": String(stat.size) } });
    }

    const range = parseRange(request.headers.get("range"), stat.size);
    if (range === "invalid") {
      return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${stat.size}` } });
    }

    const start = range ? range.start : 0;
    const end = range ? range.end : stat.size - 1;
    const stream = fs.createReadStream(fullPath, { start, end });
    // Seeking cancels the in-flight request; close the file handle with it.
    request.signal?.addEventListener("abort", () => stream.destroy());

    return new Response(Readable.toWeb(stream), {
      status: range ? 206 : 200,
      headers: {
        ...headers,
        "Content-Length": String(end - start + 1),
        ...(range ? { "Content-Range": `bytes ${start}-${end}/${stat.size}` } : {}),
      },
    });
  });
}

// ── Playback positions ──

const POSITIONS_FILE = path.join(app.getPath("userData"), "playback.json");
const MAX_POSITIONS = 500;

let positions = null;
let writeTimer = null;

function loadPositions() {
  if (positions) return positions;
  try {
    positions = JSON.parse(fs.readFileSync(POSITIONS_FILE, "utf8"));
  } catch (_) {
    positions = {};
  }
  return positions;
}

function schedulePositionsWrite() {
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    try {
      fs.writeFileSync(POSITIONS_FILE, JSON.stringify(positions), "utf8");
    } catch (_) { /* a lost position is not worth bothering the user with */ }
  }, 1000);
  writeTimer.unref?.();
}

function prunePositions() {
  const keys = Object.keys(positions);
  if (keys.length <= MAX_POSITIONS) return;
  keys
    .sort((a, b) => (positions[a].updatedAt || 0) - (positions[b].updatedAt || 0))
    .slice(0, keys.length - MAX_POSITIONS)
    .forEach((k) => delete positions[k]);
}

function getPosition(key) {
  const entry = key ? loadPositions()[key] : null;
  return entry && Number.isFinite(entry.position) ? entry.position : 0;
}

function savePosition(key, position, duration, name) {
  if (!key || !Number.isFinite(position)) return false;
  loadPositions()[key] = {
    position,
    duration: Number.isFinite(duration) ? duration : 0,
    name: name || "",
    updatedAt: Date.now(),
  };
  prunePositions();
  schedulePositionsWrite();
  return true;
}

function clearPosition(key) {
  if (!key) return false;
  delete loadPositions()[key];
  schedulePositionsWrite();
  return true;
}

module.exports = {
  classify,
  extensions,
  urlFor,
  registerScheme,
  registerHandler,
  getPosition,
  savePosition,
  clearPosition,
};
