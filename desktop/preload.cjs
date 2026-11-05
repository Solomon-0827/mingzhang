const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("connection", {
  read: () => ipcRenderer.invoke("connection:read"),
  save: (value) => ipcRenderer.invoke("connection:save", value),
});
contextBridge.exposeInMainWorld("mingzhangUpdate", {
  getState: () => ipcRenderer.invoke("update:state"),
  check: () => ipcRenderer.invoke("update:check"),
  install: () => ipcRenderer.invoke("update:install"),
  onState: (listener) => {
    const handler = (_event, state) => listener(state);
    ipcRenderer.on("update:state", handler);
    return () => ipcRenderer.removeListener("update:state", handler);
  },
});
