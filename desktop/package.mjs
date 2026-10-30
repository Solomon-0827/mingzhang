import { packager } from '@electron/packager';
import { mkdir, copyFile, writeFile, readFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const dir = path.dirname(fileURLToPath(import.meta.url));
const platform = process.argv[2] || process.platform;
const arch = platform === 'darwin' ? 'arm64' : 'x64';
if (!['darwin', 'win32'].includes(platform) || platform !== process.platform) {
  throw new Error('Build on macOS for Mac arm64, or Windows for Windows 11 x64.');
}
const metadata = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'));
// Package only application sources: never a developer profile, connection, or ledger.
const stage = await mkdtemp(path.join(tmpdir(), 'mingzhang-package-'));
for (const name of ['main.cjs', 'preload.cjs', 'setup.js', 'setup.html']) {
  await copyFile(path.join(dir, name), path.join(stage, name));
}
await copyFile(path.join(dir, '..', 'web', 'public', 'icon.png'), path.join(stage, 'dock-icon.png'));
await writeFile(path.join(stage, 'package.json'), JSON.stringify({
  name: metadata.name, productName: metadata.productName, version: metadata.version,
  description: metadata.description, main: metadata.main,
}));
const electron = JSON.parse(await readFile(path.join(dir, 'node_modules/electron/package.json'), 'utf8'));
const [built] = await packager({
  electronVersion: electron.version,
  dir: stage, out: path.join(dir, 'out'), name: '明账', executableName: '明账',
  platform, arch, overwrite: true, asar: true,
  appBundleId: 'local.mingzhang.ledger', appCategoryType: 'public.app-category.finance',
  icon: path.join(dir, platform === 'darwin' ? 'icon.icns' : 'icon.ico'),
  appVersion: metadata.version,
  win32metadata: { CompanyName: 'Solomon', FileDescription: '明账个人账本' },
});
const downloads = path.join(dir, 'out', 'downloads');
await mkdir(downloads, { recursive: true });
const filename = platform === 'darwin' ? 'mingzhang-mac-arm64.zip' : 'mingzhang-windows11-x64.zip';
const destination = path.join(downloads, filename);
if (platform === 'darwin') {
  const app = path.join(built, '明账.app');
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
  execFileSync('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, destination]);
} else {
  const quote = value => "'" + value.replaceAll("'", "''") + "'";
  execFileSync('powershell.exe', ['-NoProfile', '-Command', `Compress-Archive -LiteralPath ${quote(built)} -DestinationPath ${quote(destination)} -Force`], { stdio: 'inherit' });
}
const digest = createHash('sha256').update(await readFile(destination)).digest('hex');
await writeFile(destination + '.sha256', `${digest}  ${filename}\n`);
console.log(destination);
