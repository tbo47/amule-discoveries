"use strict";

/**
 * In-app media player.
 *
 * Every row that has a local file (My Collection, plus already-shared matches
 * in the search, discovery and peer tables) plays here instead of launching an
 * external player. Files Chromium cannot decode are revealed in the file
 * manager instead — see media.js for the list.
 *
 * The playlist is the set of playable rows of the table that was clicked, so
 * ‹ ›, a two-finger swipe or a drag moves to the next file of that same list.
 * A single <video> element serves both kinds, which is also why starting a file
 * always stops the previous one. Positions are saved per file (by hash when
 * known) and restored on the next play.
 *
 * Loaded after renderer.js: $, call(), formatBytes() come from there.
 */

const playerOverlay     = $("playerOverlay");
const playerStage       = $("playerStage");
const playerSlide       = $("playerSlide");
const playerTitle       = $("playerTitle");
const playerSub         = $("playerSub");
const playerArt         = $("playerArt");
const playerArtInner    = $("playerArtInner");
const playerArtName     = $("playerArtName");
const playerViz         = $("playerViz");
const playerToast       = $("playerToast");
const playerNotice      = $("playerNotice");
const playerNoticeText  = $("playerNoticeText");
const playerNoticeBtn   = $("playerNoticeBtn");
const playerNoticeClose = $("playerNoticeClose");
const playerPrevBtn     = $("playerPrevBtn");
const playerNextBtn     = $("playerNextBtn");
const playerPlayBtn     = $("playerPlayBtn");
const playerSeek        = $("playerSeek");
const playerBuffered    = $("playerBuffered");
const playerPlayed      = $("playerPlayed");
const playerKnob        = $("playerKnob");
const playerTimeNow     = $("playerTimeNow");
const playerTimeTotal   = $("playerTimeTotal");
const playerVolume      = $("playerVolume");
const playerMuteBtn     = $("playerMuteBtn");
const playerRateBtn     = $("playerRateBtn");
const playerRateMenu    = $("playerRateMenu");
const playerFsBtn       = $("playerFsBtn");
const playerRevealBtn   = $("playerRevealBtn");
const playerExternalBtn = $("playerExternalBtn");
const playerCloseBtn    = $("playerCloseBtn");

/** Replaced (once) if the Web Audio visualizer turns out to swallow the sound. */
let playerMedia = $("playerMedia");

/** @type {{ path: string, name: string, title: string, hash: string }[]} */
let playerList = [];
let playerIndex = -1;
let playerCurrent = null;
/** Bumped on every load so late IPC replies and stale media errors are ignored. */
let playerLoadToken = 0;
let playerPendingResume = 0;
let playerLastSaveAt = 0;
let playerExtsPromise = null;

const PLAYER_VOLUME_KEY = "player.volume";
const PLAYER_RATE_KEY = "player.rate";

// ── Opening ──

/** Extensions main.js can stream, and the ones ffmpeg can turn into those. Fetched once. */
function playerExtensionSets() {
  if (!playerExtsPromise) {
    playerExtsPromise = call("mediaExtensions")
      .then((e) => ({
        playable: new Set([...(e.audio || []), ...(e.video || [])]),
        convertible: new Set(e.convertible || []),
      }))
      .catch(() => ({ playable: new Set(), convertible: new Set() }));
  }
  return playerExtsPromise;
}

/**
 * What this Chromium build can actually decode, asked of a real <video>
 * element. HEVC plays on a Mac and usually not on Linux, AC3 nowhere — the
 * answers decide whether a stream can be copied or has to be re-encoded, so
 * they travel with every conversion request.
 */
let playerCodecCaps = null;

function playerCodecSupport() {
  if (playerCodecCaps) return playerCodecCaps;
  const el = document.createElement("video");
  const can = (type) => el.canPlayType(type) !== "";
  playerCodecCaps = {
    video: {
      h264: can('video/mp4; codecs="avc1.640028"'),
      hevc: can('video/mp4; codecs="hev1.1.6.L93.B0"'),
      hevc10: can('video/mp4; codecs="hev1.2.4.L120.B0"'),
      vp9: can('video/mp4; codecs="vp09.00.10.08"'),
      av1: can('video/mp4; codecs="av01.0.04M.08"'),
    },
    audio: {
      aac: can('audio/mp4; codecs="mp4a.40.2"'),
      mp3: can('audio/mp4; codecs="mp4a.69"') || can("audio/mpeg"),
      ac3: can('audio/mp4; codecs="ac-3"'),
      eac3: can('audio/mp4; codecs="ec-3"'),
      flac: can('audio/mp4; codecs="flac"'),
      opus: can('audio/mp4; codecs="opus"'),
      alac: can('audio/mp4; codecs="alac"'),
    },
  };
  return playerCodecCaps;
}

function playerExtOf(name) {
  const i = String(name || "").lastIndexOf(".");
  return i < 0 ? "" : name.slice(i).toLowerCase();
}

function playerRowItem(el) {
  return {
    path: el.dataset.path || "",
    // The on-disk name (joined with the path), not the Mojibake-repaired one.
    name: el.dataset.name || "",
    title: el.dataset.title || el.dataset.name || "",
    hash: (el.dataset.hash || "").toLowerCase(),
  };
}

function playerSameItem(a, b) {
  if (a.hash && b.hash) return a.hash === b.hash;
  return a.path === b.path && a.name === b.name;
}

/** Key used to remember the position: the hash survives renames, the path is the fallback. */
function playerKeyOf(item) {
  return item.hash || `${item.path}/${item.name}`;
}

async function playerReveal(item) {
  try {
    await call("revealFile", { filePath: item.path, fileName: item.name });
  } catch (err) {
    alert("Could not open the file's folder:\n" + err.message);
  }
}

/**
 * Entry point for the tables: play the clicked row, with its playable siblings
 * as the playlist. A file the player cannot open is offered to ffmpeg
 * (convert-ui.js); anything ffmpeg has no business with — archives, documents —
 * is shown in the file manager instead.
 */
async function openMediaFromRow(el) {
  const clicked = playerRowItem(el);
  if (!clicked.path) return;

  const { playable, convertible } = await playerExtensionSets();
  const ext = playerExtOf(clicked.name);
  if (!playable.has(ext)) {
    if (convertible.has(ext)) convertOpen(clicked, { reason: "container" });
    else await playerReveal(clicked);
    return;
  }

  const scope = el.closest("tbody") || document;
  const siblings = [...scope.querySelectorAll(".shared-play[data-path]")]
    .map(playerRowItem)
    .filter((it) => it.path && playable.has(playerExtOf(it.name)));

  playerList = siblings.length ? siblings : [clicked];
  const index = playerList.findIndex((it) => playerSameItem(it, clicked));
  await playerLoad(index < 0 ? 0 : index);
}

/** Play one file on its own — used once a conversion has replaced it. */
async function playerPlayItem(item) {
  playerList = [item];
  await playerLoad(0);
}

/** @param {number} direction -1/1 animates the slide, 0 does not (first open). */
async function playerLoad(index, direction = 0) {
  if (index < 0 || index >= playerList.length) return;

  // Claim the index up front so swiping faster than files load still advances
  // one file per swipe instead of fighting the in-flight load.
  playerIndex = index;
  playerNoticeHide();
  playerDecodeChecked = false;
  playerPlayingSince = 0;
  await playerSavePosition({ force: true });
  const token = ++playerLoadToken;
  const item = playerList[index];

  let info;
  try {
    info = await call("mediaOpen", { filePath: item.path, fileName: item.name, key: playerKeyOf(item) });
  } catch (err) {
    if (token !== playerLoadToken) return;
    if (playerOverlay.classList.contains("open")) playerToastShow("Could not open this file: " + err.message);
    else alert("Could not open file:\n" + err.message);
    return;
  }
  if (token !== playerLoadToken) return;

  if (info.kind === "other") {
    await playerReveal(item);
    return;
  }

  playerCurrent = { item, kind: info.kind };
  playerPendingResume = Number(info.position) || 0;

  playerOverlay.classList.add("open");
  playerWake(); // a new file always arrives with its title and controls showing
  playerOverlay.classList.toggle("kind-video", info.kind === "video");
  playerOverlay.classList.toggle("kind-audio", info.kind === "audio");

  const label = item.title || item.name;
  playerTitle.textContent = label;
  playerArtName.textContent = label;
  playerSub.textContent = `${index + 1} / ${playerList.length}` + (info.size ? ` · ${formatBytes(info.size)}` : "");
  playerArtInner.style.setProperty("--art-h", String(playerHue(label)));
  playerPrevBtn.disabled = index <= 0;
  playerNextBtn.disabled = index >= playerList.length - 1;
  playerTimeNow.textContent = "0:00";
  playerTimeTotal.textContent = "0:00";
  playerSetProgress(0, 0);

  if (direction) {
    playerSlide.classList.remove("slide-from-left", "slide-from-right");
    void playerSlide.offsetWidth; // restart the animation
    playerSlide.classList.add(direction > 0 ? "slide-from-right" : "slide-from-left");
  }

  playerMedia.src = info.url;
  playerMedia.load();
  try {
    await playerMedia.play();
  } catch (_) { /* rejected play: the play button is right there */ }
  if (info.kind === "audio") playerStartVisualizer();
}

function playerHue(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return h;
}

async function playerClose() {
  if (!playerOverlay.classList.contains("open")) return;
  await playerSavePosition({ force: true });
  playerLoadToken++;
  playerCurrent = null;
  playerList = [];
  playerIndex = -1;
  playerMedia.pause();
  playerMedia.removeAttribute("src");
  playerMedia.load();
  playerNoticeHide();
  playerRateMenuOpen(false);
  playerStopVisualizer();
  playerOverlay.classList.remove("open", "playing", "kind-audio", "kind-video");
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
}

// ── Transport ──

function playerNext(direction = 1) {
  if (playerIndex + direction < 0 || playerIndex + direction >= playerList.length) return;
  playerLoad(playerIndex + direction, direction);
}

function playerTogglePlay() {
  if (!playerCurrent) return;
  if (playerMedia.paused) playerMedia.play().catch(() => {});
  else playerMedia.pause();
}

function playerSeekBy(seconds) {
  if (!playerCurrent || !Number.isFinite(playerMedia.duration)) return;
  playerMedia.currentTime = Math.min(Math.max(0, playerMedia.currentTime + seconds), playerMedia.duration);
  playerSyncProgress();
}

function playerFormatTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return "0:00";
  const s = Math.floor(sec % 60);
  const m = Math.floor(sec / 60) % 60;
  const h = Math.floor(sec / 3600);
  return (h ? `${h}:${String(m).padStart(2, "0")}` : `${m}`) + ":" + String(s).padStart(2, "0");
}

function playerSetProgress(playedRatio, bufferedRatio) {
  const pct = (r) => `${Math.min(100, Math.max(0, r * 100))}%`;
  playerPlayed.style.width = pct(playedRatio);
  playerBuffered.style.width = pct(bufferedRatio);
  playerKnob.style.left = pct(playedRatio);
}

function playerSyncProgress() {
  const d = playerMedia.duration;
  const t = playerMedia.currentTime;
  playerTimeNow.textContent = playerFormatTime(t);
  if (Number.isFinite(d) && d > 0) {
    playerTimeTotal.textContent = playerFormatTime(d);
    let buffered = 0;
    for (let i = 0; i < playerMedia.buffered.length; i++) {
      if (playerMedia.buffered.start(i) <= t) buffered = Math.max(buffered, playerMedia.buffered.end(i));
    }
    playerSetProgress(t / d, buffered / d);
  } else {
    playerSetProgress(0, 0);
  }
}

// ── Position persistence ──

async function playerSavePosition({ force = false } = {}) {
  if (!playerCurrent || playerCurrent.ended) return;
  const position = playerMedia.currentTime;
  const duration = playerMedia.duration;
  if (!Number.isFinite(position) || position < 1) return;

  const now = Date.now();
  if (!force && now - playerLastSaveAt < 5000) return;
  playerLastSaveAt = now;
  try {
    await call("savePlayback", {
      key: playerKeyOf(playerCurrent.item),
      position,
      duration: Number.isFinite(duration) ? duration : 0,
      name: playerCurrent.item.title,
    });
  } catch (_) { /* not worth interrupting playback for */ }
}

async function playerForgetPosition(item) {
  try {
    await call("clearPlayback", { key: playerKeyOf(item) });
  } catch (_) { /* ignore */ }
}

// ── Media element events ──

function playerAttachMediaEvents(el) {
  el.addEventListener("loadedmetadata", () => {
    const d = el.duration;
    playerTimeTotal.textContent = playerFormatTime(d);
    // Resume, unless we were basically at the start or the very end. The tail
    // scales with the duration so a short track is not always restarted.
    const tail = Math.min(10, d * 0.1);
    if (playerPendingResume > 5 && Number.isFinite(d) && playerPendingResume < d - tail) {
      el.currentTime = playerPendingResume;
      playerToastShow("Resumed at " + playerFormatTime(playerPendingResume));
    }
    playerPendingResume = 0;
    playerSyncProgress();
  });

  el.addEventListener("timeupdate", () => {
    playerSyncProgress();
    playerSavePosition();
    playerCheckDecoding(el);
  });
  el.addEventListener("progress", playerSyncProgress);
  el.addEventListener("seeked", () => playerSavePosition({ force: true }));

  el.addEventListener("play", () => {
    playerPlayBtn.textContent = "❚❚";
    playerPlayBtn.title = "Pause (Space)";
    playerOverlay.classList.add("playing");
    playerResumeAudioContext();
    playerWake(); // start the fullscreen idle countdown, which pausing stopped
  });
  el.addEventListener("pause", () => {
    playerPlayBtn.textContent = "▶";
    playerPlayBtn.title = "Play (Space)";
    playerOverlay.classList.remove("playing");
    playerPlayingSince = 0;
    playerSavePosition({ force: true });
    playerWake();
  });

  // "playing"/"waiting" bracket the stretches where the decoders actually run.
  el.addEventListener("playing", () => { if (!playerPlayingSince) playerPlayingSince = performance.now(); });
  el.addEventListener("waiting", () => { playerPlayingSince = 0; });

  el.addEventListener("ended", () => {
    if (!playerCurrent) return;
    playerCurrent.ended = true; // stop the position saves from resurrecting the end
    playerForgetPosition(playerCurrent.item);
    // Albums keep going on their own; a finished video waits for the ›.
    if (playerCurrent.kind === "audio" && playerIndex < playerList.length - 1) playerNext();
  });

  el.addEventListener("error", () => {
    // MEDIA_ERR_ABORTED just means we replaced the source while it was loading.
    if (!playerCurrent || el !== playerMedia || el.error?.code === MediaError.MEDIA_ERR_ABORTED) return;
    const item = playerCurrent.item;
    const token = playerLoadToken;
    // The container was in the playable list but the codec inside is not — that
    // is exactly what ffmpeg is here for. A read error is a different problem.
    const isCodec = el.error?.code !== MediaError.MEDIA_ERR_NETWORK;
    playerToastShow(isCodec
      ? "This file's codec cannot be played here — see if it can be converted."
      : "This file could not be read — opening its folder.");
    setTimeout(async () => {
      if (token !== playerLoadToken) return;
      if (isCodec) {
        convertOpen(item, { reason: "codec" }); // closes the player itself
        return;
      }
      await playerClose();
      await playerReveal(item);
    }, 1200);
  });

  el.addEventListener("ratechange", () => { if (el === playerMedia) playerSyncRateUi(); });

  el.addEventListener("volumechange", () => {
    playerVolume.value = String(el.muted ? 0 : el.volume);
    playerMuteBtn.textContent = el.muted || el.volume === 0 ? "🔇" : "🔊";
    if (!el.muted) {
      try { localStorage.setItem(PLAYER_VOLUME_KEY, String(el.volume)); } catch (_) { /* ignore */ }
    }
  });
}

// ── Silent / black playback watchdog ──
//
// A container Chromium accepts can still hold a stream it cannot decode, and
// then it does not complain: an MP4 with AC3 audio plays the picture in
// silence, an MP4 with an exotic video codec plays the sound over a black
// frame. No "error" event, no clue in the API — except that nothing was ever
// decoded. Once playback is properly under way, that is what is checked, and
// ffmpeg is offered for the stream that is missing.

let playerDecodeChecked = false;
/** When the current uninterrupted stretch of playback started (0 = not playing). */
let playerPlayingSince = 0;
/** The file the notice is currently offering to convert. */
let playerNoticeFix = null;

function playerCheckDecoding(el) {
  if (playerDecodeChecked || !playerCurrent || el !== playerMedia) return;
  // Three seconds of real playback, not three seconds of currentTime: resuming
  // a file jumps straight to its saved position, and buffering pauses the
  // decoders — in both cases nothing has been decoded yet and that means nothing.
  if (el.readyState < 2 || !playerPlayingSince || performance.now() - playerPlayingSince < 3000) return;
  playerDecodeChecked = true;

  // Non-standard, Chromium-only: undefined on any engine that lacks it, and
  // `undefined === 0` is false, so an unknown engine simply stays quiet.
  const silent = el.webkitAudioDecodedByteCount === 0;
  const blind = playerCurrent.kind === "video" && el.videoWidth === 0;
  if (silent || blind) playerOfferConversion(playerCurrent.item, { silent, blind });
}

/** Only offer it if converting would actually bring the missing stream back. */
async function playerOfferConversion(item, flags) {
  let helps = false;
  try {
    helps = await convertWouldHelp(item, flags);
  } catch (_) { /* no ffmpeg, unreadable file — say nothing */ }
  if (!helps || !playerCurrent || !playerSameItem(playerCurrent.item, item)) return;

  playerNoticeFix = { item, flags };
  playerNoticeText.textContent = flags.silent
    ? "No sound — this file's audio codec cannot be played here."
    : "No picture — this file's video codec cannot be played here.";
  playerNotice.classList.add("show");
}

function playerNoticeHide() {
  playerNotice.classList.remove("show");
  playerNoticeFix = null;
}

playerNoticeBtn.addEventListener("click", () => {
  if (!playerNoticeFix) return;
  const { item, flags } = playerNoticeFix;
  playerNoticeHide();
  convertOpen(item, { reason: flags.silent ? "silent" : "blind" });
});

playerNoticeClose.addEventListener("click", playerNoticeHide);

// ── Audio visualizer ──
//
// A real AnalyserNode on the media element. Because the page is file:// and the
// stream is media://, this only works while the response stays CORS-approved;
// if the graph ever turns out to output silence, the element is rebuilt without
// it so sound comes back (see playerVisualizerWatchdog).

let playerAudioCtx = null;
let playerAnalyser = null;
let playerSourceNode = null;
let playerVizData = null;
let playerVizRaf = 0;
let playerVizDead = false;
let playerVizHeard = false;
let playerVizSilentSince = 0;

function playerStartVisualizer() {
  playerVizSilentSince = 0;
  if (playerVizDead) return;
  if (!playerAnalyser) {
    try {
      playerAudioCtx = new AudioContext();
      playerSourceNode = playerAudioCtx.createMediaElementSource(playerMedia);
      playerAnalyser = playerAudioCtx.createAnalyser();
      playerAnalyser.fftSize = 128;
      playerAnalyser.smoothingTimeConstant = 0.82;
      playerSourceNode.connect(playerAnalyser);
      playerAnalyser.connect(playerAudioCtx.destination);
      playerVizData = new Uint8Array(playerAnalyser.frequencyBinCount);
    } catch (_) {
      playerVizDead = true;
      playerAnalyser = null;
      return;
    }
  }
  playerResumeAudioContext();
  if (!playerVizRaf) playerVizRaf = requestAnimationFrame(playerVizDraw);
}

function playerStopVisualizer() {
  if (playerVizRaf) cancelAnimationFrame(playerVizRaf);
  playerVizRaf = 0;
}

function playerResumeAudioContext() {
  if (playerAudioCtx && playerAudioCtx.state === "suspended") playerAudioCtx.resume().catch(() => {});
}

function playerVizDraw() {
  playerVizRaf = requestAnimationFrame(playerVizDraw);
  if (!playerAnalyser || !playerOverlay.classList.contains("kind-audio")) return;

  const w = playerViz.clientWidth;
  const h = playerViz.clientHeight;
  if (!w || !h) return;
  const dpr = window.devicePixelRatio || 1;
  if (playerViz.width !== Math.round(w * dpr)) {
    playerViz.width = Math.round(w * dpr);
    playerViz.height = Math.round(h * dpr);
  }

  const ctx = playerViz.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  playerAnalyser.getByteFrequencyData(playerVizData);

  const bars = 32;
  const gap = 3;
  const bw = (w - gap * (bars - 1)) / bars;
  let peak = 0;
  const grad = ctx.createLinearGradient(0, h, 0, 0);
  grad.addColorStop(0, "rgba(255,255,255,.45)");
  grad.addColorStop(1, "rgba(255,255,255,.95)");
  ctx.fillStyle = grad;
  for (let i = 0; i < bars; i++) {
    // Spread the low end over more bars — that is where music lives.
    const v = playerVizData[Math.floor(Math.pow(i / bars, 1.7) * (playerVizData.length - 1))];
    if (v > peak) peak = v;
    const bh = Math.max(3, (v / 255) * h);
    ctx.beginPath();
    ctx.roundRect(i * (bw + gap), h - bh, bw, bh, Math.min(bw / 2, 3));
    ctx.fill();
  }
  playerVisualizerWatchdog(peak);
}

/** Silence out of the analyser while playing means the graph is muting us: undo it. */
function playerVisualizerWatchdog(peak) {
  if (playerVizHeard || playerMedia.paused || playerMedia.muted || playerMedia.volume === 0) return;
  if (peak > 0) {
    playerVizHeard = true;
    return;
  }
  if (!playerVizSilentSince) playerVizSilentSince = performance.now();
  else if (performance.now() - playerVizSilentSince > 5000) {
    playerVizDead = true;
    playerStopVisualizer();
    try { playerSourceNode.disconnect(); } catch (_) { /* ignore */ }
    playerRebuildMediaElement();
  }
}

/** A MediaElementSource cannot be detached, so swap in a fresh element. */
function playerRebuildMediaElement() {
  const old = playerMedia;
  const at = old.currentTime;
  const wasPlaying = !old.paused;
  const src = old.src;

  const fresh = document.createElement("video");
  fresh.id = old.id;
  fresh.className = old.className;
  fresh.playsInline = true;
  fresh.preload = "metadata";
  fresh.volume = old.volume;
  fresh.muted = old.muted;
  fresh.defaultPlaybackRate = old.defaultPlaybackRate;
  fresh.playbackRate = old.playbackRate;
  old.pause();
  old.replaceWith(fresh);
  playerMedia = fresh;
  playerAttachMediaEvents(fresh);

  fresh.addEventListener("loadedmetadata", () => {
    fresh.currentTime = at;
    if (wasPlaying) fresh.play().catch(() => {});
  }, { once: true });
  fresh.src = src;
  fresh.load();
}

// ── Toast ──

let playerToastTimer = 0;

function playerToastShow(message) {
  playerToast.textContent = message;
  playerToast.classList.add("show");
  clearTimeout(playerToastTimer);
  playerToastTimer = setTimeout(() => playerToast.classList.remove("show"), 2600);
}

// ── Controls ──

playerPlayBtn.addEventListener("click", playerTogglePlay);
playerPrevBtn.addEventListener("click", () => playerNext(-1));
playerNextBtn.addEventListener("click", () => playerNext(1));
playerCloseBtn.addEventListener("click", () => playerClose());

playerRevealBtn.addEventListener("click", () => {
  if (playerCurrent) playerReveal(playerCurrent.item);
});

playerExternalBtn.addEventListener("click", async () => {
  if (!playerCurrent) return;
  const { path: filePath, name: fileName } = playerCurrent.item;
  try {
    await call("openFile", { filePath, fileName });
  } catch (err) {
    playerToastShow("Could not open externally: " + err.message);
  }
});

playerMuteBtn.addEventListener("click", () => { playerMedia.muted = !playerMedia.muted; });

playerVolume.addEventListener("input", () => {
  playerMedia.volume = Number(playerVolume.value);
  playerMedia.muted = playerMedia.volume === 0;
});

// ── Playback speed ──
//
// The rate follows the listener rather than the file: it carries over to the
// next file and across restarts, which is why the button always spells it out.
// Both rates are set because load() resets playbackRate to defaultPlaybackRate,
// and every file starts with a load().

const PLAYER_RATES = [1, 1.25, 1.5, 2];

function playerRateLabel(rate) {
  return `${rate}×`;
}

function playerApplyRate(rate) {
  playerMedia.defaultPlaybackRate = rate;
  playerMedia.playbackRate = rate;
}

function playerSetRate(rate) {
  playerApplyRate(rate);
  try { localStorage.setItem(PLAYER_RATE_KEY, String(rate)); } catch (_) { /* ignore */ }
}

function playerSyncRateUi() {
  const rate = playerMedia.playbackRate;
  playerRateBtn.textContent = playerRateLabel(rate);
  playerRateBtn.title = rate === 1 ? "Playback speed" : `Playing at ${playerRateLabel(rate)}`;
  for (const btn of playerRateMenu.children) {
    const isCurrent = Number(btn.dataset.rate) === rate;
    btn.classList.toggle("current", isCurrent);
    btn.setAttribute("aria-checked", String(isCurrent));
  }
}

function playerRateMenuOpen(open) {
  playerRateMenu.classList.toggle("open", open);
  playerRateBtn.setAttribute("aria-expanded", String(open));
  playerWake();
}

for (const rate of PLAYER_RATES) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.dataset.rate = String(rate);
  btn.setAttribute("role", "menuitemradio");
  btn.textContent = rate === 1 ? "Normal" : playerRateLabel(rate);
  btn.addEventListener("click", () => {
    playerSetRate(rate);
    playerRateMenuOpen(false);
  });
  playerRateMenu.appendChild(btn);
}

playerRateBtn.addEventListener("click", () => {
  playerRateMenuOpen(!playerRateMenu.classList.contains("open"));
});

// A click anywhere else puts the menu away.
document.addEventListener("pointerdown", (e) => {
  if (playerRateMenu.classList.contains("open") && !e.target.closest(".player-rate")) playerRateMenuOpen(false);
}, true);

// ── Fullscreen ──
//
// The whole overlay goes fullscreen, which also puts the window in the OS's own
// fullscreen mode, and the chrome then floats over the picture (see the .fs
// rules in index.html). Left alone for a few seconds it fades out along with
// the cursor; a mouse or trackpad move, a key or a click brings it straight
// back. It never hides while paused or while the pointer rests on it — hiding
// what someone is about to click is never right.

const PLAYER_IDLE_MS = 2600;
let playerIdleTimer = 0;
let playerPointerOnChrome = false;

function playerToggleFullscreen() {
  if (document.fullscreenElement) {
    document.exitFullscreen().catch(() => {});
  } else {
    playerOverlay.requestFullscreen({ navigationUI: "hide" })
      .catch((err) => playerToastShow("Could not go fullscreen: " + err.message));
  }
}

function playerIsFullscreen() {
  return document.fullscreenElement === playerOverlay;
}

/** Show the chrome and restart the countdown to hiding it again. */
function playerWake() {
  playerOverlay.classList.remove("idle");
  clearTimeout(playerIdleTimer);
  if (playerIsFullscreen()) playerIdleTimer = setTimeout(playerGoIdle, PLAYER_IDLE_MS);
}

function playerGoIdle() {
  // No countdown while it would be wrong to hide: "play" and the pointer
  // leaving the chrome start a fresh one.
  if (!playerIsFullscreen() || playerMedia.paused || playerPointerOnChrome || playerSeeking) return;
  if (playerRateMenu.classList.contains("open")) return;
  playerOverlay.classList.add("idle");
}

playerFsBtn.addEventListener("click", playerToggleFullscreen);

document.addEventListener("fullscreenchange", () => {
  const on = playerIsFullscreen();
  playerOverlay.classList.toggle("fs", on);
  playerFsBtn.title = on ? "Leave fullscreen (f)" : "Fullscreen (f)";
  // Esc is taken by the browser to leave fullscreen before the page sees it,
  // so the menu has to be put away here rather than in the keyboard handler.
  playerRateMenuOpen(false);
  if (on) {
    playerWake();
  } else {
    clearTimeout(playerIdleTimer);
    playerOverlay.classList.remove("idle");
  }
});

// A trackpad move arrives as pointermove just like a mouse one.
playerOverlay.addEventListener("pointermove", playerWake);
playerOverlay.addEventListener("pointerdown", playerWake);
playerOverlay.addEventListener("wheel", playerWake, { passive: true });

for (const bar of [$("playerControls"), $("playerTop")]) {
  bar.addEventListener("pointerenter", () => { playerPointerOnChrome = true; });
  bar.addEventListener("pointerleave", () => {
    playerPointerOnChrome = false;
    playerWake();
  });
}

// Seek bar: click or drag anywhere on it.
let playerSeeking = false;

function playerSeekTo(e) {
  const d = playerMedia.duration;
  if (!Number.isFinite(d) || d <= 0) return;
  const rect = playerSeek.getBoundingClientRect();
  const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  playerMedia.currentTime = ratio * d;
  playerSetProgress(ratio, 0);
  playerTimeNow.textContent = playerFormatTime(playerMedia.currentTime);
}

playerSeek.addEventListener("pointerdown", (e) => {
  if (!playerCurrent) return;
  playerSeeking = true;
  playerSeek.classList.add("dragging");
  playerSeek.setPointerCapture(e.pointerId);
  playerSeekTo(e);
});
playerSeek.addEventListener("pointermove", (e) => { if (playerSeeking) playerSeekTo(e); });
playerSeek.addEventListener("pointerup", playerEndSeek);
playerSeek.addEventListener("pointercancel", playerEndSeek);

function playerEndSeek() {
  playerSeeking = false;
  playerSeek.classList.remove("dragging");
  playerWake(); // the countdown paused during the drag
}

// ── Swiping between files ──

let playerSwipeId = null;
let playerSwipeStartX = 0;
let playerSwipeDx = 0;
let playerSwipeMoved = false;

playerStage.addEventListener("pointerdown", (e) => {
  if (e.button !== 0 || e.target.closest("button")) return;
  playerSwipeId = e.pointerId;
  playerSwipeStartX = e.clientX;
  playerSwipeDx = 0;
  playerSwipeMoved = false;
  playerStage.setPointerCapture(e.pointerId);
  playerSlide.style.transition = "none";
});

playerStage.addEventListener("pointermove", (e) => {
  if (e.pointerId !== playerSwipeId) return;
  playerSwipeDx = e.clientX - playerSwipeStartX;
  if (Math.abs(playerSwipeDx) > 6) playerSwipeMoved = true;
  playerSlide.style.transform = `translateX(${playerSwipeDx * 0.35}px)`;
  playerSlide.style.opacity = String(Math.max(0.35, 1 - Math.abs(playerSwipeDx) / 700));
});

function playerEndSwipe(e) {
  if (e.pointerId !== playerSwipeId) return;
  playerSwipeId = null;
  playerSlide.style.transition = "";
  playerSlide.style.transform = "";
  playerSlide.style.opacity = "";
  const dx = playerSwipeDx;
  playerSwipeDx = 0;
  if (Math.abs(dx) >= 90) playerNext(dx < 0 ? 1 : -1);
  else if (!playerSwipeMoved) playerTogglePlay();
}

playerStage.addEventListener("pointerup", playerEndSwipe);
playerStage.addEventListener("pointercancel", playerEndSwipe);
playerStage.addEventListener("dblclick", (e) => {
  if (e.target.closest("button")) return;
  playerToggleFullscreen();
});

// Trackpad: a horizontal two-finger swipe moves to the next/previous file.
const PLAYER_GESTURE_GAP_MS = 250; // silence this long means the flick is over

let playerWheelAccum = 0;
let playerWheelAt = 0;
let playerWheelLocked = false;

playerStage.addEventListener("wheel", (e) => {
  if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
  e.preventDefault();
  const now = performance.now();
  const gap = now - playerWheelAt;
  playerWheelAt = now;

  // One flick keeps firing while it decelerates. Rather than guess how long
  // that lasts, take one file per gesture: stay locked until the wheel falls
  // silent, which is what separates a new flick from the tail of this one.
  if (playerWheelLocked) {
    if (gap <= PLAYER_GESTURE_GAP_MS) return;
    playerWheelLocked = false;
  }
  if (gap > PLAYER_GESTURE_GAP_MS) playerWheelAccum = 0; // a new gesture
  playerWheelAccum += e.deltaX;

  if (Math.abs(playerWheelAccum) > 140) {
    playerNext(playerWheelAccum > 0 ? 1 : -1);
    playerWheelAccum = 0;
    playerWheelLocked = true;
  }
}, { passive: false });

// ── Keyboard ──

document.addEventListener("keydown", (e) => {
  if (!playerOverlay.classList.contains("open")) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return; // leave Cmd/Ctrl shortcuts alone

  switch (e.key) {
    case "Escape":
      // In fullscreen Esc means "give me the window back", not "close the file".
      if (playerRateMenu.classList.contains("open")) playerRateMenuOpen(false);
      else if (playerIsFullscreen()) document.exitFullscreen().catch(() => {});
      else playerClose();
      break;
    case " ":
    case "k":
      playerTogglePlay();
      break;
    case "ArrowLeft":
      e.shiftKey ? playerNext(-1) : playerSeekBy(-10);
      break;
    case "ArrowRight":
      e.shiftKey ? playerNext(1) : playerSeekBy(10);
      break;
    case "PageUp":
      playerNext(-1);
      break;
    case "PageDown":
      playerNext(1);
      break;
    case "ArrowUp":
      playerMedia.volume = Math.min(1, playerMedia.volume + 0.05);
      break;
    case "ArrowDown":
      playerMedia.volume = Math.max(0, playerMedia.volume - 0.05);
      break;
    case "m":
      playerMedia.muted = !playerMedia.muted;
      break;
    case "f":
      playerToggleFullscreen();
      break;
    default:
      return;
  }
  playerWake();
  e.preventDefault();
  e.stopPropagation();
}, true);

playerOverlay.addEventListener("click", (e) => {
  if (e.target === playerOverlay) playerClose();
});

window.addEventListener("beforeunload", () => { playerSavePosition({ force: true }); });

// ── Init ──

playerAttachMediaEvents(playerMedia);
try {
  const saved = Number(localStorage.getItem(PLAYER_VOLUME_KEY));
  if (Number.isFinite(saved) && saved > 0) playerMedia.volume = saved;
} catch (_) { /* ignore */ }
playerVolume.value = String(playerMedia.volume);

try {
  const savedRate = Number(localStorage.getItem(PLAYER_RATE_KEY));
  if (PLAYER_RATES.includes(savedRate)) playerApplyRate(savedRate);
} catch (_) { /* ignore */ }
playerSyncRateUi();
