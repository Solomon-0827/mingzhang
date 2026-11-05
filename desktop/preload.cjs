const { contextBridge, ipcRenderer } = require("electron");
let updateClickUntil = 0;
window.addEventListener("click", (event) => {
  const updateButton = event.composedPath().some((node) => node instanceof HTMLElement && node.dataset?.mingzhangUpdateAction === "install");
  if (event.isTrusted && updateButton) updateClickUntil = Date.now() + 1000;
}, true);
contextBridge.exposeInMainWorld("connection", {
  read: () => ipcRenderer.invoke("connection:read"),
  save: (value) => ipcRenderer.invoke("connection:save", value),
});
contextBridge.exposeInMainWorld("mingzhangUpdate", {
  getState: () => ipcRenderer.invoke("update:state"),
  check: () => ipcRenderer.invoke("update:check"),
  install: () => Date.now() <= updateClickUntil
    ? (updateClickUntil = 0, ipcRenderer.invoke("update:install"))
    : Promise.reject(new Error("请点击更新按钮后再安装")),
  onState: (listener) => {
    const handler = (_event, state) => listener(state);
    ipcRenderer.on("update:state", handler);
    return () => ipcRenderer.removeListener("update:state", handler);
  },
});
