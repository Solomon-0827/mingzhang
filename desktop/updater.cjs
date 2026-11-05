const { createHash, verify } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { Readable, Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");

const PLATFORM_FILES = {
  "darwin-arm64": "mingzhang-mac-arm64.zip",
  "win32-x64": "mingzhang-windows11-x64.zip",
};
const UPDATE_ORIGIN = "https://solomon-ledger.top";
const RELEASE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAU47FbfxJuBjrHxL+3rmW/NXns+/qLixWfwZrKbr6C60=
-----END PUBLIC KEY-----`;

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

async function checkForUpdate({ currentVersion, fetchImpl = fetch, platform, arch, publicKey = RELEASE_PUBLIC_KEY }) {
  const key = platformKey(platform, arch);
  const endpoint = new URL("/downloads/latest.json", UPDATE_ORIGIN);
  const response = await fetchImpl(endpoint, { cache: "no-store", redirect: "error" });
  if (!response.ok) throw new Error(`检查更新失败（${response.status}）`);
  const envelope = JSON.parse(await response.text());
  if (envelope?.schema !== 1 || typeof envelope.payload !== "string" || typeof envelope.signature !== "string") throw new Error("更新清单格式无效");
  const payload = Buffer.from(envelope.payload, "base64");
  const signature = Buffer.from(envelope.signature, "base64");
  if (!payload.length || !signature.length || !verify(null, payload, publicKey, signature)) throw new Error("更新清单签名无效");
  const manifest = JSON.parse(payload.toString("utf8"));
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
  const response = await fetchImpl(release.url, { cache: "no-store", redirect: "error" });
  if (!response.ok || !response.body) throw new Error(`下载更新失败（${response.status}）`);
  const temporary = `${destination}.part`;
  const hash = createHash("sha256");
  try {
    const hashing = new Transform({ transform(chunk, _encoding, callback) { hash.update(chunk); callback(null, chunk); } });
    await pipeline(Readable.fromWeb(response.body), hashing, fs.createWriteStream(temporary, { mode: 0o600 }));
    if (hash.digest("hex") !== release.sha256) throw new Error("更新包校验失败，已停止安装");
    fs.rmSync(destination, { force: true });
    fs.renameSync(temporary, destination);
    return destination;
  } catch (error) {
    fs.rmSync(temporary, { force: true, recursive: true });
    throw error;
  }
}

async function launchInstaller({ appPath, archive, helper, version, pid = process.pid, platform = process.platform }) {
  if (!fs.existsSync(appPath) || !fs.existsSync(archive) || !fs.existsSync(helper)) throw new Error("更新安装文件不完整");
  if (platform === "win32" && !fs.existsSync(path.join(appPath, ".mingzhang-managed"))) throw new Error("当前应用目录不支持自动更新，请安装正式客户端");
  if (platform === "darwin" && path.extname(appPath) !== ".app") throw new Error("当前应用目录不支持自动更新");
  const parent = path.dirname(appPath);
  fs.accessSync(parent, fs.constants.W_OK);
  const command = platform === "darwin" ? "/bin/sh" : "powershell.exe";
  const args = platform === "darwin"
    ? [helper, String(pid), archive, appPath, version]
    : ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", helper, String(pid), archive, appPath, version];
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: path.dirname(helper), detached: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

module.exports = { PLATFORM_FILES, RELEASE_PUBLIC_KEY, UPDATE_ORIGIN, checkForUpdate, downloadUpdate, isNewerVersion, launchInstaller, platformKey };
