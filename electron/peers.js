"use strict";

const db = require("./db");

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

let scanning = false;

function getSettings() {
  return { ...DEFAULT_SETTINGS, ...(db.getMeta("peerSettings") || {}) };
}

function getLastScan() {
  return db.getMeta("peerLastScan", 0) || 0;
}

/** Stable identity for a peer across sessions (ecid changes every session). */
function peerKey(c) {
  if (c.userHash) return String(c.userHash);
  if (c.ip) return "ip:" + c.ip;
  return null;
}

// Identity fields only overwrite when the peer actually reported one, so a
// sparse sighting never blanks out what an earlier fetch established.
const UPSERT_PEER_SQL = `
INSERT INTO peers (key, userHash, userName, ip, software, banned, firstSeen, lastSeen, lastFetch)
VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)
ON CONFLICT(key) DO UPDATE SET
  userHash  = COALESCE(excluded.userHash, peers.userHash),
  userName  = COALESCE(excluded.userName, peers.userName),
  ip        = COALESCE(excluded.ip, peers.ip),
  software  = COALESCE(excluded.software, peers.software),
  lastSeen  = excluded.lastSeen,
  lastFetch = CASE WHEN excluded.lastFetch > 0 THEN excluded.lastFetch ELSE peers.lastFetch END
`;

function upsertPeer(key, c, { ts, lastFetch = 0 }) {
  db.run(
    UPSERT_PEER_SQL,
    String(key),
    db.text(c.userHash),
    db.text(c.userName),
    db.text(c.ip),
    db.text(c.softwareVersion || c.software),
    ts,
    ts,
    lastFetch
  );
}

const INSERT_FILE_SQL = `
INSERT INTO peer_files (peerKey, fileHash, fileName, fileSize, sourceCount, firstSeen)
VALUES (?, ?, ?, ?, ?, ?)
ON CONFLICT(peerKey, fileHash) DO UPDATE SET
  fileName    = COALESCE(excluded.fileName, peer_files.fileName),
  sourceCount = COALESCE(excluded.sourceCount, peer_files.sourceCount)
`;

function updateSettings(fields) {
  const settings = getSettings();
  if (fields.scanIntervalHours != null) {
    const n = Number(fields.scanIntervalHours);
    if (!Number.isFinite(n) || n <= 0) throw new Error("Invalid scan interval.");
    settings.scanIntervalHours = n;
  }
  if (fields.refetchDays != null) {
    const n = Number(fields.refetchDays);
    if (!Number.isFinite(n) || n <= 0) throw new Error("Invalid refetch interval.");
    settings.refetchDays = n;
  }
  db.setMeta("peerSettings", settings);
  return settings;
}

function setBanned(key, banned) {
  const peer = db.get("SELECT key FROM peers WHERE key = ?", String(key));
  if (!peer) throw new Error("Peer not found.");
  db.run("UPDATE peers SET banned = ? WHERE key = ?", db.bool(banned), String(key));
  return getView();
}

/**
 * Renderer-facing view: peer summaries plus the flat list of files first seen
 * within the "new files" window (settings.refetchDays), newest first.
 */
function getView() {
  const settings = getSettings();
  const since = Date.now() - settings.refetchDays * DAY_MS;

  const peers = db.all(`
    SELECT p.key, p.userName, p.ip, p.software, p.banned,
           p.firstSeen, p.lastFetch, p.lastSeen,
           (SELECT COUNT(*) FROM peer_files f WHERE f.peerKey = p.key) AS fileCount,
           CASE WHEN p.banned = 1 THEN 0 ELSE
             (SELECT COUNT(*) FROM peer_files f WHERE f.peerKey = p.key AND f.firstSeen >= ?)
           END AS newCount
    FROM peers p
    ORDER BY p.banned ASC, newCount DESC, p.lastFetch DESC
  `, since).map((p) => ({
    ...p,
    userName: p.userName || "",
    ip: p.ip || "",
    software: p.software || "",
    banned: !!p.banned,
  }));

  const newFiles = db.all(`
    SELECT f.fileHash, f.fileName, f.fileSize, f.sourceCount, f.firstSeen,
           f.peerKey, p.userName AS peerName, p.ip AS peerIp
    FROM peer_files f
    JOIN peers p ON p.key = f.peerKey
    WHERE p.banned = 0 AND f.firstSeen >= ?
    ORDER BY f.firstSeen DESC, f.fileName COLLATE NOCASE ASC
  `, since).map((f) => ({ ...f, peerName: f.peerName || "", peerIp: f.peerIp || "" }));

  return { settings, lastScan: getLastScan(), scanning, peers, newFiles };
}

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
    const now = Date.now();
    const refetchMs = getSettings().refetchDays * DAY_MS;

    const update = await cl.getUpdate();
    const clients = (update.clients || []).filter((c) => Number.isInteger(c.ecid));

    const targets = [];
    db.tx(() => {
      for (const c of clients) {
        const key = peerKey(c);
        const known = key
          ? db.get("SELECT banned, lastFetch FROM peers WHERE key = ?", String(key))
          : null;
        if (known) {
          upsertPeer(key, c, { ts: now });
          if (known.banned) continue;
          if (!force && known.lastFetch && now - known.lastFetch < refetchMs) continue;
        }
        targets.push({ c, key });
      }
    });
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

      // Re-read the ban flag each iteration so a ban applied mid-scan is honored.
      const row = key ? db.get("SELECT banned FROM peers WHERE key = ?", String(key)) : null;
      if (row?.banned) continue;

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
      if (key && (fresh.length > 0 || row)) {
        const ts = Date.now();
        db.tx(() => {
          upsertPeer(key, c, { ts, lastFetch: error ? 0 : ts });
          for (const r of fresh) {
            db.run(
              INSERT_FILE_SQL,
              String(key),
              String(r.fileHash),
              db.text(r.fileName),
              db.int(r.fileSize),
              db.int(r.sourceCount) ?? 0,
              ts
            );
          }
        });
      }

      notifyRenderer("peers:peer", {
        index: i + 1,
        total: targets.length,
        name: c.userName || c.ip || "#" + c.ecid,
        newFiles: fresh.length,
        error,
      });
    }

    db.setMeta("peerLastScan", Date.now());
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
    const intervalMs = getSettings().scanIntervalHours * HOUR_MS;
    if (Date.now() - getLastScan() >= intervalMs) {
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
  getSettings,
  getView,
  updateSettings,
  setBanned,
  scan,
  startScheduler,
  stopScheduler,
};
