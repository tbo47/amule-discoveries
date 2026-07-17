"use strict";

const { contextBridge, ipcRenderer } = require("electron");

const api = {};
const channels = [
  "connect",
  "disconnect",
  "getStats",
  "getDownloadQueue",
  "getSharedFiles",
  "searchAndWaitResults",
  "downloadSearchResult",
  "addEd2kLink",
  "pauseDownload",
  "resumeDownload",
  "cancelDownload",
  "getConnectionState",
  "getServerList",
  "getCategories",
  "refreshSharedFiles",
  "exportCollection",
  "openFile",
  "deleteFile",
  "updateFileReview",
  "renameFile",
  "discoveryGetState",
  "discoveryAddKeyword",
  "discoveryRemoveKeyword",
  "discoveryUpdateKeyword",
  "discoveryRunNow",
  "scanPeerSharedFiles",
  "getConnectionSettings",
];

for (const ch of channels) {
  api[ch] = (arg) => ipcRenderer.invoke(`amule:${ch}`, arg);
}

api.onDiscovery = (callback) => {
  const handler = (_event, payload) => callback(payload);
  ipcRenderer.on("discovery:progress", (_e, p) => callback({ type: "progress", ...p }));
  ipcRenderer.on("discovery:error", (_e, p) => callback({ type: "error", ...p }));
  ipcRenderer.on("discovery:updated", () => callback({ type: "updated" }));
};

api.onPeers = (callback) => {
  ipcRenderer.on("peers:started", (_e, p) => callback({ type: "started", ...p }));
  ipcRenderer.on("peers:peer", (_e, p) => callback({ type: "peer", ...p }));
  ipcRenderer.on("peers:done", (_e, p) => callback({ type: "done", ...p }));
  ipcRenderer.on("peers:error", (_e, p) => callback({ type: "error", ...p }));
};

contextBridge.exposeInMainWorld("amule", api);
