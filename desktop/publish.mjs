// Upload a locally built installer. Credentials remain in the user's SSH files.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const dir = path.dirname(fileURLToPath(import.meta.url));
const platform = process.argv[2] || process.platform;
const names = { darwin: 'mingzhang-mac-arm64.zip', win32: 'mingzhang-windows11-x64.zip' };
const name = names[platform];
if (!name) throw new Error('Choose darwin or win32.');
const target = process.env.DESKTOP_SSH_TARGET;
const key = process.env.DESKTOP_SSH_KEY;
const hosts = process.env.DESKTOP_KNOWN_HOSTS;
if (!target || !/^[a-z_][a-z0-9_-]*@[a-zA-Z0-9.-]+$/.test(target) || !key || !hosts) {
  throw new Error('Set DESKTOP_SSH_TARGET=user@host, DESKTOP_SSH_KEY and DESKTOP_KNOWN_HOSTS.');
}
const file = path.resolve(process.argv[3] || path.join(dir, 'out/downloads', name));
const digest = createHash('sha256').update(readFileSync(file)).digest('hex');
if (readFileSync(file + '.sha256', 'utf8').trim() !== `${digest}  ${name}`) throw new Error('Installer checksum mismatch; refusing upload.');
const options = ['-i', key, '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${hosts}`];
const remote = execFileSync('ssh', [...options, target, 'mktemp -d /tmp/mingzhang-desktop-XXXXXXXX'], { encoding: 'utf8' }).trim();
if (!/^\/tmp\/mingzhang-desktop-[A-Za-z0-9]+$/.test(remote)) throw new Error('Unexpected upload directory.');
try {
  execFileSync('scp', [...options, file, `${target}:${remote}/installer.zip`], { stdio: 'inherit' });
  execFileSync('scp', [...options, path.join(dir, '../deploy/publish-desktop.py'), `${target}:${remote}/publish.py`], { stdio: 'inherit' });
  execFileSync('ssh', [...options, target, `sudo -n python3 ${remote}/publish.py ${remote}/installer.zip ${name} ${digest}`], { stdio: 'inherit' });
  console.log(`Published /downloads/${name}`);
} finally {
  execFileSync('ssh', [...options, target, `rm -rf -- ${remote}`], { stdio: 'inherit' });
}
