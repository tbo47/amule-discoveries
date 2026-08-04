"use strict";

/**
 * Turning files the in-app player cannot open into files it can, with ffmpeg.
 *
 * The bundled Chromium only decodes a narrow set of containers and codecs (see
 * media.js); much of what lands in the incoming folder — mkv, avi, AC3 audio,
 * HEVC video — is outside it. Instead of sending the user to an external
 * player, the file is converted in place:
 *
 *  - streams Chromium already understands are copied (fast and lossless),
 *    everything else is re-encoded to H.264 / AAC,
 *  - the result is written to a hidden temporary file next to the original, so
 *    a crash or a cancel never leaves a half-written file in the share,
 *  - only once ffmpeg exits cleanly does the original move to the Trash and the
 *    converted file take its place.
 *
 * ffmpeg is not bundled with the app (it is big, and its licensing is its own
 * question), so it is looked up on the machine and installHint() explains how
 * to install it when it is missing.
 *
 * Converting rewrites the file, so its ed2k hash changes: aMule drops the old
 * entry and shares the new file as a different one. That is inherent to
 * replacing the file and the UI says so before starting.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile, spawn } = require("child_process");
const { shell } = require("electron");

/**
 * Extensions the player cannot open and ffmpeg can almost always convert.
 * Anything else (archives, documents, images…) is still just revealed in the
 * file manager — offering to "convert" a .rar would be nonsense.
 */
const CONVERTIBLE = [
  // video
  ".mkv", ".avi", ".divx", ".wmv", ".asf", ".flv", ".f4v", ".ogm", ".rm", ".rmvb",
  ".mpg", ".mpeg", ".mpe", ".m1v", ".m2v", ".vob", ".ts", ".m2ts", ".mts", ".3gp", ".3g2",
  // audio
  ".mka", ".ac3", ".eac3", ".dts", ".wma", ".ape", ".wv", ".ra", ".aiff", ".aif", ".mpc", ".tta", ".amr",
];

/**
 * Codecs that can live in an MP4 at all. A stream is copied only if it is in
 * here *and* the renderer says Chromium can decode it (see canCopy*): the two
 * questions are different, and getting either wrong produces a converted file
 * that still does not play.
 */
const MP4_VIDEO = new Set(["h264", "hevc", "vp9", "av1"]);
const MP4_AUDIO = new Set(["aac", "mp3", "alac", "opus", "flac", "ac3", "eac3"]);
/** Used when the renderer did not send its capabilities — the safe subset. */
const VIDEO_COPY = new Set(["h264", "vp9", "av1"]);
const AUDIO_COPY = new Set(["aac", "mp3"]);
/** Text subtitles survive as mov_text; image ones (DVD/Blu-ray) cannot go in MP4. */
const TEXT_SUBTITLES = new Set(["subrip", "ass", "ssa", "mov_text", "text", "webvtt", "eia_608"]);
/** Chromium decodes 8-bit 4:2:0 only, whatever the codec claims to support. */
const PLAIN_PIX_FMTS = new Set(["yuv420p", "yuvj420p", ""]);

function extensions() {
  return CONVERTIBLE.slice();
}

// ── Finding ffmpeg ──

/**
 * A packaged app started from Finder or a desktop launcher inherits a minimal
 * PATH, so the usual install prefixes are searched explicitly as well.
 */
function searchDirs() {
  const fromPath = String(process.env.PATH || "").split(path.delimiter).filter(Boolean);
  const home = os.homedir();
  const extra = process.platform === "win32"
    ? [
        path.join(process.env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "Microsoft", "WinGet", "Links"),
        path.join(process.env.ProgramFiles || "C:\\Program Files", "ffmpeg", "bin"),
        path.join(process.env.ChocolateyInstall || "C:\\ProgramData\\chocolatey", "bin"),
        "C:\\ffmpeg\\bin",
      ]
    : [
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
        "/opt/local/bin",
        "/snap/bin",
        "/var/lib/flatpak/exports/bin",
        path.join(home, ".local", "bin"),
        path.join(home, "bin"),
      ];
  return [...new Set([...fromPath, ...extra])];
}

async function findBinary(name) {
  const exe = process.platform === "win32" ? `${name}.exe` : name;
  for (const dir of searchDirs()) {
    const candidate = path.join(dir, exe);
    try {
      await fs.promises.access(candidate, fs.constants.X_OK);
      return candidate;
    } catch (_) { /* next */ }
  }
  return "";
}

function installHint() {
  if (process.platform === "darwin") {
    return {
      title: "ffmpeg is not installed",
      command: "brew install ffmpeg",
      note: "Paste this in Terminal. It needs Homebrew — if you do not have it, see brew.sh.",
      url: "https://brew.sh",
    };
  }
  if (process.platform === "win32") {
    return {
      title: "ffmpeg is not installed",
      command: "winget install --id Gyan.FFmpeg -e",
      note: "Run this in PowerShell, then restart the app. Ready-made builds are also on ffmpeg.org.",
      url: "https://ffmpeg.org/download.html",
    };
  }
  return {
    title: "ffmpeg is not installed",
    command: "sudo apt install ffmpeg",
    note: "Or the equivalent for your distribution: dnf install ffmpeg, pacman -S ffmpeg, zypper install ffmpeg.",
    url: "https://ffmpeg.org/download.html",
  };
}

function run(bin, args, timeout = 30000) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new Error(lastLines(stderr) || err.message));
      else resolve({ stdout, stderr });
    });
  });
}

function lastLines(text, count = 3) {
  return String(text || "").trim().split(/\r?\n/).filter(Boolean).slice(-count).join("\n");
}

let toolsPromise = null;

/** @returns {Promise<{ok: boolean, ffmpeg: string, ffprobe: string, version: string, hint: object, error: string}>} */
function tools({ refresh = false } = {}) {
  if (refresh) toolsPromise = null;
  if (!toolsPromise) {
    toolsPromise = detectTools().catch((err) => ({
      ok: false, ffmpeg: "", ffprobe: "", version: "", hint: installHint(), error: err.message,
    }));
  }
  return toolsPromise;
}

async function detectTools() {
  const ffmpeg = await findBinary("ffmpeg");
  if (!ffmpeg) return { ok: false, ffmpeg: "", ffprobe: "", version: "", hint: installHint(), error: "" };

  // ffprobe ships with ffmpeg, so look next to it first.
  const sibling = path.join(path.dirname(ffmpeg), process.platform === "win32" ? "ffprobe.exe" : "ffprobe");
  let ffprobe = "";
  try {
    await fs.promises.access(sibling, fs.constants.X_OK);
    ffprobe = sibling;
  } catch (_) {
    ffprobe = await findBinary("ffprobe");
  }

  try {
    const { stdout } = await run(ffmpeg, ["-hide_banner", "-version"], 15000);
    // "ffmpeg version 7.1 Copyright (c) …" — the copyright half is just noise.
    const version = (stdout.split("\n")[0] || "ffmpeg").split(" Copyright")[0].trim();
    return { ok: true, ffmpeg, ffprobe, version, hint: null, error: "" };
  } catch (err) {
    // Found but not runnable: quarantined, wrong architecture, broken install…
    return { ok: false, ffmpeg, ffprobe, version: "", hint: installHint(), error: err.message };
  }
}

// ── Reading the file ──

async function probe(ffprobe, fullPath) {
  if (!ffprobe) return null;
  try {
    const { stdout } = await run(
      ffprobe,
      ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", fullPath],
      60000,
    );
    const parsed = JSON.parse(stdout);
    return {
      streams: Array.isArray(parsed.streams) ? parsed.streams : [],
      duration: Number(parsed.format?.duration) || 0,
      formatName: parsed.format?.format_name || "",
    };
  } catch (_) {
    // Unreadable header, exotic container… the conservative plan still applies.
    return null;
  }
}

function streamsOf(info, type) {
  return info.streams.filter((s) => s.codec_type === type);
}

function isTenBit(s) {
  return /10le|10be|p010|12le|12be/.test(s.pix_fmt || "");
}

/**
 * Copy the video stream, or re-encode it?
 *
 * `caps` is what the renderer's own <video> element answered to canPlayType(),
 * which beats any table hard-coded here: HEVC plays on a Mac and usually not on
 * Linux, and re-encoding a film that would have played is an hour wasted.
 */
function canCopyVideo(s, caps) {
  const name = s.codec_name;
  if (!MP4_VIDEO.has(name)) return false;
  const support = caps?.video;

  if (name === "h264") {
    // No Chromium build decodes 10-bit or 4:2:2/4:4:4 H.264, whatever
    // canPlayType() answers for the plain profile string.
    const profile = String(s.profile || "").toLowerCase();
    if (isTenBit(s) || !PLAIN_PIX_FMTS.has(s.pix_fmt || "")) return false;
    if (profile.includes("high 10") || profile.includes("422") || profile.includes("444")) return false;
    return support ? Boolean(support.h264) : true;
  }
  if (name === "hevc") return support ? Boolean(isTenBit(s) ? support.hevc10 : support.hevc) : false;
  return support ? Boolean(support[name]) : VIDEO_COPY.has(name);
}

function canCopyAudio(s, caps) {
  if (!MP4_AUDIO.has(s.codec_name)) return false;
  return caps?.audio ? Boolean(caps.audio[s.codec_name]) : AUDIO_COPY.has(s.codec_name);
}

function describeVideo(s) {
  const bits = [String(s.codec_name || "?").toUpperCase()];
  if (s.width && s.height) bits.push(`${s.width}×${s.height}`);
  if (s.pix_fmt && !PLAIN_PIX_FMTS.has(s.pix_fmt)) bits.push(s.pix_fmt);
  return bits.join(" ");
}

function describeAudios(list) {
  const seen = [];
  for (const s of list) {
    const label = String(s.codec_name || "?").toUpperCase() + (s.channel_layout ? ` ${s.channel_layout}` : "");
    if (!seen.includes(label)) seen.push(label);
  }
  return seen.join(", ") + (list.length > 1 ? ` · ${list.length} tracks` : "");
}

/**
 * Decide what to do with each stream.
 * @param {object} caps what the renderer's <video> element can decode, if known
 */
function planFor(fullPath, info, caps) {
  const sourceExt = path.extname(fullPath).toLowerCase().replace(".", "").toUpperCase() || "file";

  if (!info) {
    // ffprobe missing or the header could not be read: re-encode everything,
    // which is slower but always produces something playable.
    return {
      kind: "video",
      ext: ".mp4",
      duration: 0,
      args: [
        "-map", "0:V:0?", "-map", "0:a?",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-pix_fmt", "yuv420p",
        "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
        "-c:a", "aac", "-b:a", "192k",
        "-movflags", "+faststart",
      ],
      summary: [{ label: "Everything", from: sourceExt, to: "MP4 · H.264 + AAC (full re-encode)" }],
      transcodes: true,
      reencodesVideo: true,
      reencodesAudio: true,
      hasAudio: true,
    };
  }

  // Cover art is stored as a video stream; it is not the movie.
  const video = streamsOf(info, "video").find((s) => !s.disposition?.attached_pic);
  const audios = streamsOf(info, "audio");
  const allSubs = streamsOf(info, "subtitle");
  const subs = allSubs.filter((s) => TEXT_SUBTITLES.has(s.codec_name));

  if (!video && audios.length === 0) throw new Error("This file has no audio or video stream to convert.");

  const maps = [];
  const codecs = [];
  const summary = [];
  let transcodes = false;
  // Only re-encoding the video makes a conversion slow; audio is near-instant.
  let reencodesVideo = false;
  let reencodesAudio = false;

  summary.push({ label: "Container", from: sourceExt, to: video ? "MP4" : "M4A" });

  if (video) {
    maps.push("-map", `0:${video.index}`);
    if (canCopyVideo(video, caps)) {
      codecs.push("-c:v", "copy");
      summary.push({ label: "Video", from: describeVideo(video), to: "copied as-is" });
    } else {
      transcodes = true;
      reencodesVideo = true;
      codecs.push(
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-pix_fmt", "yuv420p",
        // libx264 refuses odd dimensions, which some old rips have.
        "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
      );
      summary.push({ label: "Video", from: describeVideo(video), to: "H.264" });
    }
  }

  for (const a of audios) maps.push("-map", `0:${a.index}`);
  if (audios.length === 0) {
    summary.push({ label: "Audio", from: "none", to: "none" });
  } else if (audios.every((a) => canCopyAudio(a, caps))) {
    codecs.push("-c:a", "copy");
    summary.push({ label: "Audio", from: describeAudios(audios), to: "copied as-is" });
  } else {
    transcodes = true;
    reencodesAudio = true;
    const channels = Math.max(2, ...audios.map((a) => Number(a.channels) || 2));
    codecs.push("-c:a", "aac", "-b:a", channels > 2 ? "384k" : "192k");
    summary.push({ label: "Audio", from: describeAudios(audios), to: "AAC" });
  }

  for (const s of subs) maps.push("-map", `0:${s.index}`);
  if (subs.length) codecs.push("-c:s", "mov_text");
  if (allSubs.length) {
    const dropped = allSubs.length - subs.length;
    summary.push({
      label: "Subtitles",
      from: `${allSubs.length} track${allSubs.length > 1 ? "s" : ""}`,
      to: subs.length
        ? `${subs.length} kept${dropped ? `, ${dropped} image track${dropped > 1 ? "s" : ""} dropped` : ""}`
        : "dropped (MP4 cannot hold image subtitles)",
    });
  }

  return {
    kind: video ? "video" : "audio",
    ext: video ? ".mp4" : ".m4a",
    duration: info.duration,
    args: [...maps, ...codecs, "-map_metadata", "0", "-movflags", "+faststart"],
    summary,
    transcodes,
    reencodesVideo,
    reencodesAudio,
    hasAudio: audios.length > 0,
  };
}

/** What the confirmation dialog shows before anything is touched. */
async function inspect(fullPath, caps) {
  const t = await tools();
  const fileName = path.basename(fullPath);
  if (!t.ok) {
    return { ready: false, busy: isBusy(), fileName, version: "", hint: t.hint, error: t.error, plan: null };
  }

  const info = await probe(t.ffprobe, fullPath);
  const plan = planFor(fullPath, info, caps);
  const base = path.basename(fullPath, path.extname(fullPath));
  return {
    ready: true,
    busy: isBusy(),
    fileName,
    version: t.version,
    hint: null,
    error: "",
    plan: {
      kind: plan.kind,
      targetName: base + plan.ext,
      duration: plan.duration,
      summary: plan.summary,
      transcodes: plan.transcodes,
      reencodesVideo: plan.reencodesVideo,
      reencodesAudio: plan.reencodesAudio,
      hasAudio: plan.hasAudio,
      probed: Boolean(info),
    },
  };
}

// ── Converting ──

/** One conversion at a time: they are CPU-bound, running several only slows both down. */
let current = null;

function isBusy() {
  return Boolean(current);
}

function cancel() {
  if (!current) return false;
  current.canceled = true;
  try { current.child?.kill("SIGKILL"); } catch (_) { /* already gone */ }
  return true;
}

function parseProgress(text, fields) {
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf("=");
    if (i > 0) fields[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
}

function spawnFfmpeg(bin, args, job, duration, onProgress) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    job.child = child;

    let stderr = "";
    let carry = "";
    let lastEmit = 0;

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      // -progress writes key=value lines, one block per update, ending in "progress=".
      const text = carry + chunk;
      const cut = text.lastIndexOf("\n");
      if (cut < 0) { carry = text; return; }
      carry = text.slice(cut + 1);

      const fields = {};
      parseProgress(text.slice(0, cut), fields);
      const micros = Number(fields.out_time_us ?? fields.out_time_ms);
      if (!Number.isFinite(micros)) return;

      const now = Date.now();
      if (now - lastEmit < 400 && fields.progress !== "end") return;
      lastEmit = now;

      const seconds = micros / 1e6;
      const speed = parseFloat(fields.speed) || 0;
      onProgress({
        seconds,
        duration,
        percent: duration > 0 ? Math.min(99.9, (seconds / duration) * 100) : null,
        speed,
        eta: duration > 0 && speed > 0 ? Math.max(0, (duration - seconds) / speed) : null,
      });
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-8000); });

    child.on("error", (err) => reject(new Error(`Could not run ffmpeg: ${err.message}`)));
    child.on("close", (code, signal) => {
      if (job.canceled) return resolve(false);
      if (code === 0) return resolve(true);
      reject(new Error(lastLines(stderr) || `ffmpeg exited with code ${code}${signal ? ` (${signal})` : ""}`));
    });
  });
}

/** Bytes free where the file lives; Infinity when the platform will not say. */
async function freeSpace(dir) {
  try {
    const s = await fs.promises.statfs(dir);
    return s.bsize * s.bavail;
  } catch (_) {
    return Infinity;
  }
}

async function exists(p) {
  try {
    await fs.promises.access(p);
    return true;
  } catch (_) {
    return false;
  }
}

/** The converted name, avoiding an unrelated file that already owns it. */
async function freeTarget(dir, base, ext, replacing) {
  const first = path.join(dir, base + ext);
  if (first === replacing || !(await exists(first))) return first;
  for (let n = 0; n < 50; n++) {
    const candidate = path.join(dir, `${base} (converted${n ? ` ${n + 1}` : ""})${ext}`);
    if (!(await exists(candidate))) return candidate;
  }
  throw new Error("Could not find a free file name next to the original.");
}

async function trash(fullPath) {
  try {
    await shell.trashItem(fullPath);
    return true;
  } catch (_) {
    return false;
  }
}

/** Put the finished file in the original's place; the original goes to the Trash. */
async function replaceOriginal(source, tmp, ext) {
  const stat = await fs.promises.stat(tmp);
  if (stat.size === 0) throw new Error("ffmpeg produced an empty file.");

  const dir = path.dirname(source);
  const base = path.basename(source, path.extname(source));
  let target = await freeTarget(dir, base, ext, source);

  if (target === source) {
    // Same name in and out: the original has to make room first.
    const trashed = await trash(source);
    try {
      await fs.promises.rename(tmp, target);
    } catch (_) {
      // Windows will not rename onto an existing file — keep the work anyway.
      target = await freeTarget(dir, `${base} (converted)`, ext, "");
      await fs.promises.rename(tmp, target);
    }
    return { target, trashed };
  }

  await fs.promises.rename(tmp, target);
  const trashed = await trash(source);
  return { target, trashed };
}

/**
 * Convert `fullPath` and replace it. Resolves once ffmpeg is done — progress
 * arrives through `onProgress` in the meantime.
 */
async function convert(fullPath, caps, onProgress = () => {}) {
  if (current) throw new Error("A conversion is already running. Wait for it to finish, or cancel it first.");

  const t = await tools();
  if (!t.ok) throw new Error("ffmpeg was not found on this computer.");

  const stat = await fs.promises.stat(fullPath);
  if (!stat.isFile()) throw new Error("Not a file.");

  const info = await probe(t.ffprobe, fullPath);
  const plan = planFor(fullPath, info, caps);

  const dir = path.dirname(fullPath);
  const base = path.basename(fullPath, path.extname(fullPath));

  // The converted file is written beside the original, so both exist at once.
  // Better to say so now than to fail on a full disk an hour into a transcode.
  const needed = Math.round(stat.size * 1.1);
  if (await freeSpace(dir) < needed) {
    throw new Error(`Not enough free space: converting this file needs about ${(needed / 1e9).toFixed(1)} GB free in its folder.`);
  }

  // Hidden and oddly named on purpose: aMule must not pick the half-written
  // file up as a share, and the user must not mistake it for the result.
  const tmp = path.join(dir, `.${base}.amule-converting${plan.ext}`);
  await fs.promises.rm(tmp, { force: true });

  const job = { child: null, canceled: false, tmp };
  current = job;
  try {
    const args = [
      "-nostdin", "-y", "-hide_banner", "-loglevel", "error",
      "-i", fullPath,
      ...plan.args,
      "-progress", "pipe:1", "-nostats",
      tmp,
    ];
    console.log(`[CONVERT] ${t.ffmpeg} ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ")}`);

    const completed = await spawnFfmpeg(t.ffmpeg, args, job, plan.duration, onProgress);
    if (!completed) {
      await fs.promises.rm(tmp, { force: true });
      return { converted: false, canceled: true };
    }

    const { target, trashed } = await replaceOriginal(fullPath, tmp, plan.ext);
    console.log(`[CONVERT] done: ${JSON.stringify(target)} (original ${trashed ? "trashed" : "kept"})`);
    return {
      converted: true,
      canceled: false,
      filePath: path.dirname(target),
      fileName: path.basename(target),
      originalTrashed: trashed,
      originalName: path.basename(fullPath),
    };
  } catch (err) {
    await fs.promises.rm(tmp, { force: true }).catch(() => {});
    throw err;
  } finally {
    current = null;
  }
}

module.exports = {
  extensions,
  tools,
  inspect,
  convert,
  cancel,
  isBusy,
  installHint,
};
