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
  "openFile",
  "deleteFile",
  "discoveryGetState",
  "discoveryAddKeyword",
  "discoveryRemoveKeyword",
  "discoveryUpdateKeyword",
  "discoveryRunNow",
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

contextBridge.exposeInMainWorld("amule", api);
