"use strict";

// ── DOM references ──
const $ = (id) => document.getElementById(id);

const loginScreen  = $("loginScreen");
const mainApp      = $("mainApp");
const hostEl       = $("host");
const portEl       = $("port");
const passwordEl   = $("password");
const connectBtn   = $("connectBtn");
const disconnectBtn = $("disconnectBtn");
const statusDot    = $("statusDot");
const statusText   = $("statusText");
const speedInfo    = $("speedInfo");

const addLinkBtn   = $("addLinkBtn");
const ed2kLinkEl   = $("ed2kLink");

const sharedBody       = $("sharedBody");
const sharedEmpty      = $("sharedEmpty");
const refreshSharedBtn = $("refreshSharedBtn");
const importExportBtn  = $("importExportBtn");
const importExportMenu = $("importExportMenu");
const menuExportBtn    = $("menuExportBtn");
const menuImportBtn    = $("menuImportBtn");

const searchQuery   = $("searchQuery");
const searchNetwork = $("searchNetwork");
const searchBtn     = $("searchBtn");
const searchBody    = $("searchBody");
const searchStatus  = $("searchStatus");
const searchPopularTags = $("searchPopularTags");

let connected = false;
let sharedByHash = new Map();
let queuedByHash = new Map();

/** Last fetched My Collection rows (server order); sorting is applied in the UI only. */
let sharedListCache = [];
let lastSearchResults = [];
/** @type {{ key: "name"|"size"|"popularity"|"added"|"rating", dir: "asc"|"desc" }} */
let sharedSort = { key: "added", dir: "desc" };
const SHARED_SORT_DEFAULTS = { name: "asc", size: "desc", popularity: "desc", added: "desc" };

const sharedThead = $("sharedThead");

// ── Helpers ──

function formatBytes(bytes) {
  if (bytes == null || isNaN(bytes)) return "—";
  const b = Number(bytes);
  if (b === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(Math.floor(Math.log(b) / Math.log(1024)), units.length - 1);
  return (b / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + " " + units[i];
}

function sanitizePort(val) {
  const n = Number(val);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : 4712;
}

function escapeHtml(str) {
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
}

function escapeAttr(str) {
  return String(str).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function displayFileName(name) {
  return String(name || "?")
    .replaceAll("A\u0303\u00a9", "\u00e9")
    .replaceAll("A\u0303\u00a8", "\u00e8")
    .replaceAll("A\u0303\u00b4", "o")
    .replaceAll("A\u0303\u00aa", "e")
    .replaceAll("A\u0303\u00a7", "c");
}

function ed2kUrl(r) {
  return `ed2k://|file|${encodeURIComponent(r.fileName || "unknown")}|${r.fileSize || 0}|${r.fileHash}|/`;
}

function fileHashKey(hash) {
  return hash ? String(hash).toLowerCase() : "";
}

function sharedPlayButton(shared, fallbackName = "") {
  const path = shared?.path || "";
  const name = shared?.fileName || fallbackName;
  const disabled = path ? "" : " disabled";
  const title = path ? "Open file" : "File path unavailable";
  return `<button class="shared-play" data-path="${escapeAttr(path)}" data-name="${escapeAttr(name)}" title="${escapeAttr(title)}"${disabled}>▶ Play</button>`;
}

/** Download button for search / discovery / peer rows; only the CSS class differs. */
function downloadButton(r, className) {
  const hash = r.fileHash || "";
  const link = r.ed2kLink || (hash ? ed2kUrl(r) : "");
  const disabled = hash || link ? "" : " disabled";
  return `<button class="${escapeAttr(className)}" data-hash="${escapeAttr(hash)}" data-link="${escapeAttr(link)}"${disabled}>Download</button>`;
}

function queuedDownloadButton(download, options = {}) {
  const label = options.label || "Queued";
  const className = options.className || "sr-queued";
  const progress = download?.progress != null ? ` (${download.progress}%)` : "";
  return `<button class="${escapeAttr(className)}" title="Already in download queue" disabled>${escapeHtml(label)}${escapeHtml(progress)}</button>`;
}

/**
 * Action button for a result row: play (if already shared), a disabled "queued"
 * badge (if in the download queue), or a download button — shared by the search,
 * discovery, and peer tables.
 * @param {object} opts - downloadClass, queuedLabel, queuedClass, and requirePath
 *   (search shows Play for any shared match; discovery/peer only when a local path exists).
 */
function actionCell(r, opts) {
  const hashKey = fileHashKey(r.fileHash);
  const shared = sharedByHash.get(hashKey);
  const queued = queuedByHash.get(hashKey);
  if (shared && (opts.requirePath === false || shared.path)) {
    return sharedPlayButton(shared, r.fileName || "");
  }
  if (queued) {
    return queuedDownloadButton(queued, { label: opts.queuedLabel, className: opts.queuedClass });
  }
  return downloadButton(r, opts.downloadClass);
}

/**
 * Handle a click on a ".shared-play" button within a results table.
 * Returns true if the click was a play button (and was handled), so callers can early-return.
 */
async function handleSharedPlayClick(e) {
  const play = e.target.closest(".shared-play");
  if (!play) return false;
  try {
    await call("openFile", { filePath: play.dataset.path, fileName: play.dataset.name });
  } catch (err) {
    alert("Could not open file:\n" + err.message);
  }
  return true;
}

/** Lifetime upload ÷ file size (aMule transferredTotal / fileSize). */
function uploadRatio(f) {
  const size = Number(f.fileSize);
  const up = Number(f.transferredTotal ?? f.transferred) || 0;
  if (!size || size <= 0) return 0;
  return up / size;
}

/** Map each file to 0–5★ by rank within this list (max ratio → 5, min → 0). */
function starRatingsForList(list) {
  const ratios = list.map(uploadRatio);
  const max = Math.max(...ratios, 0);
  const min = Math.min(...ratios);
  if (max <= 0) return ratios.map(() => 0);
  if (max === min) return ratios.map(() => 5);
  return ratios.map((r) => Math.round((5 * (r - min)) / (max - min)));
}

function popularityCell(f, stars) {
  const size = Number(f.fileSize);
  const up = Number(f.transferredTotal ?? f.transferred) || 0;
  const r = uploadRatio(f);
  const tip =
    size > 0
      ? `${stars}/5 · ratio ${r.toFixed(2)}× · ${formatBytes(up)} uploaded / ${formatBytes(size)}`
      : "—";
  const visual = "★".repeat(stars) + "☆".repeat(5 - stars);
  return `<span class="stars" title="${escapeAttr(tip)}">${visual}</span>`;
}

/** Common English + French words (≥3 chars still filtered separately). */
const STOP_WORDS = new Set(
  `a an the and or but if so as at by for from in into of off on onto out over to toward with without
  about after against before between beyond through during across around behind beneath
  be am is are was were been being have has had do does did done will would shall should could might must can need may
  this that these those it its he him his she her they them their we us our you your my me mine
  what which who whom whose where when why how than then though although because while until unless since
  all any both each every few many more most other some such same own another
  not no nor yet only just also still even already again once here there now then very
  each either neither none
  get got go going gone come came make made take took give gave see saw know knew think thought say said use used try let make
  yes no ok
  le la les des un une du de et est pas pour que qui dont ou ni car dans sur avec par sans sous entre vers parmi
  son sa ses ce cet cette ces aux en y ne plus tout tous toute toutes comme aussi bien tres encore jamais toujours alors donc ainsi
  moi toi lui elle nous vous eux leur leurs meme autre autres chaque plusieurs quelque
  lors lorsque depuis lorsqu encore
  une des vos nos mon ton ta tes leur
  vostfr vost truefrench french multi multis proper repack internal readnfo nfo wiki redef redif`
    .split(/\s+/)
    .filter(Boolean)
);

/** Codec / release tokens to ignore as keywords. */
const KEYWORD_SKIP = new Set([
  "mkv", "mp4", "avi", "wmv", "flv", "mov", "mpg", "mpeg", "m4v", "m2ts", "ts", "vob", "iso", "divx", "xvid",
  "ac3", "dts", "aac", "srt", "sub", "idx", "ass", "ssa", "bdrip", "dvdrip", "webrip", "brrip", "bluray", "hdtv",
  "h264", "h265", "x264", "x265", "hevc", "10bit", "720p", "1080p", "2160p", "4k", "hdr", "uhd", "subs", "subtitle",
  "dvd", "cd", "rip", "dl", "web", "www", "com", "org",
]);

function tokenizeFileNameForKeywords(name) {
  if (!name) return [];
  const parts = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .split(/[^a-z0-9]+/i);
  const out = [];
  for (const w of parts) {
    if (w.length < 3) continue;
    if (/^\d+$/.test(w)) continue;
    if (STOP_WORDS.has(w)) continue;
    if (KEYWORD_SKIP.has(w)) continue;
    out.push(w);
  }
  return out;
}

function computePopularKeywordsFromCollection(files) {
  const counts = new Map();
  for (const f of files || []) {
    for (const w of tokenizeFileNameForKeywords(f.fileName || "")) {
      counts.set(w, (counts.get(w) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 10)
    .map(([word, count]) => ({ word, count }));
}

function renderSearchPopularKeywords() {
  if (!searchPopularTags) return;
  const ranked = computePopularKeywordsFromCollection(sharedListCache);
  if (ranked.length === 0) {
    searchPopularTags.innerHTML =
      '<span class="muted">No keywords yet — files in My Collection will suggest terms here.</span>';
    return;
  }
  searchPopularTags.innerHTML = ranked
    .map(
      ({ word, count }) =>
        `<button type="button" class="search-kw-tag" data-word="${escapeAttr(word)}">${escapeHtml(word)}<span class="kw-n">${count}</span></button>`
    )
    .join("");
}

async function call(method, arg) {
  const result = await window.amule[method](arg);
  if (!result.ok) throw new Error(result.error);
  return result.data;
}

// ── Connection state ──

const discKeywordInput  = $("discKeywordInput");
const discIntervalSelect = $("discIntervalSelect");
const discAddBtn        = $("discAddBtn");
const discRunNowBtn     = $("discRunNowBtn");
const discKeywords      = $("discKeywords");
const discBody          = $("discBody");
const discEmpty         = $("discEmpty");
const discLog           = $("discLog");
const discPagination    = $("discPagination");
const discPrevPage      = $("discPrevPage");
const discNextPage      = $("discNextPage");
const discPageStatus    = $("discPageStatus");
const discSearchInput   = $("discSearch");

const peerScanBtn       = $("peerScanBtn");
const peerStatus        = $("peerStatus");
const peerBody          = $("peerBody");
const peerEmpty         = $("peerEmpty");
const peerSearchInput   = $("peerSearch");

let sharedTimer = null;

function setLoginUiVisible(loggedIn) {
  loginScreen.classList.toggle("hidden", loggedIn);
  mainApp.classList.toggle("hidden", !loggedIn);
}

async function setConnected(val) {
  connected = val;
  setLoginUiVisible(val);
  statusDot.className = "status-dot " + (val ? "on" : "off");
  statusText.textContent = val ? "Connected" : "Disconnected";
  connectBtn.disabled = val;
  disconnectBtn.disabled = !val;

  const actionBtns = [addLinkBtn, refreshSharedBtn, importExportBtn, searchBtn, discRunNowBtn, peerScanBtn];
  for (const b of actionBtns) b.disabled = !val;

  if (!val) speedInfo.textContent = "";

  if (val) {
    await loadSharedFiles();
    setTimeout(loadSharedFiles, 1_000);
    sharedTimer = setInterval(loadSharedFiles, 10_000);
  } else if (sharedTimer) {
    clearInterval(sharedTimer);
    sharedTimer = null;
  }
}

// ── Tabs ──

const tabBar = $("tabBar");

function selectTab(tab) {
  for (const t of tabBar.children) t.classList.remove("active");
  tab.classList.add("active");
  for (const p of document.querySelectorAll(".panel")) p.classList.remove("active");
  $("panel-" + tab.dataset.tab).classList.add("active");
}

tabBar.addEventListener("click", (e) => {
  const tab = e.target.closest(".tab");
  if (!tab) return;
  selectTab(tab);
});

// Chrome-style tab switching: Cmd/Ctrl+1..8 selects the Nth tab, Cmd/Ctrl+9 the last one.
document.addEventListener("keydown", (e) => {
  if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
  if (e.key < "1" || e.key > "9") return;
  const tabs = tabBar.children;
  const tab = e.key === "9" ? tabs[tabs.length - 1] : tabs[Number(e.key) - 1];
  if (!tab) return;
  e.preventDefault();
  selectTab(tab);
});

// ── Connect / Disconnect ──

const loginForm = $("loginForm");

/** Connect using the login form fields; silent suppresses the failure alert (startup auto-connect). */
async function connectWithForm({ silent = false } = {}) {
  const host = hostEl.value.trim() || "127.0.0.1";
  const port = sanitizePort(portEl.value);
  hostEl.value = host;
  portEl.value = String(port);

  connectBtn.disabled = true;
  connectBtn.textContent = "Connecting…";
  try {
    await call("connect", { host, port, password: passwordEl.value });
    setConnected(true);
  } catch (err) {
    if (!silent) alert("Connection failed:\n" + err.message);
    setConnected(false);
  } finally {
    connectBtn.textContent = "Connect";
    if (!connected) connectBtn.disabled = false;
  }
}

loginForm.addEventListener("submit", (e) => {
  e.preventDefault();
  connectWithForm();
});

disconnectBtn.addEventListener("click", async () => {
  try { await call("disconnect"); } catch (_) { /* ignore */ }
  setConnected(false);
});

// ── Add Link ──

addLinkBtn.addEventListener("click", async () => {
  const link = ed2kLinkEl.value.trim();
  if (!link) return;
  try {
    await call("addEd2kLink", { link, categoryId: 0 });
    ed2kLinkEl.value = "";
  } catch (err) {
    alert(err.message);
  }
});

// ── Shared Files ──

function sortSharedList(list) {
  const { key, dir } = sharedSort;
  const mult = dir === "asc" ? 1 : -1;
  list.sort((a, b) => {
    let c = 0;
    switch (key) {
      case "name":
        c = (a.fileName || "").localeCompare(b.fileName || "", undefined, { sensitivity: "base" });
        break;
      case "size":
        c = (Number(a.fileSize) || 0) - (Number(b.fileSize) || 0);
        break;
      case "popularity":
        c = uploadRatio(a) - uploadRatio(b);
        break;
      case "added":
        c = (Number(a.firstSeen) || 0) - (Number(b.firstSeen) || 0);
        break;
      default:
        return 0;
    }
    if (c !== 0) return mult * c;
    return (a.fileName || "").localeCompare(b.fileName || "", undefined, { sensitivity: "base" });
  });
  return list;
}

function updateSharedHeaderSortIndicators() {
  if (!sharedThead) return;
  for (const th of sharedThead.querySelectorAll("th[data-sort]")) {
    const key = th.dataset.sort;
    const ind = th.querySelector(".sort-ind");
    if (!ind) continue;
    if (key === sharedSort.key) {
      th.classList.add("sort-active");
      ind.textContent = sharedSort.dir === "asc" ? "↑" : "↓";
    } else {
      th.classList.remove("sort-active");
      ind.textContent = "";
    }
  }
}

function applySharedSortAndRender() {
  const query = ($("sharedSearch")?.value || "").trim().toLowerCase();
  let list = sharedListCache.slice();
  if (query) list = list.filter(f => (f.fileName || "").toLowerCase().includes(query));
  if (!list.length) {
    renderSharedFiles([]);
    updateSharedHeaderSortIndicators();
    return;
  }
  renderSharedFiles(sortSharedList(list));
  updateSharedHeaderSortIndicators();
}

async function loadSharedFiles() {
  try {
    const [list, queue] = await Promise.all([
      call("getSharedFiles"),
      call("getDownloadQueue"),
    ]);
    sharedListCache = list || [];
    sharedByHash = new Map();
    for (const f of sharedListCache) {
      const key = fileHashKey(f.fileHash);
      if (key) sharedByHash.set(key, f);
    }
    queuedByHash = new Map();
    for (const d of queue || []) {
      const key = fileHashKey(d.fileHash);
      if (key) queuedByHash.set(key, d);
    }
    applySharedSortAndRender();
    reRenderDiscoveryResults();
    reRenderSearchResults();
    renderSearchPopularKeywords();
  } catch (err) {
    sharedListCache = [];
    queuedByHash = new Map();
    sharedBody.innerHTML = `<tr><td colspan="6" class="error">${escapeHtml(err.message)}</td></tr>`;
    updateSharedHeaderSortIndicators();
    reRenderSearchResults();
    renderSearchPopularKeywords();
  }
}


function renderSharedFiles(list) {
  if (!list || list.length === 0) {
    sharedBody.innerHTML = "";
    sharedEmpty.style.display = "block";
    return;
  }
  sharedEmpty.style.display = "none";
  const popRatings = starRatingsForList(list);
  sharedBody.innerHTML = list.map((f, i) => {
    const path = f.path || "";
    const link = f.ed2kLink || ed2kUrl(f);
    return `<tr>
      <td>${path ? sharedPlayButton(f) : "—"}</td>
      <td title="${escapeHtml(path)}">${escapeHtml(f.fileName || "?")}</td>
      <td>${formatBytes(f.fileSize)}</td>
      <td class="muted" style="white-space:nowrap;letter-spacing:1px">${popularityCell(f, popRatings[i])}</td>
      <td class="time-ago" title="${f.firstSeen ? new Date(f.firstSeen).toLocaleString() : ""}">${f.firstSeen ? timeAgo(f.firstSeen) : "—"}</td>
      <td style="white-space:nowrap">
        <button class="review-btn shared-review" data-hash="${escapeAttr(f.fileHash || "")}" data-name="${escapeAttr(f.fileName || "")}" data-rating="${escapeAttr(String(f.rating || 0))}" data-comment="${escapeAttr(f.comment || "")}" title="Edit name &amp; review">✏️</button>
        <button class="shared-share" data-link="${escapeAttr(link)}" title="Copy ed2k link">Share</button>
        ${path ? `<button class="shared-del danger" data-path="${escapeAttr(path)}" data-name="${escapeAttr(f.fileName || "")}" title="Delete file">Delete</button>` : ""}
      </td>
    </tr>`;
  }).join("");
}

const sharedSearchInput = $("sharedSearch");
if (sharedSearchInput) {
  sharedSearchInput.addEventListener("input", () => applySharedSortAndRender());
}

if (sharedThead) {
  sharedThead.addEventListener("click", (e) => {
    const th = e.target.closest("th[data-sort]");
    if (!th) return;
    const key = th.dataset.sort;
    if (!key || !SHARED_SORT_DEFAULTS[key]) return;
    if (sharedSort.key === key) {
      sharedSort.dir = sharedSort.dir === "asc" ? "desc" : "asc";
    } else {
      sharedSort.key = key;
      sharedSort.dir = SHARED_SORT_DEFAULTS[key];
    }
    applySharedSortAndRender();
  });
}

sharedBody.addEventListener("click", async (e) => {
  if (await handleSharedPlayClick(e)) return;

  const share = e.target.closest(".shared-share");
  if (share) {
    try {
      await navigator.clipboard.writeText(share.dataset.link);
      const orig = share.textContent;
      share.textContent = "Copied!";
      setTimeout(() => { share.textContent = orig; }, 1500);
    } catch (err) {
      alert("Could not copy link:\n" + err.message);
    }
    return;
  }

  const del = e.target.closest(".shared-del");
  if (del) {
    if (!confirm("Delete this file from disk?")) return;
    try {
      await call("deleteFile", { filePath: del.dataset.path, fileName: del.dataset.name });
      await loadSharedFiles();
    } catch (err) {
      alert("Could not delete file:\n" + err.message);
    }
    return;
  }

  const rev = e.target.closest(".shared-review");
  if (rev) {
    openReviewModal(rev.dataset.hash, rev.dataset.name, Number(rev.dataset.rating) || 0, rev.dataset.comment || "");
  }
});

refreshSharedBtn.addEventListener("click", async () => {
  try {
    await call("refreshSharedFiles");
  } catch (err) {
    alert("Could not reload shared files on aMule:\n" + err.message);
  }
  await loadSharedFiles();
});

// ── Import / Export menu ──

importExportBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  importExportMenu.classList.toggle("hidden");
});

document.addEventListener("click", (e) => {
  if (!importExportMenu.classList.contains("hidden") && !e.target.closest(".menu-wrap")) {
    importExportMenu.classList.add("hidden");
  }
});

/** Briefly show a ✓ on the import/export icon with a summary tooltip. */
function flashImportExportIcon(title) {
  const orig = importExportBtn.textContent;
  const origTitle = importExportBtn.title;
  importExportBtn.textContent = "✓";
  importExportBtn.title = title;
  setTimeout(() => {
    importExportBtn.textContent = orig;
    importExportBtn.title = origTitle;
  }, 2500);
}

menuExportBtn.addEventListener("click", async () => {
  importExportMenu.classList.add("hidden");
  importExportBtn.disabled = true;
  try {
    const res = await call("exportCollection");
    if (res && res.exported) flashImportExportIcon(`Exported ${res.count} file(s)`);
  } catch (err) {
    alert("Could not export collection:\n" + err.message);
  } finally {
    importExportBtn.disabled = !connected;
  }
});

menuImportBtn.addEventListener("click", async () => {
  importExportMenu.classList.add("hidden");
  importExportBtn.disabled = true;
  try {
    const res = await call("importCollection");
    if (res && res.imported) {
      flashImportExportIcon(`Started ${res.added} download(s)`);
      if (res.failed > 0) {
        alert(`${res.added} download(s) started, ${res.failed} link(s) could not be added.`);
      }
      await loadSharedFiles();
    }
  } catch (err) {
    alert("Could not import collection:\n" + err.message);
  } finally {
    importExportBtn.disabled = !connected;
  }
});

// ── Review modal ──

const reviewOverlay = $("reviewOverlay");
const reviewFileName = $("reviewFileName");
const reviewStars = $("reviewStars");
const reviewComment = $("reviewComment");
const reviewSaveBtn = $("reviewSaveBtn");
const reviewCancelBtn = $("reviewCancelBtn");
const reviewClearBtn = $("reviewClearBtn");

let reviewCurrentHash = null;
let reviewCurrentRating = 0;
let reviewOriginalFileName = "";

function setReviewStars(n) {
  reviewCurrentRating = n;
  for (const star of reviewStars.querySelectorAll(".star")) {
    const v = Number(star.dataset.value);
    star.classList.toggle("active", v <= n);
  }
}

function openReviewModal(fileHash, fileName, rating, comment) {
  reviewCurrentHash = fileHash;
  reviewOriginalFileName = fileName || fileHash;
  reviewFileName.value = reviewOriginalFileName;
  reviewComment.value = comment || "";
  setReviewStars(rating || 0);
  reviewOverlay.classList.add("open");
  reviewFileName.focus();
}

if (reviewOverlay) {
  reviewStars.addEventListener("click", (e) => {
    const star = e.target.closest(".star");
    if (!star) return;
    const v = Number(star.dataset.value);
    setReviewStars(reviewCurrentRating === v ? 0 : v);
  });

  reviewStars.addEventListener("mouseover", (e) => {
    const star = e.target.closest(".star");
    if (!star) return;
    const v = Number(star.dataset.value);
    for (const s of reviewStars.querySelectorAll(".star")) {
      s.classList.toggle("hover-active", Number(s.dataset.value) <= v);
    }
  });

  reviewStars.addEventListener("mouseleave", () => {
    for (const s of reviewStars.querySelectorAll(".star")) s.classList.remove("hover-active");
  });

  reviewSaveBtn.addEventListener("click", async () => {
    if (!reviewCurrentHash) return;
    reviewSaveBtn.disabled = true;
    try {
      const newName = reviewFileName.value.trim();
      if (newName && newName !== reviewOriginalFileName) {
        const result = await call("renameFile", { fileHash: reviewCurrentHash, newName });
        if (result && result.success === false) {
          throw new Error(result.error || "Rename failed");
        }
      }
      await call("updateFileReview", {
        fileHash: reviewCurrentHash,
        rating: reviewCurrentRating,
        comment: reviewComment.value,
      });
      reviewOverlay.classList.remove("open");
      await loadSharedFiles();
    } catch (err) {
      alert("Could not save:\n" + err.message);
    } finally {
      reviewSaveBtn.disabled = false;
    }
  });

  reviewClearBtn.addEventListener("click", async () => {
    if (!reviewCurrentHash) return;
    reviewClearBtn.disabled = true;
    try {
      await call("updateFileReview", { fileHash: reviewCurrentHash, rating: 0, comment: "" });
      reviewOverlay.classList.remove("open");
      await loadSharedFiles();
    } catch (err) {
      alert("Could not clear review:\n" + err.message);
    } finally {
      reviewClearBtn.disabled = false;
    }
  });

  reviewCancelBtn.addEventListener("click", () => reviewOverlay.classList.remove("open"));

  reviewOverlay.addEventListener("click", (e) => {
    if (e.target === reviewOverlay) reviewOverlay.classList.remove("open");
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && reviewOverlay.classList.contains("open")) {
      reviewOverlay.classList.remove("open");
    }
  });
}

// ── Search ──

function renderSearchResults(results) {
  searchBody.innerHTML = results.map((r) => {
    const action = actionCell(r, { downloadClass: "sr-dl", requirePath: false });
    return `<tr>
      <td>${action}</td>
      <td>${escapeHtml(displayFileName(r.fileName))}</td>
      <td>${formatBytes(r.fileSize)}</td>
      <td>${r.sourceCount ?? "—"}</td>
    </tr>`;
  }).join("");
}

function reRenderSearchResults() {
  if (lastSearchResults.length > 0) renderSearchResults(lastSearchResults);
}

async function performSearch() {
  const q = searchQuery.value.trim();
  if (!q) return;
  searchBtn.disabled = true;
  searchStatus.textContent = "Searching…";
  searchBody.innerHTML = "";
  lastSearchResults = [];
  try {
    const res = await call("searchAndWaitResults", {
      query: q,
      network: searchNetwork.value,
    });
    const results = res?.results || [];
    lastSearchResults = results;
    searchStatus.textContent = `${results.length} result(s).`;
    renderSearchResults(results);
  } catch (err) {
    searchStatus.textContent = "";
    searchBody.innerHTML = `<tr><td colspan="4" class="error">${escapeHtml(err.message)}</td></tr>`;
  } finally {
    searchBtn.disabled = !connected;
  }
}

if (searchPopularTags) {
  searchPopularTags.addEventListener("click", (e) => {
    const btn = e.target.closest(".search-kw-tag");
    if (!btn || !btn.dataset.word) return;
    searchQuery.value = btn.dataset.word;
    if (!connected) return;
    performSearch();
  });
}

const searchForm = $("searchForm");
if (searchForm) {
  searchForm.addEventListener("submit", (e) => {
    e.preventDefault();
    performSearch();
  });
}

searchBody.addEventListener("click", async (e) => {
  if (await handleSharedPlayClick(e)) return;

  const btn = e.target.closest(".sr-dl");
  if (!btn) return;
  try {
    if (btn.dataset.hash) {
      const ok = await call("downloadSearchResult", { fileHash: btn.dataset.hash, categoryId: 0 });
      if (ok !== true) throw new Error("aMule did not accept the search result download.");
    } else {
      await call("addEd2kLink", { link: btn.dataset.link, categoryId: 0 });
    }
    if (btn.dataset.hash) queuedByHash.set(fileHashKey(btn.dataset.hash), { fileHash: btn.dataset.hash });
    if (btn.dataset.hash) {
      reRenderSearchResults();
    } else {
      btn.textContent = "Added";
      btn.disabled = true;
    }
  } catch (err) {
    alert(err.message);
  }
});

// ── Discoveries ──

const INTERVAL_LABELS = { "1h": "Every hour", "6h": "Every 6 hours", "1d": "Every day", "1w": "Every week" };
const DISCOVERY_PAGE_SIZE = 100;
let discoveryKeywordVisibility = new Map();
let discoveryPage = 1;

function timeAgo(ts) {
  const diff = Date.now() - ts;
  const s = Math.floor(diff / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m ago";
  const h = Math.floor(m / 60);
  if (h < 24) return h + "h ago";
  const d = Math.floor(h / 24);
  return d + "d ago";
}

function syncDiscoveryKeywordVisibility(keywords) {
  const nextVisibility = new Map();
  for (const kw of keywords || []) {
    nextVisibility.set(kw.label, discoveryKeywordVisibility.get(kw.label) !== false);
  }
  discoveryKeywordVisibility = nextVisibility;
}

function renderDiscoveryKeywords(keywords) {
  syncDiscoveryKeywordVisibility(keywords);
  if (!keywords || keywords.length === 0) {
    discKeywords.innerHTML = '<p class="muted">No keywords defined. Add one above.</p>';
    return;
  }
  discKeywords.innerHTML = keywords.map((kw) => `
    <div class="disc-kw-row">
      <label class="disc-kw-toggle-wrap" title="Show results for this keyword">
        <input
          type="checkbox"
          class="disc-kw-toggle"
          data-label="${escapeAttr(kw.label)}"
          ${discoveryKeywordVisibility.get(kw.label) !== false ? "checked" : ""}
        />
      </label>
      <span class="kw-label">${escapeHtml(kw.label)}</span>
      <select class="disc-kw-interval" data-id="${kw.id}">
        ${Object.entries(INTERVAL_LABELS).map(([v, l]) =>
          `<option value="${v}"${v === kw.interval ? " selected" : ""}>${l}</option>`
        ).join("")}
      </select>
      <span class="muted" style="font-size:12px">${kw.lastRun ? "ran " + timeAgo(kw.lastRun) : "never ran"}</span>
      <button class="danger disc-kw-del" data-id="${kw.id}" title="Remove">✕</button>
    </div>
  `).join("");
}

let lastDiscoveryResults = [];

function renderDiscoveryPagination(totalVisible) {
  if (!discPagination) return;
  if (totalVisible === 0) {
    discPagination.style.display = "none";
    return;
  }
  const pageCount = Math.max(1, Math.ceil(totalVisible / DISCOVERY_PAGE_SIZE));
  const start = (discoveryPage - 1) * DISCOVERY_PAGE_SIZE + 1;
  const end = Math.min(start + DISCOVERY_PAGE_SIZE - 1, totalVisible);
  discPagination.style.display = "flex";
  discPrevPage.disabled = discoveryPage <= 1;
  discNextPage.disabled = discoveryPage >= pageCount;
  discPageStatus.textContent = `Showing ${start}-${end} of ${totalVisible} · Page ${discoveryPage} of ${pageCount}`;
}

function renderDiscoveryResults(results, options = {}) {
  lastDiscoveryResults = results || [];
  if (options.resetPage) discoveryPage = 1;
  const query = (discSearchInput?.value || "").trim().toLowerCase();
  const visibleResults = lastDiscoveryResults.filter((r) => {
    if (discoveryKeywordVisibility.get(r.keyword) === false) return false;
    return !query || (r.fileName || "").toLowerCase().includes(query);
  });
  if (visibleResults.length === 0) {
    discBody.innerHTML = "";
    discEmpty.textContent = lastDiscoveryResults.length === 0
      ? "No discoveries yet."
      : query
        ? "No discoveries match the current filter."
        : "No discoveries for the selected keywords.";
    discEmpty.style.display = "block";
    renderDiscoveryPagination(0);
    return;
  }
  discEmpty.style.display = "none";
  const pageCount = Math.max(1, Math.ceil(visibleResults.length / DISCOVERY_PAGE_SIZE));
  discoveryPage = Math.min(Math.max(discoveryPage, 1), pageCount);
  const pageStart = (discoveryPage - 1) * DISCOVERY_PAGE_SIZE;
  const pageResults = visibleResults.slice(pageStart, pageStart + DISCOVERY_PAGE_SIZE);
  renderDiscoveryPagination(visibleResults.length);
  discBody.innerHTML = pageResults.map((r) => {
    const actionTd = actionCell(r, {
      downloadClass: "disc-dl",
      queuedLabel: "Downloading",
      queuedClass: "disc-queued",
    });
    return `<tr>
    <td>${actionTd}</td>
    <td title="${escapeHtml(r.fileHash || "")}">${escapeHtml(displayFileName(r.fileName))}</td>
    <td>${formatBytes(r.fileSize)}</td>
    <td>${r.sourceCount ?? "—"}</td>
    <td title="${escapeHtml(r.keyword)}"><span class="tag">${escapeHtml(r.keyword.length > 8 ? r.keyword.slice(0, 8) + "…" : r.keyword)}</span></td>
    <td class="time-ago" title="${new Date(r.firstSeen).toLocaleString()}">${timeAgo(r.firstSeen)}</td>
  </tr>`;
  }).join("");
}

function reRenderDiscoveryResults() {
  if (lastDiscoveryResults.length > 0) renderDiscoveryResults(lastDiscoveryResults);
}

async function loadDiscoveries() {
  try {
    const data = await call("discoveryGetState");
    renderDiscoveryKeywords(data.keywords);
    renderDiscoveryResults(data.results);
  } catch (err) {
    discLog.textContent = "Error: " + err.message;
  }
}

discAddBtn.addEventListener("click", async () => {
  const label = discKeywordInput.value.trim();
  if (!label) return;
  try {
    const data = await call("discoveryAddKeyword", {
      label,
      interval: discIntervalSelect.value,
    });
    discKeywordInput.value = "";
    renderDiscoveryKeywords(data.keywords);
    renderDiscoveryResults(data.results, { resetPage: true });
  } catch (err) {
    alert(err.message);
  }
});

discKeywords.addEventListener("click", async (e) => {
  const del = e.target.closest(".disc-kw-del");
  if (del) {
    if (!confirm("Remove this keyword and its results?")) return;
    try {
      const data = await call("discoveryRemoveKeyword", { id: del.dataset.id });
      renderDiscoveryKeywords(data.keywords);
      renderDiscoveryResults(data.results, { resetPage: true });
    } catch (err) { alert(err.message); }
    return;
  }
});

discKeywords.addEventListener("change", async (e) => {
  const toggle = e.target.closest(".disc-kw-toggle");
  if (toggle) {
    discoveryKeywordVisibility.set(toggle.dataset.label, toggle.checked);
    renderDiscoveryResults(lastDiscoveryResults, { resetPage: true });
    return;
  }

  const sel = e.target.closest(".disc-kw-interval");
  if (!sel) return;
  try {
    const data = await call("discoveryUpdateKeyword", {
      id: sel.dataset.id,
      interval: sel.value,
    });
    renderDiscoveryKeywords(data.keywords);
  } catch (err) { alert(err.message); }
});

if (discPrevPage) {
  discPrevPage.addEventListener("click", () => {
    if (discoveryPage <= 1) return;
    discoveryPage -= 1;
    renderDiscoveryResults(lastDiscoveryResults);
  });
}

if (discNextPage) {
  discNextPage.addEventListener("click", () => {
    discoveryPage += 1;
    renderDiscoveryResults(lastDiscoveryResults);
  });
}

if (discSearchInput) {
  discSearchInput.addEventListener("input", () => {
    renderDiscoveryResults(lastDiscoveryResults, { resetPage: true });
  });
}

discRunNowBtn.addEventListener("click", async () => {
  try {
    discLog.textContent = "Starting discovery scan…";
    await call("discoveryRunNow");
  } catch (err) {
    discLog.textContent = "Error: " + err.message;
  }
});

discBody.addEventListener("click", async (e) => {
  if (await handleSharedPlayClick(e)) return;

  const btn = e.target.closest(".disc-dl");
  if (!btn) return;
  try {
    await call("addEd2kLink", { link: btn.dataset.link, categoryId: 0 });
    if (btn.dataset.hash) {
      queuedByHash.set(fileHashKey(btn.dataset.hash), { fileHash: btn.dataset.hash });
      reRenderDiscoveryResults();
    } else {
      btn.textContent = "Downloading";
      btn.disabled = true;
    }
  } catch (err) { alert(err.message); }
});

window.amule.onDiscovery((msg) => {
  if (msg.type === "progress") {
    discLog.textContent = `Searched "${msg.keyword}": ${msg.found} result(s), ${msg.new} new.`;
  } else if (msg.type === "error") {
    discLog.textContent = `Error searching "${msg.keyword}": ${msg.error}`;
  } else if (msg.type === "updated") {
    loadDiscoveries();
  }
});

// Load discovery state on startup (keywords persist across sessions)
loadDiscoveries();

// ── Peer Files (persisted; scanned automatically, banned peers skipped) ──

const peerList              = $("peerList");
const peerStats             = $("peerStats");
const peerFilesTitle        = $("peerFilesTitle");
const peerScanIntervalInput = $("peerScanIntervalInput");
const peerRefetchDaysInput  = $("peerRefetchDaysInput");

/** Last view from main: { settings, lastScan, scanning, peers, newFiles }. */
let peerView = { settings: {}, lastScan: 0, scanning: false, peers: [], newFiles: [] };
/** When set, the files table only shows this peer's new files. */
let selectedPeerKey = null;

function peerDisplayName(p) {
  return p.userName || p.peerName || p.ip || p.peerIp || "(unknown peer)";
}

function renderPeerStats() {
  const responders = peerView.peers.filter((p) => !p.banned);
  const banned = peerView.peers.length - responders.length;
  const days = peerView.settings.refetchDays;
  const chips = [
    `<span class="stat-chip"><b>${responders.length}</b> peer(s) with shared lists</span>`,
    `<span class="stat-chip"><b>${peerView.newFiles.length}</b> new file(s) in the last ${days} day(s)</span>`,
    `<span class="stat-chip">Last scan: <b>${peerView.lastScan ? timeAgo(peerView.lastScan) : "never"}</b></span>`,
  ];
  if (banned > 0) chips.push(`<span class="stat-chip"><b>${banned}</b> banned</span>`);
  peerStats.innerHTML = chips.join("");
}

function peerCardHtml(p, selected) {
  const meta1 = [p.ip, p.software].filter(Boolean).join(" · ");
  const meta2 = p.banned
    ? "banned"
    : `${p.fileCount} file(s) · fetched ${p.lastFetch ? timeAgo(p.lastFetch) : "never"}`;
  const badge = !p.banned && p.newCount > 0 ? `<span class="peer-new-badge">+${p.newCount} new</span>` : "";
  const banBtn = p.banned
    ? `<button class="peer-ban-btn peer-unban" data-key="${escapeAttr(p.key)}" title="Unban this peer">Unban</button>`
    : `<button class="peer-ban-btn peer-ban" data-key="${escapeAttr(p.key)}" title="Ban this peer (never scanned again, files hidden)">Ban</button>`;
  return `<div class="peer-card${p.banned ? " banned" : ""}${selected ? " selected" : ""}" data-key="${escapeAttr(p.key)}">
    <div class="peer-card-main">
      <div class="peer-name" title="${escapeAttr(peerDisplayName(p))}">${escapeHtml(peerDisplayName(p))}</div>
      <div class="peer-meta">${escapeHtml(meta1 || "—")}</div>
      <div class="peer-meta">${escapeHtml(meta2)}</div>
    </div>
    ${badge}
    ${banBtn}
  </div>`;
}

function renderPeerList() {
  const active = peerView.peers.filter((p) => !p.banned);
  const banned = peerView.peers.filter((p) => p.banned);
  if (peerView.peers.length === 0) {
    peerList.innerHTML = '<p class="muted" style="font-size:12px">No peers have shared their file list yet. Peers are scanned automatically, or click “Scan Known Peers”.</p>';
    return;
  }
  let html = active.map((p) => peerCardHtml(p, p.key === selectedPeerKey)).join("");
  if (banned.length > 0) {
    html += `<div class="peer-col-title peer-banned-title">Banned</div>`;
    html += banned.map((p) => peerCardHtml(p, false)).join("");
  }
  peerList.innerHTML = html;
}

function renderPeerFiles() {
  const query = (peerSearchInput?.value || "").trim().toLowerCase();
  const selected = selectedPeerKey
    ? peerView.peers.find((p) => p.key === selectedPeerKey && !p.banned)
    : null;
  const list = peerView.newFiles.filter((r) => {
    if (selected && r.peerKey !== selected.key) return false;
    return !query || (r.fileName || "").toLowerCase().includes(query);
  });

  peerFilesTitle.textContent = selected
    ? `New files from ${peerDisplayName(selected)} (last ${peerView.settings.refetchDays} days)`
    : `New files (last ${peerView.settings.refetchDays} days)`;

  if (list.length === 0) {
    peerBody.innerHTML = "";
    peerEmpty.textContent = peerView.newFiles.length === 0
      ? "No new peer files in the current window."
      : "No peer files match the current filter.";
    peerEmpty.style.display = "block";
    return;
  }
  peerEmpty.style.display = "none";
  peerBody.innerHTML = list.map((r) => {
    const actionTd = actionCell(r, {
      downloadClass: "peer-dl",
      queuedLabel: "Downloading",
      queuedClass: "peer-queued",
    });
    const peerLabel = r.peerName || r.peerIp || "?";
    const peerTitle = [r.peerName, r.peerIp && `IP ${r.peerIp}`].filter(Boolean).join(" · ");
    return `<tr>
    <td>${actionTd}</td>
    <td title="${escapeHtml(r.fileHash || "")}">${escapeHtml(displayFileName(r.fileName))}</td>
    <td>${formatBytes(r.fileSize)}</td>
    <td title="${escapeAttr(peerTitle)}"><span class="tag">${escapeHtml(peerLabel.length > 18 ? peerLabel.slice(0, 18) + "…" : peerLabel)}</span></td>
    <td class="time-ago" title="${r.firstSeen ? new Date(r.firstSeen).toLocaleString() : ""}">${r.firstSeen ? timeAgo(r.firstSeen) : "—"}</td>
  </tr>`;
  }).join("");
}

function renderPeerSettings() {
  // Don't clobber a value the user is currently editing.
  if (document.activeElement !== peerScanIntervalInput) {
    peerScanIntervalInput.value = String(peerView.settings.scanIntervalHours ?? 3);
  }
  if (document.activeElement !== peerRefetchDaysInput) {
    peerRefetchDaysInput.value = String(peerView.settings.refetchDays ?? 7);
  }
}

function renderPeers() {
  renderPeerStats();
  renderPeerList();
  renderPeerFiles();
  renderPeerSettings();
}

async function loadPeers() {
  try {
    peerView = await call("peersGetState");
    if (selectedPeerKey && !peerView.peers.some((p) => p.key === selectedPeerKey && !p.banned)) {
      selectedPeerKey = null;
    }
    renderPeers();
  } catch (err) {
    peerStatus.textContent = "Error: " + err.message;
  }
}

async function savePeerSettings() {
  const scanIntervalHours = Number(peerScanIntervalInput.value);
  const refetchDays = Number(peerRefetchDaysInput.value);
  if (!(scanIntervalHours > 0) || !(refetchDays > 0)) return;
  try {
    peerView = await call("peersUpdateSettings", { scanIntervalHours, refetchDays });
    renderPeers();
  } catch (err) {
    alert("Could not save peer settings:\n" + err.message);
  }
}

peerScanIntervalInput.addEventListener("change", savePeerSettings);
peerRefetchDaysInput.addEventListener("change", savePeerSettings);

if (peerScanBtn) {
  peerScanBtn.addEventListener("click", async () => {
    try {
      peerStatus.textContent = "Starting…";
      peerScanBtn.disabled = true;
      await call("peersScanNow");
    } catch (err) {
      peerStatus.textContent = "Error: " + err.message;
      peerScanBtn.disabled = !connected;
    }
  });
}

if (peerSearchInput) {
  peerSearchInput.addEventListener("input", () => renderPeerFiles());
}

peerList.addEventListener("click", async (e) => {
  const ban = e.target.closest(".peer-ban");
  if (ban) {
    const peer = peerView.peers.find((p) => p.key === ban.dataset.key);
    if (!confirm(`Ban ${peer ? peerDisplayName(peer) : "this peer"}?\nIt will never be scanned again and its files will be hidden.`)) return;
    try {
      peerView = await call("peersBan", { key: ban.dataset.key });
      if (selectedPeerKey === ban.dataset.key) selectedPeerKey = null;
      renderPeers();
    } catch (err) { alert(err.message); }
    return;
  }

  const unban = e.target.closest(".peer-unban");
  if (unban) {
    try {
      peerView = await call("peersUnban", { key: unban.dataset.key });
      renderPeers();
    } catch (err) { alert(err.message); }
    return;
  }

  const card = e.target.closest(".peer-card");
  if (card && !card.classList.contains("banned")) {
    selectedPeerKey = selectedPeerKey === card.dataset.key ? null : card.dataset.key;
    renderPeerList();
    renderPeerFiles();
  }
});

if (peerBody) {
  peerBody.addEventListener("click", async (e) => {
    if (await handleSharedPlayClick(e)) return;

    const btn = e.target.closest(".peer-dl");
    if (!btn) return;
    try {
      // Persisted peer files may predate this aMule session, so the hash is
      // often unknown to aMule's search-result pool — the ed2k link always works.
      if (btn.dataset.link) {
        await call("addEd2kLink", { link: btn.dataset.link, categoryId: 0 });
      } else if (btn.dataset.hash) {
        const ok = await call("downloadSearchResult", { fileHash: btn.dataset.hash, categoryId: 0 });
        if (ok !== true) throw new Error("aMule did not accept the download.");
      }
      if (btn.dataset.hash) {
        queuedByHash.set(fileHashKey(btn.dataset.hash), { fileHash: btn.dataset.hash });
        renderPeerFiles();
      } else {
        btn.textContent = "Downloading";
        btn.disabled = true;
      }
    } catch (err) {
      alert(err.message);
    }
  });
}

window.amule.onPeers((msg) => {
  if (msg.type === "started") {
    peerStatus.textContent = msg.total > 0
      ? `Scanning ${msg.total} peer(s)…`
      : "No peers due for scanning.";
    peerScanBtn.disabled = true;
    if (msg.total === 0) peerScanBtn.disabled = !connected;
  } else if (msg.type === "peer") {
    peerStatus.textContent = `Scanned ${msg.index}/${msg.total} — ${msg.name}${msg.newFiles ? ` (+${msg.newFiles} new)` : ""}`;
    if (msg.newFiles) loadPeers();
  } else if (msg.type === "done") {
    peerStatus.textContent = `Scan done (${msg.total} peer(s) queried).`;
    peerScanBtn.disabled = !connected;
    loadPeers();
  } else if (msg.type === "error") {
    peerStatus.textContent = "Error: " + msg.error;
    peerScanBtn.disabled = !connected;
  }
});

// Load persisted peer state on startup.
loadPeers();

// ── Init ──
setConnected(false);
renderSearchPopularKeywords();

(async () => {
  try {
    const saved = await window.amule.getConnectionSettings();
    if (saved) {
      if (saved.host) hostEl.value = saved.host;
      if (saved.port) portEl.value = String(saved.port);
      if (saved.password) passwordEl.value = saved.password;
    }
  } catch (_) { /* no saved settings */ }
  // Always try to connect at startup (silently — the login form stays up on failure).
  await connectWithForm({ silent: true });
})();
