"use strict";

const path = require("path");
const { app, BrowserWindow, ipcMain, shell, dialog } = require("electron");
const { execFile } = require("child_process");
const fs = require("fs");
const AmuleClient = require("../AmuleClient");
const discoveries = require("./discoveries");
const peers = require("./peers");

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

function ed2kLinkFor(f, source) {
  let link = f.ed2kLink;
  if (!link) {
    if (!f.fileHash) return "";
    link = `ed2k://|file|${encodeURIComponent(f.fileName || "unknown")}|${f.fileSize || 0}|${f.fileHash}|/`;
  }
  if (source && !/\|sources,/i.test(link)) {
    link = link.endsWith("|/")
      ? `${link}|sources,${source}|/`
      : `${link}|/|sources,${source}|/`;
  }
  return link;
}

/** High ed2k IDs encode the client's public IP as a little-endian uint32. */
function ipFromEd2kId(id) {
  const n = Number(id && typeof id === "object" ? id._value : id);
  if (!Number.isFinite(n) || n <= 0x1000000) return null; // low ID or unknown
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff].join(".");
}

/** Return "ip:port" for this aMule instance, or null if it cannot be determined (low ID). */
async function getSelfEd2kSource() {
  try {
    const [connState, prefs] = await Promise.all([
      client.getConnectionState(),
      client.getConnectionPreferences(),
    ]);
    const cs = connState?.EC_TAG_CONNSTATE || connState || {};
    const ip = ipFromEd2kId(cs.EC_TAG_CLIENT_ID) || ipFromEd2kId(cs.EC_TAG_ED2K_ID);
    if (!ip) return null;
    const port = Number(prefs?.tcpPort) || 4662;
    return `${ip}:${port}`;
  } catch (_) {
    return null;
  }
}

function collectionToText(files, source) {
  return files
    .map((f) => {
      const link = ed2kLinkFor(f, source);
      if (!link) return null;
      return `${f.fileName || "?"}\n${link}`;
    })
    .filter(Boolean)
    .join("\n\n") + "\n";
}

ipc("amule:exportCollection", async () => {
  requireClient();
  const files = await getCollectionFiles();
  if (files.length === 0) throw new Error("Collection is empty, nothing to export.");

  const date = new Date().toISOString().slice(0, 10);
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: "Export My Collection",
    defaultPath: path.join(app.getPath("downloads"), `amule-collection-${date}.txt`),
    filters: [{ name: "Text", extensions: ["txt"] }],
  });
  if (canceled || !filePath) return { exported: false };

  const source = await getSelfEd2kSource();
  await fs.promises.writeFile(filePath, collectionToText(files, source), "utf8");
  return { exported: true, filePath, count: files.length };
});

ipc("amule:importCollection", async () => {
  requireClient();
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: "Import Collection",
    defaultPath: app.getPath("downloads"),
    filters: [{ name: "Text", extensions: ["txt"] }],
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

const VLC_PATHS = {
  darwin: ["/Applications/VLC.app/Contents/MacOS/VLC"],
  win32: [
    "C:\\Program Files\\VideoLAN\\VLC\\vlc.exe",
    "C:\\Program Files (x86)\\VideoLAN\\VLC\\vlc.exe",
  ],
  linux: ["/usr/bin/vlc", "/snap/bin/vlc", "/usr/bin/cvlc"],
};

const AUDIO_VIDEO_EXTENSIONS = new Set([
  ".3gp", ".aac", ".aif", ".aiff", ".ape", ".asf", ".avi", ".flac",
  ".flv", ".m4a", ".m4v", ".mka", ".mkv", ".mov", ".mp3", ".mp4",
  ".mpeg", ".mpg", ".ogg", ".ogm", ".ogv", ".opus", ".ts", ".vob",
  ".wav", ".webm", ".wma", ".wmv",
]);

function findVlc() {
  const candidates = VLC_PATHS[process.platform] || [];
  for (const p of candidates) {
    try { if (fs.statSync(p).isFile()) return p; } catch (_) { /* skip */ }
  }
  return null;
}

function isAudioVideoFile(filePath) {
  return AUDIO_VIDEO_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

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

ipc("amule:openFile", async ({ filePath, fileName }) => {
  if (!filePath) throw new Error("No file path provided.");

  const fullPath = fileName ? path.join(filePath, fileName) : filePath;

  const vlc = isAudioVideoFile(fullPath) ? findVlc() : null;
  if (vlc) {
    console.log(`[VLC] ${vlc} ${JSON.stringify(fullPath)}`);
    return new Promise((resolve, reject) => {
      const child = execFile(vlc, [fullPath], (err) => {
        if (err) reject(err);
      });
      child.unref();
      resolve(true);
    });
  }

  return openWithOperatingSystem(fullPath);
});

ipc("amule:deleteFile", async ({ filePath, fileName }) => {
  if (!filePath) throw new Error("No file path provided.");
  const fullPath = fileName ? path.join(filePath, fileName) : filePath;
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
