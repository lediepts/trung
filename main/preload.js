// Preload cho Renderer (contextIsolation: true)
// Cầu nối IPC an toàn: window.api.invoke(..), window.api.on(..)

const { contextBridge, ipcRenderer } = require("electron");

const ALLOWED_INVOKE = [
  "config:import",
  "config:getSaveDir",
  "config:selectSaveDir",
  "config:saveAs",
  "proxy:test", // giữ alias cho UI cũ nếu còn
  "action:stop",
  "action:run",
  "action:saveAndRun", // Lưu + Chạy
];

const ALLOWED_ON = [
  "ui:log", // main -> renderer: log
  "ui:done", // main -> renderer: hoàn tất
];

function isAllowedOn(channel) {
  return ALLOWED_ON.includes(channel);
}
function isAllowedInvoke(channel) {
  return ALLOWED_INVOKE.includes(channel);
}

contextBridge.exposeInMainWorld("api", {
  invoke: (channel, ...args) => {
    if (!isAllowedInvoke(channel))
      throw new Error(`Kênh IPC không hợp lệ: ${channel}`);
    return ipcRenderer.invoke(channel, ...args);
  },
  on: (channel, listener) => {
    if (!isAllowedOn(channel))
      throw new Error(`Kênh IPC không hợp lệ: ${channel}`);
    const wrapped = (event, payload) => {
      try {
        listener(event, payload);
      } catch (e) {
        console.error("Lỗi listener ui:on", e);
      }
    };
    ipcRenderer.on(channel, wrapped);
    return () => {
      try {
        ipcRenderer.removeListener(channel, wrapped);
      } catch (_) {}
    };
  },
  removeAll: (channel) => {
    if (!isAllowedOn(channel))
      throw new Error(`Kênh IPC không hợp lệ: ${channel}`);
    try {
      ipcRenderer.removeAllListeners(channel);
    } catch (_) {}
  },
  env: { isolation: true, platform: process.platform },
});

window.addEventListener("DOMContentLoaded", () => {
  // Có thể inject thêm nếu cần
});
