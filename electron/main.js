"use strict";

const path = require("path");
const { app, BrowserWindow, ipcMain, shell, dialog } = require("electron");
const { execFile } = require("child_process");
const fs = require("fs");
const AmuleClient = require("../AmuleClient");
const discoveries = require("./discoveries");
const peers = require("./peers");
const media = require("./media");

// Has to happen before the app is ready, hence the top-level call.
media.registerScheme();

let mainWindow = null;
let client = null;

const SETTINGS_FILE = path.join(app.getPath("userData"), "connection.json");
const COLLECTION_FILE = path.join(app.getPath("userData"), "collection.json");

function loadConnectionSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
  } catch (_) {
    return null;
  }
}

function saveConnectionSettings(host, port, password) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ host, port, password }), "utf8");
}

function loadCollection() {
  try {
    return JSON.parse(fs.readFileSync(COLLECTION_FILE, "utf8"));
  } catch (_) {
    return {};
  }
}

/** Return the firstSeen timestamp from a collection entry (handles both old number format and new object format). */
function entryFirstSeen(val, now) {
  if (typeof val === "number") return val;
  if (val && typeof val === "object" && val.firstSeen) return val.firstSeen;
  return now;
}

function mergeCollection(sharedFiles) {
  const persisted = loadCollection();
  if (!sharedFiles || sharedFiles.length === 0) {
    return persisted;
  }

  const now = Date.now();

  for (const f of sharedFiles) {
    if (f.fileHash && persisted[f.fileHash] == null) persisted[f.fileHash] = now;
  }

  fs.writeFileSync(COLLECTION_FILE, JSON.stringify(persisted), "utf8");
  return persisted;
}

function notifyRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function createWindow() {
  const { width, height } = require("electron").screen.getPrimaryDisplay().workAreaSize;
  mainWindow = new BrowserWindow({
    width,
    height,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "index.html"));
}

function ipc(channel, fn) {
  ipcMain.handle(channel, async (_event, arg) => {
    try {
      const data = await fn(arg);
      return { ok: true, data };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  });
}

ipc("amule:connect", async ({ host, port, password }) => {
  if (client) {
    try { client.close(); } catch (_) { /* ignore */ }
    client = null;
  }

  const safeHost = String(host || "").trim() || "127.0.0.1";
  const safePort = validPort(port) ? Number(port) : 4712;

  client = new AmuleClient(safeHost, safePort, password || "");
  await client.connect();

  saveConnectionSettings(safeHost, safePort, password || "");
  discoveries.startScheduler(() => client, notifyRenderer);
  peers.startScheduler(() => client, notifyRenderer);

  return { host: safeHost, port: safePort };
});

ipc("amule:disconnect", async () => {
  discoveries.stopScheduler();
  peers.stopScheduler();
  if (client) {
    try { client.close(); } catch (_) { /* ignore */ }
    client = null;
  }
  return true;
});

ipc("amule:getStats", async () => {
  requireClient();
  return client.getStats();
});

ipc("amule:getDownloadQueue", async () => {
  requireClient();
  return client.getDownloadQueue();
});

async function getCollectionFiles() {
  const files = await client.getSharedFiles();
  const downloadQueue = await client.getDownloadQueue();
  const filesWithoutDownloadQueue = files.filter(f => !downloadQueue.some(d => d.fileHash === f.fileHash));
  const collection = mergeCollection(filesWithoutDownloadQueue);
  for (const f of filesWithoutDownloadQueue) {
    f.firstSeen = entryFirstSeen(collection[f.fileHash], Date.now());
    f.rating = f.rating ?? 0;
    f.comment = f.comment ?? "";
  }
  filesWithoutDownloadQueue.sort((a, b) => b.firstSeen - a.firstSeen || (a.fileName || "").localeCompare(b.fileName || ""));
  return filesWithoutDownloadQueue;
}

ipc("amule:getSharedFiles", async () => {
  requireClient();
  return getCollectionFiles();
});

function ed2kLinkFor(f) {
  const link = f.ed2kLink;
  if (!link) {
    if (!f.fileHash) return "";
    return `ed2k://|file|${encodeURIComponent(f.fileName || "unknown")}|${f.fileSize || 0}|${f.fileHash}|/`;
  }
  // Drop any |sources,...| segment so exported links carry only name/size/hash.
  const bare = link.replace(/\|sources,[^|]*\|\/?/gi, "");
  return bare.endsWith("|/") ? bare : `${bare}|/`;
}

function collectionToText(files) {
  return files
    .map((f) => ed2kLinkFor(f))
    .filter(Boolean)
    .join("\n") + "\n";
}

/**
 * `hashes` is the selection the renderer is displaying (filter applied there,
 * on the Mojibake-repaired names). Absent, everything is exported.
 */
ipc("amule:exportCollection", async ({ query, hashes } = {}) => {
  requireClient();
  let files = await getCollectionFiles();
  const q = (query || "").trim().toLowerCase();
  if (Array.isArray(hashes)) {
    const byHash = new Map(files.filter((f) => f.fileHash).map((f) => [String(f.fileHash).toLowerCase(), f]));
    files = hashes.map((h) => byHash.get(String(h || "").toLowerCase())).filter(Boolean);
  }
  if (files.length === 0) {
    throw new Error(q ? "No files match the current filter, nothing to export." : "Collection is empty, nothing to export.");
  }

  const date = new Date().toISOString().slice(0, 10);
  const filterSlug = q ? "-" + q.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "") : "";
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: "Export My Collection",
    defaultPath: path.join(app.getPath("downloads"), `amule-collection${filterSlug}-${date}.emulecollection`),
    filters: [{ name: "eMule Collection", extensions: ["emulecollection"] }],
  });
  if (canceled || !filePath) return { exported: false };

  await fs.promises.writeFile(filePath, collectionToText(files), "utf8");
  return { exported: true, filePath, count: files.length };
});

ipc("amule:importCollection", async () => {
  requireClient();
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: "Import Collection",
    defaultPath: app.getPath("downloads"),
    filters: [{ name: "Collection", extensions: ["emulecollection", "txt"] }],
    properties: ["openFile"],
  });
  if (canceled || !filePaths || filePaths.length === 0) return { imported: false };

  const text = await fs.promises.readFile(filePaths[0], "utf8");
  const links = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith("ed2k://|file|"));
  if (links.length === 0) throw new Error("No ed2k://|file| links found in this file.");

  let added = 0;
  let failed = 0;
  for (const link of links) {
    try {
      await client.addEd2kLink(link, 0);
      added++;
    } catch (_) {
      failed++;
    }
  }
  return { imported: true, added, failed, total: links.length };
});

ipc("amule:updateFileReview", async ({ fileHash, rating, comment }) => {
  requireClient();
  if (!fileHash) throw new Error("fileHash is required.");
  const safeRating = (rating != null && rating >= 0 && rating <= 5) ? Math.round(Number(rating)) : 0;
  const safeComment = typeof comment === "string" ? comment.trim() : "";
  return client.setFileRatingComment(fileHash, safeComment, safeRating);
});

ipc("amule:renameFile", async ({ fileHash, newName }) => {
  requireClient();
  if (!fileHash) throw new Error("fileHash is required.");
  if (!newName || !newName.trim()) throw new Error("newName is required.");
  return client.renameFile(fileHash, newName.trim());
});

ipc("amule:searchAndWaitResults", async ({ query, network, extension }) => {
  requireClient();
  return client.searchAndWaitResults(query, network || "global", extension || undefined);
});

ipc("amule:downloadSearchResult", async ({ fileHash, categoryId }) => {
  requireClient();
  return client.downloadSearchResult(fileHash, Number(categoryId) || 0);
});

ipc("amule:addEd2kLink", async ({ link, categoryId }) => {
  requireClient();
  if (!link) throw new Error("Link is required.");
  return client.addEd2kLink(link, Number(categoryId) || 0);
});

ipc("amule:pauseDownload", async ({ fileHash }) => {
  requireClient();
  return client.pauseDownload(fileHash);
});

ipc("amule:resumeDownload", async ({ fileHash }) => {
  requireClient();
  return client.resumeDownload(fileHash);
});

ipc("amule:cancelDownload", async ({ fileHash }) => {
  requireClient();
  return client.cancelDownload(fileHash);
});

ipc("amule:getConnectionState", async () => {
  requireClient();
  return client.getConnectionState();
});

ipc("amule:getServerList", async () => {
  requireClient();
  return client.getServerList();
});

ipc("amule:getCategories", async () => {
  requireClient();
  return client.getCategories();
});

ipc("amule:refreshSharedFiles", async () => {
  requireClient();
  return client.refreshSharedFiles();
});

async function openWithOperatingSystem(filePath) {
  if (process.platform === "darwin") {
    await new Promise((resolve, reject) => {
      execFile("open", [filePath], (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    return true;
  }

  const result = await shell.openPath(filePath);
  if (result) throw new Error(result);
  return true;
}

function fullPathOf(filePath, fileName) {
  if (!filePath) throw new Error("No file path provided.");
  return fileName ? path.join(filePath, fileName) : filePath;
}

/** Hand the file to the system default application (the player's ↗ button). */
ipc("amule:openFile", async ({ filePath, fileName }) => {
  return openWithOperatingSystem(fullPathOf(filePath, fileName));
});

/** Show the file in Finder/Explorer — used for everything the app cannot play. */
ipc("amule:revealFile", async ({ filePath, fileName }) => {
  shell.showItemInFolder(fullPathOf(filePath, fileName));
  return true;
});

ipc("amule:mediaExtensions", async () => media.extensions());

/**
 * Resolve a local file for the in-app player: its kind, a media:// URL to
 * stream it from, and the position it was last left at.
 */
ipc("amule:mediaOpen", async ({ filePath, fileName, key }) => {
  const fullPath = fullPathOf(filePath, fileName);
  const stat = await fs.promises.stat(fullPath);
  if (!stat.isFile()) throw new Error("Not a file.");

  const { kind, mime } = media.classify(fullPath);
  if (kind === "other") return { kind };

  return {
    kind,
    mime,
    url: media.urlFor(fullPath),
    size: stat.size,
    position: media.getPosition(key || fullPath),
  };
});

ipc("amule:savePlayback", async ({ key, position, duration, name }) => {
  return media.savePosition(key, Number(position), Number(duration), name);
});

ipc("amule:clearPlayback", async ({ key }) => media.clearPosition(key));

ipc("amule:deleteFile", async ({ filePath, fileName }) => {
  const fullPath = fullPathOf(filePath, fileName);
  console.log(`[DELETE] ${JSON.stringify(fullPath)}`);
  await fs.promises.unlink(fullPath);
  if (client) await client.refreshSharedFiles();
  return true;
});

// ── Discovery IPC ──

ipc("amule:discoveryGetState", async () => {
  const state = discoveries.getState();
  return { keywords: state.keywords, results: discoveries.getAllResults(state) };
});

ipc("amule:discoveryAddKeyword", async ({ label, interval }) => {
  const state = discoveries.addKeyword(label, interval);
  return { keywords: state.keywords, results: discoveries.getAllResults(state) };
});

ipc("amule:discoveryRemoveKeyword", async ({ id }) => {
  const state = discoveries.removeKeyword(id);
  return { keywords: state.keywords, results: discoveries.getAllResults(state) };
});

ipc("amule:discoveryUpdateKeyword", async ({ id, label, interval }) => {
  const state = discoveries.updateKeyword(id, { label, interval });
  return { keywords: state.keywords, results: discoveries.getAllResults(state) };
});

ipc("amule:discoveryRunNow", async () => {
  requireClient();
  discoveries.runNow(() => client, notifyRenderer);
  return true;
});

// ── Peer shared files (persisted in peers.json) ──

ipc("amule:peersGetState", async () => {
  return peers.getView();
});

ipc("amule:peersScanNow", async () => {
  requireClient();
  // Fire-and-forget; progress streams to the renderer over peers:* events.
  peers.scan(() => client, notifyRenderer, { force: true });
  return true;
});

ipc("amule:peersBan", async ({ key }) => {
  peers.setBanned(key, true);
  return peers.getView();
});

ipc("amule:peersUnban", async ({ key }) => {
  peers.setBanned(key, false);
  return peers.getView();
});

ipc("amule:peersUpdateSettings", async ({ scanIntervalHours, refetchDays }) => {
  peers.updateSettings({ scanIntervalHours, refetchDays });
  return peers.getView();
});

ipc("amule:getConnectionSettings", async () => {
  return loadConnectionSettings();
});

function requireClient() {
  if (!client) throw new Error("Not connected to aMule.");
}

function validPort(p) {
  const n = Number(p);
  return Number.isInteger(n) && n >= 1 && n <= 65535;
}

app.whenReady().then(() => {
  media.registerHandler();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  discoveries.stopScheduler();
  peers.stopScheduler();
  if (client) {
    try { client.close(); } catch (_) { /* ignore */ }
    client = null;
  }
  if (process.platform !== "darwin") app.quit();
});
