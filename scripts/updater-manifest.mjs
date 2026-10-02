import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { pathToFileURL } from 'node:url';

export function makeManifest({ repository, version, files, signature, notes, date }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('Invalid repository');
  if (!/^\d+\.\d+\.\d+(?:-beta\.\d+)?$/.test(version)) throw new Error('Invalid version');
  const select = suffix => {
    const found = files.filter(file => file.endsWith(suffix));
    if (found.length !== 1) throw new Error(`Expected exactly one ${suffix} artifact`);
    const file = found[0]; const sig = signature(file).trim();
    if (!sig) throw new Error(`Missing signature for ${file}`);
    return { url: `https://github.com/${repository}/releases/download/v${version}/${encodeURIComponent(basename(file))}`, signature: sig };
  };
  const mac = select('.app.tar.gz'); const win = select('-setup.exe');
  return { version, notes, pub_date: date, platforms: { 'darwin-aarch64': mac, 'darwin-x86_64': mac, 'windows-x86_64': win } };
}

export function assertNewer(next, previous) {
  const parse = value => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+))?$/.exec(value);
    if (!match) throw new Error('Unsupported feed version');
    return [Number(match[1]), Number(match[2]), Number(match[3]), match[4] === undefined ? Infinity : Number(match[4])];
  };
  const a = parse(next), b = parse(previous);
  for (let index = 0; index < a.length; index++) {
    if (a[index] > b[index]) return;
    if (a[index] < b[index]) break;
  }
  throw new Error('Refusing to move update feed backwards or replace the same version');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [directory, repository, version, previousPath] = process.argv.slice(2);
  if (previousPath) assertNewer(version, JSON.parse(readFileSync(previousPath, 'utf8')).version);
  const manifest = makeManifest({ repository, version, files: readdirSync(directory),
    signature: file => readFileSync(resolve(directory, `${file}.sig`), 'utf8'),
    notes: readFileSync('docs/RELEASE.md', 'utf8'), date: new Date().toISOString() });
  writeFileSync(resolve(directory, 'latest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}
