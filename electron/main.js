"use strict";

const path = require("path");
const { app, BrowserWindow, ipcMain, shell } = require("electron");
const { execFile } = require("child_process");
const fs = require("fs");
const AmuleClient = require("../AmuleClient");
const discoveries = require("./discoveries");

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

function mergeCollection(sharedFiles) {
  const persisted = loadCollection();
  if (!sharedFiles || sharedFiles.length === 0) {
    alert("No shared files found.");
    return persisted;
  }

  const now = Date.now();

  for (const f of sharedFiles) {
    if (f.fileHash) persisted[f.fileHash] = persisted[f.fileHash] || now;
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

  return { host: safeHost, port: safePort };
});

ipc("amule:disconnect", async () => {
  discoveries.stopScheduler();
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

ipc("amule:getSharedFiles", async () => {
  requireClient();
  const files = await client.getSharedFiles();
  const downloadQueue = await client.getDownloadQueue();
  const filesWithoutDownloadQueue = files.filter(f => !downloadQueue.some(d => d.fileHash === f.fileHash));
  const timestamps = mergeCollection(filesWithoutDownloadQueue);
  for (const f of filesWithoutDownloadQueue) {
    f.firstSeen = timestamps[f.fileHash] || Date.now();
  }
  filesWithoutDownloadQueue.sort((a, b) => b.firstSeen - a.firstSeen || (a.fileName || "").localeCompare(b.fileName || ""));
  return filesWithoutDownloadQueue;
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

function findVlc() {
  const candidates = VLC_PATHS[process.platform] || [];
  for (const p of candidates) {
    try { if (fs.statSync(p).isFile()) return p; } catch (_) { /* skip */ }
  }
  return null;
}

ipc("amule:openFile", async ({ filePath, fileName }) => {
  if (!filePath) throw new Error("No file path provided.");

  const fullPath = fileName ? path.join(filePath, fileName) : filePath;

  const vlc = findVlc();
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

  const result = await shell.openPath(fullPath);
  if (result) throw new Error(result);
  return true;
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
  if (client) {
    try { client.close(); } catch (_) { /* ignore */ }
    client = null;
  }
  if (process.platform !== "darwin") app.quit();
});
