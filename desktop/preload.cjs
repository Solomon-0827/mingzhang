const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("connection", {
  read: () => ipcRenderer.invoke("connection:read"),
  save: (value) => ipcRenderer.invoke("connection:save", value),
});
contextBridge.exposeInMainWorld("mingzhangUpdate", {
  getState: () => ipcRenderer.invoke("update:state"),
  check: () => ipcRenderer.invoke("update:check"),
  install: () => navigator.userActivation?.isActive
    ? ipcRenderer.invoke("update:install")
    : Promise.reject(new Error("请点击更新按钮后再安装")),
  onState: (listener) => {
    const handler = (_event, state) => listener(state);
    ipcRenderer.on("update:state", handler);
    return () => ipcRenderer.removeListener("update:state", handler);
  },
});
