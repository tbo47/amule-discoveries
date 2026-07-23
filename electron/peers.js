"use strict";

const fs = require("fs");
const path = require("path");
const { app } = require("electron");

const DATA_FILE = path.join(app.getPath("userData"), "peers.json");

/** Both are user-configurable from the UI. */
const DEFAULT_SETTINGS = {
  scanIntervalHours: 3, // how often we look for known peers and query them
  refetchDays: 7,       // how often a responding peer is re-fetched; also the "new files" window
};

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// Per-peer query tuning: wait up to FETCH_TIMEOUT_MS for an answer, and once
// results start arriving keep collecting until the list has stopped growing
// for FETCH_SETTLE_MS (peers with long lists deliver them incrementally).
const FETCH_TIMEOUT_MS = 60_000;
const FETCH_INTERVAL_MS = 1_000;
const FETCH_SETTLE_MS = 5_000;

function load() {
  let state;
  try {
    state = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch (_) {
    state = {};
  }
  state.settings = { ...DEFAULT_SETTINGS, ...(state.settings || {}) };
  if (!state.peers) state.peers = {};
  if (!state.lastScan) state.lastScan = 0;
  return state;
}

function save(state) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2));
}

/** Stable identity for a peer across sessions (ecid changes every session). */
function peerKey(c) {
  if (c.userHash) return String(c.userHash);
  if (c.ip) return "ip:" + c.ip;
  return null;
}

function updateIdentity(peer, c) {
  if (c.userHash) peer.userHash = String(c.userHash);
  if (c.userName) peer.userName = c.userName;
  if (c.ip) peer.ip = c.ip;
  const soft = c.softwareVersion || c.software;
  if (soft) peer.software = String(soft);
}

function updateSettings(fields) {
  const state = load();
  if (fields.scanIntervalHours != null) {
    const n = Number(fields.scanIntervalHours);
    if (!Number.isFinite(n) || n <= 0) throw new Error("Invalid scan interval.");
    state.settings.scanIntervalHours = n;
  }
  if (fields.refetchDays != null) {
    const n = Number(fields.refetchDays);
    if (!Number.isFinite(n) || n <= 0) throw new Error("Invalid refetch interval.");
    state.settings.refetchDays = n;
  }
  save(state);
  return state.settings;
}

function setBanned(key, banned) {
  const state = load();
  const peer = state.peers[key];
  if (!peer) throw new Error("Peer not found.");
  peer.banned = !!banned;
  save(state);
  return state;
}

/**
 * Renderer-facing view: peer summaries plus the flat list of files first seen
 * within the "new files" window (settings.refetchDays), newest first.
 */
function getView(state = load()) {
  const now = Date.now();
  const newWindowMs = state.settings.refetchDays * DAY_MS;
  const peers = [];
  const newFiles = [];

  for (const p of Object.values(state.peers)) {
    const files = Object.values(p.files || {});
    const fresh = files.filter((f) => now - f.firstSeen <= newWindowMs);
    peers.push({
      key: p.key,
      userName: p.userName || "",
      ip: p.ip || "",
      software: p.software || "",
      banned: !!p.banned,
      firstSeen: p.firstSeen || 0,
      lastFetch: p.lastFetch || 0,
      lastSeen: p.lastSeen || 0,
      fileCount: files.length,
      newCount: p.banned ? 0 : fresh.length,
    });
    if (!p.banned) {
      for (const f of fresh) {
        newFiles.push({ ...f, peerKey: p.key, peerName: p.userName || "", peerIp: p.ip || "" });
      }
    }
  }

  peers.sort((a, b) =>
    (a.banned - b.banned) || (b.newCount - a.newCount) || (b.lastFetch - a.lastFetch)
  );
  newFiles.sort((a, b) => b.firstSeen - a.firstSeen || (a.fileName || "").localeCompare(b.fileName || ""));

  return { settings: state.settings, lastScan: state.lastScan, scanning, peers, newFiles };
}

let scanning = false;

/**
 * Query every currently-known client (download sources, upload/queue peers,
 * friends) for its shared file list over ed2k. aMule delivers each peer's
 * answer into the shared search-result pool without tagging it by peer, so we
 * snapshot the existing result hashes first and attribute only the *newly
 * appeared* files to the peer we just queried.
 *
 * Peers that respond with files are persisted; they are only re-fetched after
 * settings.refetchDays (unless force). Banned peers are never queried.
 */
async function scan(getClient, notifyRenderer, { force = false } = {}) {
  const cl = getClient();
  if (!cl || scanning) return;
  scanning = true;

  try {
    const state = load();
    const now = Date.now();
    const refetchMs = state.settings.refetchDays * DAY_MS;

    const update = await cl.getUpdate();
    const clients = (update.clients || []).filter((c) => Number.isInteger(c.ecid));

    const targets = [];
    for (const c of clients) {
      const key = peerKey(c);
      const known = key ? state.peers[key] : null;
      if (known) {
        known.lastSeen = now;
        updateIdentity(known, c);
        if (known.banned) continue;
        if (!force && known.lastFetch && now - known.lastFetch < refetchMs) continue;
      }
      targets.push({ c, key });
    }
    save(state);
    notifyRenderer("peers:started", { total: targets.length, known: clients.length });

    // Snapshot existing search-result hashes so already-present files are not
    // mis-attributed to the first peer we query.
    const seen = new Set();
    try {
      const initial = await cl.getSearchResults();
      for (const r of initial.results || []) if (r.fileHash) seen.add(r.fileHash);
    } catch (_) { /* ignore */ }

    for (let i = 0; i < targets.length; i++) {
      const { c, key } = targets[i];

      // Reload state each iteration so a ban applied mid-scan is honored
      // and never clobbered by a stale in-memory copy.
      const st = load();
      if (key && st.peers[key]?.banned) continue;

      let fresh = [];
      let error = null;
      try {
        const res = await cl.getClientSharedFiles(c.ecid, {
          timeoutMs: FETCH_TIMEOUT_MS,
          intervalMs: FETCH_INTERVAL_MS,
          settleMs: FETCH_SETTLE_MS,
        });
        fresh = (res.results || []).filter((r) => r.fileHash && !seen.has(r.fileHash));
        for (const r of fresh) seen.add(r.fileHash);
      } catch (err) {
        error = err?.message || String(err);
      }

      // Persist responders (and refresh lastFetch on known ones even when
      // nothing new was attributed, so they are not re-queried every scan).
      // A failed query leaves lastFetch untouched so the peer is retried.
      if (key && (fresh.length > 0 || st.peers[key])) {
        const ts = Date.now();
        const peer = st.peers[key] || { key, firstSeen: ts, files: {} };
        updateIdentity(peer, c);
        peer.lastSeen = ts;
        if (!error) peer.lastFetch = ts;
        if (!peer.files) peer.files = {};
        for (const r of fresh) {
          const existing = peer.files[r.fileHash];
          if (existing) {
            if (r.fileName) existing.fileName = r.fileName;
            if (r.sourceCount != null) existing.sourceCount = r.sourceCount;
          } else {
            peer.files[r.fileHash] = {
              fileHash: r.fileHash,
              fileName: r.fileName,
              fileSize: r.fileSize,
              sourceCount: r.sourceCount || 0,
              firstSeen: ts,
            };
          }
        }
        st.peers[key] = peer;
        save(st);
      }

      notifyRenderer("peers:peer", {
        index: i + 1,
        total: targets.length,
        name: c.userName || c.ip || "#" + c.ecid,
        newFiles: fresh.length,
        error,
      });
    }

    const finalState = load();
    finalState.lastScan = Date.now();
    save(finalState);
    notifyRenderer("peers:done", { total: targets.length });
  } catch (err) {
    notifyRenderer("peers:error", { error: err?.message || String(err) });
  } finally {
    scanning = false;
  }
}

let schedulerTimer = null;

function startScheduler(getClient, notifyRenderer) {
  if (schedulerTimer) return;
  const tick = () => {
    if (scanning) return;
    const state = load();
    const intervalMs = state.settings.scanIntervalHours * HOUR_MS;
    if (Date.now() - state.lastScan >= intervalMs) {
      scan(getClient, notifyRenderer).catch(() => { /* reported via peers:error */ });
    }
  };
  schedulerTimer = setInterval(tick, 60_000);
  tick();
}

function stopScheduler() {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
}

module.exports = {
  DEFAULT_SETTINGS,
  load,
  save,
  getView,
  updateSettings,
  setBanned,
  scan,
  startScheduler,
  stopScheduler,
};
