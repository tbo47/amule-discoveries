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

// ── Opening ──

/** Extensions main.js can stream, fetched once and cached. */
function playerPlayableExtensions() {
  if (!playerExtsPromise) {
    playerExtsPromise = call("mediaExtensions")
      .then((e) => new Set([...(e.audio || []), ...(e.video || [])]))
      .catch(() => new Set());
  }
  return playerExtsPromise;
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
 * as the playlist. Unplayable files are shown in the file manager instead.
 */
async function openMediaFromRow(el) {
  const clicked = playerRowItem(el);
  if (!clicked.path) return;

  const exts = await playerPlayableExtensions();
  if (!exts.has(playerExtOf(clicked.name))) {
    await playerReveal(clicked);
    return;
  }

  const scope = el.closest("tbody") || document;
  const siblings = [...scope.querySelectorAll(".shared-play[data-path]")]
    .map(playerRowItem)
    .filter((it) => it.path && exts.has(playerExtOf(it.name)));

  playerList = siblings.length ? siblings : [clicked];
  const index = playerList.findIndex((it) => playerSameItem(it, clicked));
  await playerLoad(index < 0 ? 0 : index);
}

/** @param {number} direction -1/1 animates the slide, 0 does not (first open). */
async function playerLoad(index, direction = 0) {
  if (index < 0 || index >= playerList.length) return;

  // Claim the index up front so swiping faster than files load still advances
  // one file per swipe instead of fighting the in-flight load.
  playerIndex = index;
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
  });
  el.addEventListener("progress", playerSyncProgress);
  el.addEventListener("seeked", () => playerSavePosition({ force: true }));

  el.addEventListener("play", () => {
    playerPlayBtn.textContent = "❚❚";
    playerPlayBtn.title = "Pause (Space)";
    playerOverlay.classList.add("playing");
    playerResumeAudioContext();
  });
  el.addEventListener("pause", () => {
    playerPlayBtn.textContent = "▶";
    playerPlayBtn.title = "Play (Space)";
    playerOverlay.classList.remove("playing");
    playerSavePosition({ force: true });
  });

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
    // The container was in the playable list but the codec inside is not.
    const item = playerCurrent.item;
    const token = playerLoadToken;
    playerToastShow("This file cannot be played here — opening its folder.");
    setTimeout(async () => {
      if (token !== playerLoadToken) return;
      await playerClose();
      await playerReveal(item);
    }, 1200);
  });

  el.addEventListener("volumechange", () => {
    playerVolume.value = String(el.muted ? 0 : el.volume);
    playerMuteBtn.textContent = el.muted || el.volume === 0 ? "🔇" : "🔊";
    if (!el.muted) {
      try { localStorage.setItem(PLAYER_VOLUME_KEY, String(el.volume)); } catch (_) { /* ignore */ }
    }
  });
}

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

playerFsBtn.addEventListener("click", () => {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else playerOverlay.requestFullscreen().catch(() => {});
});

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
playerSeek.addEventListener("pointerup", () => {
  playerSeeking = false;
  playerSeek.classList.remove("dragging");
});
playerSeek.addEventListener("pointercancel", () => {
  playerSeeking = false;
  playerSeek.classList.remove("dragging");
});

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
  playerFsBtn.click();
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
      playerClose();
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
      playerFsBtn.click();
      break;
    default:
      return;
  }
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
