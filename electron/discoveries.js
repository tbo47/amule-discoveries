"use strict";

const db = require("./db");

const INTERVAL_MS = {
  "1h":  1 * 60 * 60 * 1000,
  "6h":  6 * 60 * 60 * 1000,
  "1d": 24 * 60 * 60 * 1000,
  "1w":  7 * 24 * 60 * 60 * 1000,
};

function getKeywords() {
  return db.all("SELECT id, label, interval, lastRun FROM keywords ORDER BY rowid");
}

/** Kept for the IPC handlers, which read `.keywords` off the returned state. */
function getState() {
  return { keywords: getKeywords() };
}

function addKeyword(label, interval) {
  if (!label || !INTERVAL_MS[interval]) throw new Error("Invalid keyword or interval.");
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  db.run(
    "INSERT INTO keywords (id, label, interval, lastRun) VALUES (?, ?, ?, 0)",
    id, String(label), String(interval)
  );
  return getState();
}

/** The ON DELETE CASCADE takes the keyword's results with it — the JSON store
 *  used to strand them, and orphaned buckets grew to most of the file. */
function removeKeyword(id) {
  db.run("DELETE FROM keywords WHERE id = ?", String(id));
  return getState();
}

function updateKeyword(id, fields) {
  const kw = db.get("SELECT id FROM keywords WHERE id = ?", String(id));
  if (!kw) throw new Error("Keyword not found.");
  if (fields.label !== undefined) {
    db.run("UPDATE keywords SET label = ? WHERE id = ?", db.text(fields.label), String(id));
  }
  if (fields.interval !== undefined && INTERVAL_MS[fields.interval]) {
    db.run("UPDATE keywords SET interval = ? WHERE id = ?", String(fields.interval), String(id));
  }
  return getState();
}

const MERGE_SQL = `
INSERT INTO discovery_files (keywordId, fileHash, fileName, fileSize, sourceCount, firstSeen)
VALUES (?, ?, ?, ?, ?, ?)
ON CONFLICT(keywordId, fileHash) DO UPDATE SET
  fileName    = COALESCE(excluded.fileName, discovery_files.fileName),
  sourceCount = COALESCE(excluded.sourceCount, discovery_files.sourceCount)
`;

/** Returns how many of `searchResults` had not been seen for this keyword before. */
function mergeResults(keywordId, searchResults) {
  const now = Date.now();
  return db.tx(() => {
    const before = db.get(
      "SELECT COUNT(*) AS n FROM discovery_files WHERE keywordId = ?", String(keywordId)
    ).n;
    for (const r of searchResults) {
      if (!r.fileHash) continue;
      db.run(
        MERGE_SQL,
        String(keywordId),
        String(r.fileHash),
        db.text(r.fileName),
        db.int(r.fileSize),
        db.int(r.sourceCount) ?? 0,
        now
      );
    }
    const after = db.get(
      "SELECT COUNT(*) AS n FROM discovery_files WHERE keywordId = ?", String(keywordId)
    ).n;
    return after - before;
  });
}

/** Flat, newest-first list of every discovered file, tagged with its keyword. */
function getAllResults() {
  return db.all(`
    SELECT f.fileHash, f.fileName, f.fileSize, f.sourceCount, f.firstSeen,
           f.keywordId, k.label AS keyword
    FROM discovery_files f
    JOIN keywords k ON k.id = f.keywordId
    ORDER BY f.firstSeen DESC, f.fileName COLLATE NOCASE ASC
  `);
}

let schedulerTimer = null;
let running = false;

function startScheduler(getClient, notifyRenderer) {
  if (schedulerTimer) return;

  const tick = async () => {
    if (running) return;
    const cl = getClient();
    if (!cl) return;

    const now = Date.now();
    const due = getKeywords().filter((kw) => now - kw.lastRun >= INTERVAL_MS[kw.interval]);
    if (due.length === 0) return;

    running = true;
    try {
      for (const kw of due) {
        try {
          const res = await cl.searchAndWaitResults(kw.label, "kad");
          const results = res?.results || [];
          const newCount = mergeResults(kw.id, results);
          // Written per keyword: a crash mid-run no longer loses the searches
          // that already completed, and neither does it re-run them.
          db.run("UPDATE keywords SET lastRun = ? WHERE id = ?", Date.now(), kw.id);
          if (notifyRenderer) {
            notifyRenderer("discovery:progress", {
              keyword: kw.label,
              found: results.length,
              new: newCount,
            });
          }
        } catch (err) {
          if (notifyRenderer) {
            notifyRenderer("discovery:error", {
              keyword: kw.label,
              error: err.message,
            });
          }
        }
      }
      if (notifyRenderer) notifyRenderer("discovery:updated", null);
    } finally {
      running = false;
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

function runNow(getClient, notifyRenderer) {
  db.run("UPDATE keywords SET lastRun = 0");
  stopScheduler();
  startScheduler(getClient, notifyRenderer);
}

module.exports = {
  INTERVAL_MS,
  getState,
  addKeyword,
  removeKeyword,
  updateKeyword,
  mergeResults,
  getAllResults,
  startScheduler,
  stopScheduler,
  runNow,
};
