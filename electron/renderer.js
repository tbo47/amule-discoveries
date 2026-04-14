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

const searchQuery   = $("searchQuery");
const searchNetwork = $("searchNetwork");
const searchBtn     = $("searchBtn");
const searchBody    = $("searchBody");
const searchStatus  = $("searchStatus");
const searchPopularTags = $("searchPopularTags");

let connected = false;
let sharedByHash = new Map();

/** Last fetched My Collection rows (server order); sorting is applied in the UI only. */
let sharedListCache = [];
/** @type {{ key: "name"|"size"|"popularity"|"added"|"rating", dir: "asc"|"desc" }} */
let sharedSort = { key: "added", dir: "desc" };
const SHARED_SORT_DEFAULTS = { name: "asc", size: "desc", popularity: "desc", added: "desc", rating: "desc" };

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

function ed2kUrl(r) {
  return `ed2k://|file|${encodeURIComponent(r.fileName || "unknown")}|${r.fileSize || 0}|${r.fileHash}|/`;
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

  const actionBtns = [addLinkBtn, refreshSharedBtn, searchBtn, discRunNowBtn];
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
tabBar.addEventListener("click", (e) => {
  const tab = e.target.closest(".tab");
  if (!tab) return;
  for (const t of tabBar.children) t.classList.remove("active");
  tab.classList.add("active");
  for (const p of document.querySelectorAll(".panel")) p.classList.remove("active");
  $("panel-" + tab.dataset.tab).classList.add("active");
});

// ── Connect / Disconnect ──

const loginForm = $("loginForm");

loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
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
    alert("Connection failed:\n" + err.message);
    setConnected(false);
  } finally {
    connectBtn.textContent = "Connect";
    if (!connected) connectBtn.disabled = false;
  }
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
      case "rating":
        c = (Number(a.rating) || 0) - (Number(b.rating) || 0);
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
    const list = await call("getSharedFiles");
    sharedListCache = list || [];
    sharedByHash = new Map();
    for (const f of sharedListCache) {
      if (f.fileHash) sharedByHash.set(f.fileHash, f);
    }
    applySharedSortAndRender();
    reRenderDiscoveryResults();
    renderSearchPopularKeywords();
  } catch (err) {
    sharedListCache = [];
    sharedBody.innerHTML = `<tr><td colspan="7" class="error">${escapeHtml(err.message)}</td></tr>`;
    updateSharedHeaderSortIndicators();
    renderSearchPopularKeywords();
  }
}

function reviewCell(f) {
  const r = Number(f.rating) || 0;
  const stars = r > 0 ? `<span class="review-stars">${"★".repeat(r)}${"☆".repeat(5 - r)}</span>` : `<span class="review-stars empty">☆☆☆☆☆</span>`;
  const commentIcon = f.comment ? ` <span class="review-comment-icon" title="${escapeAttr(f.comment)}">💬</span>` : "";
  return `<span class="review-cell">${stars}${commentIcon}</span>`;
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
      <td>${path ? `<button class="shared-play" data-path="${escapeAttr(path)}" data-name="${escapeAttr(f.fileName || "")}" title="Open file">▶ Play</button>` : "—"}</td>
      <td title="${escapeHtml(path)}">${escapeHtml(f.fileName || "?")}</td>
      <td>${formatBytes(f.fileSize)}</td>
      <td class="muted" style="white-space:nowrap;letter-spacing:1px">${popularityCell(f, popRatings[i])}</td>
      <td class="time-ago" title="${f.firstSeen ? new Date(f.firstSeen).toLocaleString() : ""}">${f.firstSeen ? timeAgo(f.firstSeen) : "—"}</td>
      <td>${reviewCell(f)} <button class="review-btn shared-review" data-hash="${escapeAttr(f.fileHash || "")}" data-name="${escapeAttr(f.fileName || "")}" data-rating="${escapeAttr(String(f.rating || 0))}" data-comment="${escapeAttr(f.comment || "")}" title="Add/edit comment &amp; rating">✏️</button></td>
      <td style="white-space:nowrap">
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
  const play = e.target.closest(".shared-play");
  if (play) {
    try {
      await call("openFile", { filePath: play.dataset.path, fileName: play.dataset.name });
    } catch (err) {
      alert("Could not open file:\n" + err.message);
    }
    return;
  }

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

function setReviewStars(n) {
  reviewCurrentRating = n;
  for (const star of reviewStars.querySelectorAll(".star")) {
    const v = Number(star.dataset.value);
    star.classList.toggle("active", v <= n);
  }
}

function openReviewModal(fileHash, fileName, rating, comment) {
  reviewCurrentHash = fileHash;
  reviewFileName.textContent = fileName || fileHash;
  reviewComment.value = comment || "";
  setReviewStars(rating || 0);
  reviewOverlay.classList.add("open");
  reviewComment.focus();
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
      await call("updateFileReview", {
        fileHash: reviewCurrentHash,
        rating: reviewCurrentRating,
        comment: reviewComment.value,
      });
      reviewOverlay.classList.remove("open");
      await loadSharedFiles();
    } catch (err) {
      alert("Could not save review:\n" + err.message);
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
}

// ── Search ──

async function performSearch() {
  const q = searchQuery.value.trim();
  if (!q) return;
  searchBtn.disabled = true;
  searchStatus.textContent = "Searching…";
  searchBody.innerHTML = "";
  try {
    const res = await call("searchAndWaitResults", {
      query: q,
      network: searchNetwork.value,
    });
    const results = res?.results || [];
    searchStatus.textContent = `${results.length} result(s).`;
    searchBody.innerHTML = results.map((r) => `<tr>
      <td><button class="sr-dl" data-link="${escapeAttr(r.ed2kLink || ed2kUrl(r))}">Download</button></td>
      <td>${escapeHtml(r.fileName || "?")}</td>
      <td>${formatBytes(r.fileSize)}</td>
      <td>${r.sourceCount ?? "—"}</td>
    </tr>`).join("");
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
  const btn = e.target.closest(".sr-dl");
  if (!btn) return;
  try {
    await call("addEd2kLink", { link: btn.dataset.link, categoryId: 0 });
    btn.textContent = "Added";
    btn.disabled = true;
  } catch (err) {
    alert(err.message);
  }
});

// ── Discoveries ──

const INTERVAL_LABELS = { "1h": "Every hour", "6h": "Every 6 hours", "1d": "Every day", "1w": "Every week" };
let discoveryKeywordVisibility = new Map();

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

function renderDiscoveryResults(results) {
  lastDiscoveryResults = results || [];
  const visibleResults = lastDiscoveryResults.filter((r) => discoveryKeywordVisibility.get(r.keyword) !== false);
  if (visibleResults.length === 0) {
    discBody.innerHTML = "";
    discEmpty.textContent = lastDiscoveryResults.length === 0
      ? "No discoveries yet."
      : "No discoveries for the selected keywords.";
    discEmpty.style.display = "block";
    return;
  }
  discEmpty.style.display = "none";
  discBody.innerHTML = visibleResults.map((r) => {
    const shared = sharedByHash.get(r.fileHash);
    let actionTd;
    if (shared && shared.path) {
      actionTd = `<button class="shared-play" data-path="${escapeAttr(shared.path)}" data-name="${escapeAttr(shared.fileName || "")}" title="Open file">▶ Play</button>`;
    } else {
      actionTd = `<button class="disc-dl" data-link="${escapeAttr(ed2kUrl(r))}">Download</button>`;
    }
    return `<tr>
    <td>${actionTd}</td>
    <td title="${escapeHtml(r.fileHash || "")}">${escapeHtml(r.fileName || "?")}</td>
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
    renderDiscoveryResults(data.results);
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
      renderDiscoveryResults(data.results);
    } catch (err) { alert(err.message); }
    return;
  }
});

discKeywords.addEventListener("change", async (e) => {
  const toggle = e.target.closest(".disc-kw-toggle");
  if (toggle) {
    discoveryKeywordVisibility.set(toggle.dataset.label, toggle.checked);
    renderDiscoveryResults(lastDiscoveryResults);
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

discRunNowBtn.addEventListener("click", async () => {
  try {
    discLog.textContent = "Starting discovery scan…";
    await call("discoveryRunNow");
  } catch (err) {
    discLog.textContent = "Error: " + err.message;
  }
});

discBody.addEventListener("click", async (e) => {
  const play = e.target.closest(".shared-play");
  if (play) {
    try {
      await call("openFile", { filePath: play.dataset.path, fileName: play.dataset.name });
    } catch (err) {
      alert("Could not open file:\n" + err.message);
    }
    return;
  }

  const btn = e.target.closest(".disc-dl");
  if (!btn) return;
  try {
    await call("addEd2kLink", { link: btn.dataset.link, categoryId: 0 });
    btn.textContent = "Added";
    btn.disabled = true;
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
})();
