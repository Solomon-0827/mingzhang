const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const PLATFORM_FILES = {
  "darwin-arm64": "mingzhang-mac-arm64.zip",
  "win32-x64": "mingzhang-windows11-x64.zip",
};

function parseVersion(value) {
  if (!/^\d+\.\d+\.\d+$/.test(value)) throw new Error("更新版本号无效");
  return value.split(".").map(Number);
}

function isNewerVersion(candidate, current) {
  const next = parseVersion(candidate);
  const installed = parseVersion(current);
  for (let index = 0; index < next.length; index += 1) {
    if (next[index] !== installed[index]) return next[index] > installed[index];
  }
  return false;
}

function platformKey(platform = process.platform, arch = process.arch) {
  const key = `${platform}-${arch}`;
  if (!PLATFORM_FILES[key]) throw new Error("当前系统暂不支持自动更新");
  return key;
}

async function checkForUpdate({ origin, currentVersion, fetchImpl = fetch, platform, arch }) {
  const key = platformKey(platform, arch);
  const endpoint = new URL("/downloads/latest.json", origin);
  if (endpoint.protocol !== "https:") throw new Error("更新服务必须使用 HTTPS");
  const response = await fetchImpl(endpoint, { cache: "no-store" });
  if (!response.ok) throw new Error(`检查更新失败（${response.status}）`);
  const manifest = await response.json();
  const release = manifest?.schema === 1 ? manifest.platforms?.[key] : null;
  if (!release) return null;
  parseVersion(release.version);
  if (!/^[a-f0-9]{64}$/.test(release.sha256)) throw new Error("更新校验信息无效");
  const download = new URL(release.url, endpoint);
  if (download.origin !== endpoint.origin || download.protocol !== "https:" || path.posix.basename(download.pathname) !== PLATFORM_FILES[key]) {
    throw new Error("更新下载地址无效");
  }
  return isNewerVersion(release.version, currentVersion) ? { ...release, url: download.href } : null;
}

async function downloadUpdate(release, destination, fetchImpl = fetch) {
  const response = await fetchImpl(release.url, { cache: "no-store" });
  if (!response.ok || !response.body) throw new Error(`下载更新失败（${response.status}）`);
  const temporary = `${destination}.part`;
  const hash = createHash("sha256");
  const stream = fs.createWriteStream(temporary, { mode: 0o600 });
  try {
    for await (const chunk of response.body) {
      hash.update(chunk);
      if (!stream.write(chunk)) await new Promise((resolve) => stream.once("drain", resolve));
    }
    await new Promise((resolve, reject) => stream.end((error) => error ? reject(error) : resolve()));
    if (hash.digest("hex") !== release.sha256) throw new Error("更新包校验失败，已停止安装");
    fs.rmSync(destination, { force: true });
    fs.renameSync(temporary, destination);
    return destination;
  } catch (error) {
    stream.destroy();
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

function launchInstaller({ appPath, archive, helper, version, pid = process.pid, platform = process.platform }) {
  if (!fs.existsSync(appPath) || !fs.existsSync(archive) || !fs.existsSync(helper)) throw new Error("更新安装文件不完整");
  const parent = path.dirname(appPath);
  fs.accessSync(parent, fs.constants.W_OK);
  const command = platform === "darwin" ? "/bin/sh" : "powershell.exe";
  const args = platform === "darwin"
    ? [helper, String(pid), archive, appPath, version]
    : ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", helper, String(pid), archive, appPath, version];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.unref();
}

module.exports = { PLATFORM_FILES, checkForUpdate, downloadUpdate, isNewerVersion, launchInstaller, platformKey };
