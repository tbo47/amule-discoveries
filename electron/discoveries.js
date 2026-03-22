"use strict";

const fs = require("fs");
const path = require("path");
const { app } = require("electron");

const INTERVAL_MS = {
  "1h":  1 * 60 * 60 * 1000,
  "6h":  6 * 60 * 60 * 1000,
  "1d": 24 * 60 * 60 * 1000,
  "1w":  7 * 24 * 60 * 60 * 1000,
};

const DATA_FILE = path.join(app.getPath("userData"), "discoveries.json");

function load() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch (_) {
    return { keywords: [], results: {} };
  }
}

function save(state) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2));
}

function getState() {
  return load();
}

function addKeyword(label, interval) {
  if (!label || !INTERVAL_MS[interval]) throw new Error("Invalid keyword or interval.");
  const state = load();
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  state.keywords.push({ id, label, interval, lastRun: 0 });
  save(state);
  return state;
}

function removeKeyword(id) {
  const state = load();
  state.keywords = state.keywords.filter((k) => k.id !== id);
  save(state);
  return state;
}

function updateKeyword(id, fields) {
  const state = load();
  const kw = state.keywords.find((k) => k.id === id);
  if (!kw) throw new Error("Keyword not found.");
  if (fields.label !== undefined) kw.label = fields.label;
  if (fields.interval !== undefined && INTERVAL_MS[fields.interval]) kw.interval = fields.interval;
  save(state);
  return state;
}

function mergeResults(state, keywordId, searchResults) {
  if (!state.results[keywordId]) state.results[keywordId] = {};
  const bucket = state.results[keywordId];
  const now = Date.now();
  let newCount = 0;

  for (const r of searchResults) {
    const hash = r.fileHash;
    if (!hash) continue;
    if (!bucket[hash]) {
      bucket[hash] = {
        fileHash: hash,
        fileName: r.fileName,
        fileSize: r.fileSize,
        sourceCount: r.sourceCount || 0,
        firstSeen: now,
      };
      newCount++;
    } else {
      if (r.sourceCount != null) bucket[hash].sourceCount = r.sourceCount;
      if (r.fileName) bucket[hash].fileName = r.fileName;
    }
  }
  return newCount;
}

function getAllResults(state) {
  const all = [];
  for (const kwId of Object.keys(state.results)) {
    const kw = state.keywords.find((k) => k.id === kwId);
    const kwLabel = kw ? kw.label : "(deleted)";
    for (const r of Object.values(state.results[kwId])) {
      all.push({ ...r, keywordId: kwId, keyword: kwLabel });
    }
  }
  all.sort((a, b) => b.firstSeen - a.firstSeen || (a.fileName || "").localeCompare(b.fileName || ""));
  return all;
}

let schedulerTimer = null;
let running = false;

function startScheduler(getClient, notifyRenderer) {
  if (schedulerTimer) return;

  const tick = async () => {
    if (running) return;
    const cl = getClient();
    if (!cl) return;

    const state = load();
    const now = Date.now();
    const due = state.keywords.filter(
      (kw) => now - kw.lastRun >= INTERVAL_MS[kw.interval]
    );
    if (due.length === 0) return;

    running = true;
    try {
      for (const kw of due) {
        try {
          const res = await cl.searchAndWaitResults(kw.label, "kad");
          const results = res?.results || [];
          const newCount = mergeResults(state, kw.id, results);
          kw.lastRun = Date.now();
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
      save(state);
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
  const state = load();
  for (const kw of state.keywords) kw.lastRun = 0;
  save(state);
  stopScheduler();
  startScheduler(getClient, notifyRenderer);
}

module.exports = {
  INTERVAL_MS,
  getState,
  addKeyword,
  removeKeyword,
  updateKeyword,
  getAllResults,
  startScheduler,
  stopScheduler,
  runNow,
  load,
  save,
};
