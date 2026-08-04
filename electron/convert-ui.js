"use strict";

/**
 * The "convert this file" dialog.
 *
 * Opened from two places (both in player.js): a file whose container the player
 * cannot open at all, and a file that starts loading and then fails on its
 * codec. It shows what ffmpeg would do to the file — which streams are copied,
 * which are re-encoded — before anything is touched, and explains how to
 * install ffmpeg when it is missing.
 *
 * Loaded after renderer.js and player.js: $, call(), loadSharedFiles(),
 * playerPlayItem() and playerClose() come from there.
 */

const convertOverlay   = $("convertOverlay");
const convertHeading   = $("convertHeading");
const convertFileName  = $("convertFileName");
const convertBody      = $("convertBody");
const convertRevealBtn = $("convertRevealBtn");
const convertCloseBtn  = $("convertCloseBtn");
const convertStartBtn  = $("convertStartBtn");

/** @type {{ path: string, name: string, title: string, hash: string } | null} */
let convertItem = null;
let convertReason = "container";
/** "loading" | "missing" | "ready" | "running" | "done" | "error" */
let convertState = "loading";

function convertEscape(str) {
  return escapeHtml(String(str ?? ""));
}

function convertFormatDuration(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return "";
  const s = Math.round(sec % 60);
  const m = Math.floor(sec / 60) % 60;
  const h = Math.floor(sec / 3600);
  return h ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m ${String(s).padStart(2, "0")}s`;
}

function convertSetState(state, { html, canConvert = false, convertLabel = "Convert" } = {}) {
  convertState = state;
  if (html != null) convertBody.innerHTML = html;
  convertStartBtn.style.display = canConvert || state === "running" ? "" : "none";
  convertStartBtn.textContent = state === "running" ? "Cancel conversion" : convertLabel;
  convertStartBtn.classList.toggle("primary", state !== "running");
  convertStartBtn.classList.toggle("danger", state === "running");
  convertStartBtn.disabled = false;
  convertCloseBtn.textContent = state === "running" ? "Hide" : "Close";
  convertRevealBtn.style.display = state === "running" ? "none" : "";
}

const CONVERT_HEADINGS = {
  container: "This file cannot be played here",
  codec: "This file's codec cannot be played here",
  silent: "This file plays without sound here",
  blind: "This file plays without a picture here",
};

// ── Opening ──

/** Ask about a file without opening anything — used by the player watchdog. */
function convertInspectItem(item) {
  return call("convertInspect", { filePath: item.path, fileName: item.name, caps: playerCodecSupport() });
}

/**
 * Would converting bring back the stream the player could not decode? Called
 * when a file plays silently or without a picture, where offering a pointless
 * conversion would be worse than staying quiet.
 */
async function convertWouldHelp(item, { silent, blind }) {
  const info = await convertInspectItem(item);
  if (!info.ready || !info.plan) return false;
  if (silent) return Boolean(info.plan.hasAudio && info.plan.reencodesAudio);
  if (blind) return Boolean(info.plan.reencodesVideo);
  return true;
}

/**
 * @param {object} item row item: { path, name, title, hash }
 * @param {string} reason which of CONVERT_HEADINGS to show.
 */
async function convertOpen(item, { reason = "container" } = {}) {
  if (convertState === "running") {
    // A conversion is already going: just show it again rather than replace it.
    convertOverlay.classList.add("open");
    return;
  }

  convertItem = item;
  convertReason = reason;
  playerClose();
  convertFileName.textContent = item.title || item.name;
  convertHeading.textContent = CONVERT_HEADINGS[reason] || CONVERT_HEADINGS.container;
  convertOverlay.classList.add("open");
  convertSetState("loading", { html: `<p class="muted">Looking at the file…</p>` });

  try {
    const info = await convertInspectItem(item);
    if (convertItem !== item) return;
    if (!info.ready) convertRenderMissing(info);
    else convertRenderPlan(info);
  } catch (err) {
    if (convertItem !== item) return;
    convertSetState("error", { html: `<p class="error">${convertEscape(err.message)}</p>` });
  }
}

function convertRenderMissing(info) {
  const hint = info.hint || {};
  convertSetState("missing", {
    html: `
      <p>The app can convert it with <strong>ffmpeg</strong>, but ffmpeg is not installed on this computer.</p>
      <div class="convert-cmd">
        <code id="convertCmd">${convertEscape(hint.command || "")}</code>
        <button id="convertCopyCmd" title="Copy the command">⧉</button>
      </div>
      ${hint.note ? `<p class="muted convert-small">${convertEscape(hint.note)}</p>` : ""}
      ${hint.url ? `<p class="muted convert-small"><a href="#" id="convertHintLink" data-url="${convertEscape(hint.url)}">${convertEscape(hint.url)}</a></p>` : ""}
      ${info.error ? `<p class="error convert-small">ffmpeg was found but could not be run: ${convertEscape(info.error)}</p>` : ""}
      <p class="muted convert-small">Install it, then press Check again — no restart needed.</p>
    `,
    canConvert: true,
    convertLabel: "Check again",
  });
}

function convertRenderPlan(info) {
  const plan = info.plan || {};
  const rows = (plan.summary || [])
    .map((row) => `
      <div class="convert-row">
        <span class="convert-row-label">${convertEscape(row.label)}</span>
        <span class="convert-row-from">${convertEscape(row.from)}</span>
        <span class="convert-row-arrow">→</span>
        <span class="convert-row-to">${convertEscape(row.to)}</span>
      </div>`)
    .join("");

  const duration = convertFormatDuration(plan.duration);
  const speedNote = plan.reencodesVideo
    ? "Re-encoding the video takes a while — expect roughly as long as the film runs, sometimes more."
    : plan.transcodes
      ? "The picture is untouched and only the audio is re-encoded, so this takes about as long as copying the file."
      : "Nothing has to be re-encoded — this is only a repackage, about as long as copying the file.";

  convertSetState("ready", {
    html: `
      <div class="convert-plan">${rows}</div>
      <p class="muted convert-small">${convertEscape(speedNote)}${duration ? ` (${convertEscape(duration)} of media)` : ""}</p>
      <div class="convert-note">
        <div><strong>${convertEscape(plan.targetName || "")}</strong> replaces the original, which goes to the Trash.</div>
        <div class="convert-small">Rewriting the file changes its ed2k hash, so aMule shares it as a new file and its stats start over.</div>
      </div>
      ${plan.probed ? "" : `<p class="muted convert-small">ffprobe could not read the file's streams, so everything is re-encoded.</p>`}
      <p class="muted convert-small">${convertEscape(info.version || "")}</p>
    `,
    canConvert: true,
  });
}

// ── Running ──

function convertRenderRunning() {
  convertSetState("running", {
    html: `
      <div class="convert-bar"><div id="convertBarFill" class="indeterminate"></div></div>
      <div class="convert-status">
        <span id="convertPercent">Starting ffmpeg…</span>
        <span class="spacer"></span>
        <span id="convertEta" class="muted"></span>
      </div>
      <p class="muted convert-small">You can hide this dialog — the conversion keeps running, and the file is only replaced once it succeeds.</p>
    `,
  });
}

function convertOnProgress(p) {
  if (convertState !== "running") return;
  const fill = $("convertBarFill");
  const percent = $("convertPercent");
  const eta = $("convertEta");
  if (!fill || !percent || !eta) return;

  if (p.percent == null) {
    percent.textContent = `Converted ${convertFormatDuration(p.seconds) || "0s"}`;
  } else {
    fill.classList.remove("indeterminate");
    fill.style.width = `${p.percent.toFixed(1)}%`;
    percent.textContent = `${p.percent.toFixed(1)}%`;
  }
  const bits = [];
  if (p.eta != null) bits.push(p.eta < 15 ? "almost done" : `about ${convertFormatDuration(p.eta)} left`);
  if (p.speed) bits.push(`${p.speed.toFixed(1)}× speed`);
  eta.textContent = bits.join(" · ");
}

async function convertRun() {
  const item = convertItem;
  if (!item) return;
  convertRenderRunning();

  let result;
  try {
    result = await call("convertStart", { filePath: item.path, fileName: item.name, caps: playerCodecSupport() });
  } catch (err) {
    if (convertItem !== item) return;
    convertSetState("error", {
      html: `<p class="error">Conversion failed:</p><pre class="convert-err">${convertEscape(err.message)}</pre>
             <p class="muted convert-small">The original file was not touched.</p>`,
    });
    return;
  }
  if (convertItem !== item) return;

  if (result.canceled) {
    convertSetState("error", { html: `<p class="muted">Conversion canceled. The original file was not touched.</p>` });
    return;
  }

  // Straight into the player: the file is playable now, which is the whole point.
  convertState = "done";
  convertItem = null;
  convertOverlay.classList.remove("open");
  if (typeof loadSharedFiles === "function") loadSharedFiles();

  await playerPlayItem({ path: result.filePath, name: result.fileName, title: result.fileName, hash: "" });
  playerToastShow(result.originalTrashed
    ? `Converted — “${result.originalName}” moved to the Trash`
    : `Converted — “${result.originalName}” could not be trashed and is still on disk`);
}

function convertClose() {
  convertOverlay.classList.remove("open");
  if (convertState !== "running") convertItem = null;
}

// ── Controls ──

convertOverlay.addEventListener("click", (e) => {
  if (e.target === convertOverlay) convertClose();
});

convertCloseBtn.addEventListener("click", convertClose);

convertRevealBtn.addEventListener("click", async () => {
  if (!convertItem) return;
  try {
    await call("revealFile", { filePath: convertItem.path, fileName: convertItem.name });
  } catch (err) {
    alert("Could not open the file's folder:\n" + err.message);
  }
});

convertStartBtn.addEventListener("click", async () => {
  if (convertState === "running") {
    convertStartBtn.disabled = true;
    await call("convertCancel").catch(() => {});
    return;
  }
  if (convertState === "missing") {
    convertStartBtn.disabled = true;
    convertSetState("loading", { html: `<p class="muted">Looking for ffmpeg…</p>` });
    const item = convertItem;
    try {
      const t = await call("convertRecheck");
      if (convertItem !== item) return;
      if (!t.ready) convertRenderMissing({ ready: false, hint: t.hint, error: t.error });
      else convertOpen(item, { reason: convertReason });
    } catch (err) {
      convertSetState("error", { html: `<p class="error">${convertEscape(err.message)}</p>` });
    }
    return;
  }
  if (convertState === "ready") convertRun();
});

convertBody.addEventListener("click", async (e) => {
  const copy = e.target.closest("#convertCopyCmd");
  if (copy) {
    try {
      await navigator.clipboard.writeText($("convertCmd").textContent);
      copy.textContent = "✓";
      setTimeout(() => { copy.textContent = "⧉"; }, 1500);
    } catch (_) { /* the command is right there to select by hand */ }
    return;
  }
  const link = e.target.closest("#convertHintLink");
  if (link) {
    e.preventDefault();
    window.open(link.dataset.url, "_blank", "noopener");
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && convertOverlay.classList.contains("open")) {
    e.stopPropagation();
    convertClose();
  }
}, true);

window.amule.onConvertProgress(convertOnProgress);
