"use strict";

const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { app } = require("electron");

// Discoveries and peer file lists are append-heavy tables of file rows that
// grew past what a rewrite-the-whole-file JSON store can carry: every mutation
// used to reparse and reserialize the entire history, and a crash mid-write
// truncated it. SQLite gives targeted writes and atomic commits instead.
//
// Small whole-object state (connection, collection, playback positions) is
// still plain JSON — it is rewritten rarely and gains nothing from a database.
const DB_FILE = path.join(app.getPath("userData"), "muleteer.db");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS keywords (
  id       TEXT PRIMARY KEY,
  label    TEXT NOT NULL,
  interval TEXT NOT NULL,
  lastRun  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS discovery_files (
  keywordId   TEXT    NOT NULL REFERENCES keywords(id) ON DELETE CASCADE,
  fileHash    TEXT    NOT NULL,
  fileName    TEXT,
  fileSize    INTEGER,
  sourceCount INTEGER NOT NULL DEFAULT 0,
  firstSeen   INTEGER NOT NULL,
  PRIMARY KEY (keywordId, fileHash)
);

CREATE INDEX IF NOT EXISTS idx_discovery_files_seen ON discovery_files(firstSeen DESC);

CREATE TABLE IF NOT EXISTS peers (
  key       TEXT PRIMARY KEY,
  userHash  TEXT,
  userName  TEXT,
  ip        TEXT,
  software  TEXT,
  banned    INTEGER NOT NULL DEFAULT 0,
  firstSeen INTEGER NOT NULL DEFAULT 0,
  lastFetch INTEGER NOT NULL DEFAULT 0,
  lastSeen  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS peer_files (
  peerKey     TEXT    NOT NULL REFERENCES peers(key) ON DELETE CASCADE,
  fileHash    TEXT    NOT NULL,
  fileName    TEXT,
  fileSize    INTEGER,
  sourceCount INTEGER NOT NULL DEFAULT 0,
  firstSeen   INTEGER NOT NULL,
  PRIMARY KEY (peerKey, fileHash)
);

CREATE INDEX IF NOT EXISTS idx_peer_files_seen ON peer_files(firstSeen DESC);
`;

let db = null;
const statements = new Map();

function getDb() {
  if (db) return db;
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  db = new DatabaseSync(DB_FILE);
  // WAL keeps the scheduled scans from blocking reads coming in over IPC;
  // NORMAL is the usual WAL companion (durable across crashes, not power loss).
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
}

/** Prepared statements are cached: scans run the same few inserts thousands of times. */
function prep(sql) {
  let stmt = statements.get(sql);
  if (!stmt) {
    stmt = getDb().prepare(sql);
    statements.set(sql, stmt);
  }
  return stmt;
}

const run = (sql, ...params) => prep(sql).run(...params);
const all = (sql, ...params) => prep(sql).all(...params);
const get = (sql, ...params) => prep(sql).get(...params);

/** Wraps fn in a transaction, so a failed scan leaves no half-written peer. */
function tx(fn) {
  const database = getDb();
  database.exec("BEGIN");
  try {
    const result = fn();
    database.exec("COMMIT");
    return result;
  } catch (err) {
    try { database.exec("ROLLBACK"); } catch (_) { /* already rolled back */ }
    throw err;
  }
}

/** SQLite rejects undefined and booleans as bound values. */
const text = (v) => (v == null ? null : String(v));
const int = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Math.trunc(Number(v)));
const bool = (v) => (v ? 1 : 0);

function getMeta(key, fallback = null) {
  const row = get("SELECT value FROM meta WHERE key = ?", key);
  if (!row) return fallback;
  try {
    return JSON.parse(row.value);
  } catch (_) {
    return fallback;
  }
}

function setMeta(key, value) {
  run(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    key,
    JSON.stringify(value)
  );
}

function close() {
  if (!db) return;
  statements.clear();
  try { db.close(); } catch (_) { /* shutting down anyway */ }
  db = null;
}

module.exports = { DB_FILE, getDb, prep, run, all, get, tx, getMeta, setMeta, close, text, int, bool };
