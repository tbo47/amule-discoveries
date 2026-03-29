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

let connected = false;
let sharedByHash = new Map();

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

async function loadSharedFiles() {
  try {
    const list = await call("getSharedFiles");
    sharedByHash = new Map();
    for (const f of (list || [])) {
      if (f.fileHash) sharedByHash.set(f.fileHash, f);
    }
    renderSharedFiles(list);
    reRenderDiscoveryResults();
  } catch (err) {
    sharedBody.innerHTML = `<tr><td colspan="5" class="error">${escapeHtml(err.message)}</td></tr>`;
  }
}

function renderSharedFiles(list) {
  if (!list || list.length === 0) {
    sharedBody.innerHTML = "";
    sharedEmpty.style.display = "block";
    return;
  }
  sharedEmpty.style.display = "none";
  sharedBody.innerHTML = list.map((f) => {
    const path = f.path || "";
    const link = f.ed2kLink || ed2kUrl(f);
    return `<tr>
      <td>${path ? `<button class="shared-play" data-path="${escapeAttr(path)}" data-name="${escapeAttr(f.fileName || "")}" title="Open file">▶ Play</button>` : "—"}</td>
      <td title="${escapeHtml(path)}">${escapeHtml(f.fileName || "?")}</td>
      <td>${formatBytes(f.fileSize)}</td>
      <td class="time-ago" title="${f.firstSeen ? new Date(f.firstSeen).toLocaleString() : ""}">${f.firstSeen ? timeAgo(f.firstSeen) : "—"}</td>
      <td style="white-space:nowrap">
        <button class="shared-share" data-link="${escapeAttr(link)}" title="Copy ed2k link">Share</button>
        ${path ? `<button class="shared-del danger" data-path="${escapeAttr(path)}" data-name="${escapeAttr(f.fileName || "")}" title="Delete file">Delete</button>` : ""}
      </td>
    </tr>`;
  }).join("");
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
  }
});

refreshSharedBtn.addEventListener("click", loadSharedFiles);

// ── Search ──

searchBtn.addEventListener("click", async () => {
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
});

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

function renderDiscoveryKeywords(keywords) {
  if (!keywords || keywords.length === 0) {
    discKeywords.innerHTML = '<p class="muted">No keywords defined. Add one above.</p>';
    return;
  }
  discKeywords.innerHTML = keywords.map((kw) => `
    <div class="disc-kw-row">
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
  if (lastDiscoveryResults.length === 0) {
    discBody.innerHTML = "";
    discEmpty.style.display = "block";
    return;
  }
  discEmpty.style.display = "none";
  discBody.innerHTML = lastDiscoveryResults.map((r) => {
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
