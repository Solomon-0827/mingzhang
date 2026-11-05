const { app, BrowserWindow, Menu, ipcMain, dialog, nativeImage } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { checkForUpdate, downloadUpdate, launchInstaller } = require("./updater.cjs");
let main, setup;
let updateState = { status: "idle", currentVersion: app.getVersion() };
let checkingUpdate = null;
let ledgerOrigin = "";
const configFile = () => path.join(app.getPath("userData"), "connection.json");
function readURL() {
  try {
    return JSON.parse(fs.readFileSync(configFile(), "utf8")).url || "";
  } catch {
    return "";
  }
}
function validURL(value) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash)
    throw Error("地址不能包含密码或参数");
  if (
    url.protocol !== "https:" &&
    !(
      url.protocol === "http:" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    )
  )
    throw Error("云端地址需要 HTTPS；本地测试可使用 http://127.0.0.1:8765");
  return url.origin;
}
function setupWindow() {
  if (setup) {
    setup.focus();
    return;
  }
  setup = new BrowserWindow({
    width: 600,
    height: 460,
    resizable: false,
    title: "连接明账",
    backgroundColor: "#F9F7F0",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  setup.loadFile("setup.html");
  setup.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  setup.webContents.on("will-navigate", (e) => e.preventDefault());
  setup.on("closed", () => {
    setup = null;
  });
}
function openLedger(url) {
  if (main) main.close();
  main = new BrowserWindow({
    width: 1360,
    height: 930,
    minWidth: 880,
    minHeight: 650,
    title: "明账",
    backgroundColor: "#F9F7F0",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  main.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  main.webContents.on("will-navigate", (event, target) => {
    if (new URL(target).origin !== url) event.preventDefault();
  });
  main.webContents.session.setPermissionRequestHandler(
    (_webContents, _permission, callback) => callback(false),
  );
  main.webContents.session.setPermissionCheckHandler(() => false);
  main.webContents.on(
    "did-fail-load",
    (_event, code, _description, _url, isMain) => {
      if (isMain && code !== -3) {
        dialog.showMessageBox(main, {
          type: "warning",
          title: "无法连接账本",
          message: "账本服务暂时无法连接",
          detail:
            "请确认服务器已启动、网络可用，或通过菜单“明账 → 服务器连接”修改地址。",
          buttons: ["知道了"],
        });
      }
    },
  );
  main.loadURL(url);
  ledgerOrigin = url;
  main.webContents.once("did-finish-load", () => {
    main.webContents.send("update:state", updateState);
    void runUpdateCheck();
  });
  main.on("closed", () => {
    main = null;
  });
}
function setUpdateState(next) {
  updateState = { ...updateState, ...next, currentVersion: app.getVersion() };
  if (main && !main.isDestroyed()) main.webContents.send("update:state", updateState);
  return updateState;
}
async function runUpdateCheck() {
  if (!app.isPackaged || ["downloading", "installing"].includes(updateState.status) || checkingUpdate) return checkingUpdate || updateState;
  checkingUpdate = (async () => {
    try {
      const release = await checkForUpdate({ currentVersion: app.getVersion() });
      return setUpdateState(release ? { status: "available", release, error: undefined } : { status: "idle", release: undefined, error: undefined });
    } catch (error) {
      return setUpdateState({ status: "idle", error: error.message });
    } finally {
      checkingUpdate = null;
    }
  })();
  return checkingUpdate;
}
ipcMain.handle("connection:read", (event) => {
  if (event.sender !== setup?.webContents) throw Error("无权限");
  return readURL();
});
ipcMain.handle("connection:save", (event, value) => {
  if (
    event.sender !== setup?.webContents ||
    event.senderFrame.url !==
      pathToFileURL(path.join(__dirname, "setup.html")).href
  )
    throw Error("无权限");
  const url = validURL(value);
  fs.writeFileSync(configFile(), JSON.stringify({ url }), { mode: 0o600 });
  openLedger(url);
  setup.close();
  return true;
});
ipcMain.handle("update:state", (event) => {
  if (event.sender !== main?.webContents) throw Error("无权限");
  return updateState;
});
ipcMain.handle("update:check", (event) => {
  if (event.sender !== main?.webContents) throw Error("无权限");
  return runUpdateCheck();
});
ipcMain.handle("update:install", async (event) => {
  let senderOrigin = "";
  try { senderOrigin = new URL(event.senderFrame.url).origin; } catch {}
  if (!app.isPackaged || senderOrigin !== ledgerOrigin || event.sender !== main?.webContents || event.senderFrame !== main?.webContents.mainFrame || updateState.status !== "available" || !updateState.release) throw Error("当前没有可安装的更新");
  try {
    const release = updateState.release;
    setUpdateState({ status: "downloading", error: undefined });
    const updates = path.join(app.getPath("userData"), "updates");
    fs.mkdirSync(updates, { recursive: true, mode: 0o700 });
    const archive = path.join(updates, `mingzhang-${release.version}.zip`);
    await downloadUpdate(release, archive);
    setUpdateState({ status: "installing" });
    const helperName = process.platform === "darwin" ? "update-mac.sh" : "update-windows.ps1";
    const helper = path.join(updates, helperName);
    fs.copyFileSync(path.join(__dirname, helperName), helper);
    fs.chmodSync(helper, 0o700);
    const appPath = process.platform === "darwin"
      ? path.resolve(app.getAppPath(), "../../..")
      : path.resolve(app.getAppPath(), "../..");
    launchInstaller({ appPath, archive, helper, version: release.version });
    setImmediate(() => app.quit());
    return true;
  } catch (error) {
    setUpdateState({ status: "available", error: error.message });
    throw error;
  }
});
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (main) {
      if (main.isMinimized()) main.restore();
      main.focus();
    } else setupWindow();
  });
  app.whenReady().then(() => {
    // Explicitly refresh the running Dock icon after an installed app is upgraded.
    // macOS may otherwise retain the icon from the previous bundle registration.
    if (process.platform === "darwin") {
      const icon = nativeImage.createFromPath(path.join(__dirname, "dock-icon.png"));
      if (!icon.isEmpty()) app.dock.setIcon(icon);
    }
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        {
          label: "明账",
          submenu: [
            { role: "about", label: "关于明账" },
            {
              label: "服务器连接…",
              accelerator: "CmdOrCtrl+,",
              click: setupWindow,
            },
            { type: "separator" },
            { role: "hide", label: "隐藏明账" },
            { role: "quit", label: "退出明账" },
          ],
        },
        {
          label: "编辑",
          submenu: [
            { role: "undo", label: "撤销" },
            { role: "redo", label: "重做" },
            { type: "separator" },
            { role: "cut", label: "剪切" },
            { role: "copy", label: "复制" },
            { role: "paste", label: "粘贴" },
            { role: "selectAll", label: "全选" },
          ],
        },
        {
          label: "显示",
          submenu: [
            { role: "reload", label: "刷新账本" },
            { role: "resetZoom", label: "实际大小" },
            { role: "zoomIn", label: "放大" },
            { role: "zoomOut", label: "缩小" },
            { role: "togglefullscreen", label: "全屏" },
          ],
        },
        {
          label: "窗口",
          submenu: [
            { role: "minimize", label: "最小化" },
            { role: "zoom", label: "缩放" },
          ],
        },
      ]),
    );
    let url = readURL();
    try {
      url = validURL(url);
      openLedger(url);
    } catch {
      setupWindow();
    }
    setInterval(() => void runUpdateCheck(), 6 * 60 * 60 * 1000).unref();
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  app.on("activate", () => {
    if (!main && !setup) {
      const url = readURL();
      if (url) openLedger(url);
      else setupWindow();
    }
  });
}
