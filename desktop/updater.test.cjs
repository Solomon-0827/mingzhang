const assert = require("node:assert/strict");
const { createHash, generateKeyPairSync, sign } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { checkForUpdate, downloadUpdate, isNewerVersion, launchInstaller, platformKey } = require("./updater.cjs");

const signing = generateKeyPairSync("ed25519");
function signedManifest(manifest) {
  const payload = Buffer.from(JSON.stringify(manifest));
  return JSON.stringify({
    schema: 1,
    payload: payload.toString("base64"),
    signature: sign(null, payload, signing.privateKey).toString("base64"),
  });
}

test("compares semantic versions", () => {
  assert.equal(isNewerVersion("0.2.0", "0.1.9"), true);
  assert.equal(isNewerVersion("1.0.0", "0.9.9"), true);
  assert.equal(isNewerVersion("0.1.1", "0.1.1"), false);
  assert.equal(isNewerVersion("0.1.0", "0.2.0"), false);
  assert.throws(() => isNewerVersion("latest", "0.2.0"), /版本号/);
});

test("accepts only supported desktop targets", () => {
  assert.equal(platformKey("darwin", "arm64"), "darwin-arm64");
  assert.equal(platformKey("win32", "x64"), "win32-x64");
  assert.throws(() => platformKey("linux", "x64"), /暂不支持/);
});

test("validates the signed update manifest and keeps downloads on the official origin", async () => {
  const release = await checkForUpdate({
    currentVersion: "0.1.0",
    platform: "darwin",
    arch: "arm64",
    publicKey: signing.publicKey,
    fetchImpl: async () => ({
      ok: true,
      text: async () => signedManifest({ schema: 1, platforms: { "darwin-arm64": {
        version: "0.2.0",
        url: "/downloads/mingzhang-mac-arm64.zip",
        sha256: "a".repeat(64),
      } } }),
    }),
  });
  assert.equal(release.url, "https://solomon-ledger.top/downloads/mingzhang-mac-arm64.zip");
  assert.equal(release.version, "0.2.0");

  await assert.rejects(() => checkForUpdate({
    currentVersion: "0.1.0",
    platform: "darwin",
    arch: "arm64",
    publicKey: signing.publicKey,
    fetchImpl: async () => ({ ok: true, text: async () => signedManifest({ schema: 1, platforms: { "darwin-arm64": {
      version: "0.2.0", url: "https://evil.example/mingzhang-mac-arm64.zip", sha256: "a".repeat(64),
    } } }) }),
  }), /地址无效/);

  await assert.rejects(() => checkForUpdate({
    currentVersion: "0.1.0",
    platform: "darwin",
    arch: "arm64",
    publicKey: signing.publicKey,
    fetchImpl: async () => ({ ok: true, text: async () => JSON.stringify({ schema: 1, payload: "e30=", signature: "aW52YWxpZA==" }) }),
  }), /签名无效/);
});

test("downloads only an installer matching the published checksum", async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "mingzhang-updater-test-"));
  const destination = path.join(folder, "update.zip");
  const body = Buffer.from("verified installer fixture");
  const release = {
    url: "https://ledger.example/downloads/mingzhang-mac-arm64.zip",
    sha256: createHash("sha256").update(body).digest("hex"),
  };
  try {
    await downloadUpdate(release, destination, async () => new Response(body));
    assert.deepEqual(fs.readFileSync(destination), body);
    await assert.rejects(
      () => downloadUpdate({ ...release, sha256: "0".repeat(64) }, destination, async () => new Response(body)),
      /校验失败/,
    );
    assert.deepEqual(fs.readFileSync(destination), body);
    assert.equal(fs.existsSync(`${destination}.part`), false);
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test("reports file stream failures without leaving a partial download", async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "mingzhang-updater-error-"));
  const destination = path.join(folder, "update.zip");
  const partial = `${destination}.part`;
  fs.mkdirSync(partial);
  const body = Buffer.from("fixture");
  try {
    await assert.rejects(() => downloadUpdate({
      url: "https://solomon-ledger.top/downloads/mingzhang-mac-arm64.zip",
      sha256: createHash("sha256").update(body).digest("hex"),
    }, destination, async () => new Response(body)));
    assert.equal(fs.existsSync(partial), false);
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test("reports a helper launch failure before the application quits", async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "mingzhang-launch-error-"));
  const appPath = path.join(folder, "app");
  const archive = path.join(folder, "update.zip");
  const helper = path.join(folder, "helper.ps1");
  fs.mkdirSync(appPath);
  fs.writeFileSync(path.join(appPath, ".mingzhang-managed"), "managed");
  fs.writeFileSync(archive, "archive");
  fs.writeFileSync(helper, "helper");
  try {
    await assert.rejects(() => launchInstaller({ appPath, archive, helper, version: "0.2.0", platform: "win32" }), /ENOENT/);
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
