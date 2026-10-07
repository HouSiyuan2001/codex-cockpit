import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// Defense-in-depth, not a guarantee. Binary assets and commit author metadata need manual review.
const paths = [...new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {encoding:'utf8'}).split('\0').filter(Boolean))];
const failures = [];
const forbiddenFile = /(^|\/)(auth\.json|cloud-sync\.json|usage-sync\.json|cloud-snapshots|\.dev\.vars[^/]*|wrangler\.local\.[^/]+|\.env(?!\.example)[^/]*|id_rsa|id_ed25519)(\/|$)|\.(sqlite3?|db|p12|pfx|pem|key)$/i;
function scan(path, data, label = path) {
  if (forbiddenFile.test(path) || /(^|\/)\.research(\/|$)/.test(path)) failures.push(`${label}: forbidden runtime/credential file`);
  if (data.includes(0) || /\.(png|ico|icns|woff2?)$/i.test(path)) return;
  const lines = data.toString('utf8').split('\n');
  for (const [index, line] of lines.entries()) {
    const checks = [
      ['private key', /-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----/],
      ['access token', /\b(?:ghp_|github_pat_|sk-proj-)[A-Za-z0-9_]{20,}/],
      ['sync credential', /\b(?:ccs_[A-Za-z0-9_-]{43}|CCI-[A-Za-z0-9_-]{16})\b/],
      ['deployment database id', /^\s*database_id\s*=\s*"[a-f0-9-]{32,}"/i],
      ['personal home path', /(?:\/Users\/(?!test(?:\/|\b)|example(?:\/|\b)|user(?:\/|\b)|runner(?:\/|\b))[A-Za-z0-9._-]+\/|C:\\\\Users\\\\(?!test|example|user|runner)[A-Za-z0-9._-]+\\\\)/i],
    ];
    for (const [kind, pattern] of checks) if (pattern.test(line)) failures.push(`${label}:${index + 1}: ${kind}`);
  }
}
for (const path of paths) scan(path, readFileSync(path));
let historyBlobs = 0;
if (process.argv.includes('--history')) {
  const rows = execFileSync('git', ['rev-list', '--objects', '--all'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).trim().split('\n');
  for (const row of rows) {
    const space = row.indexOf(' ');
    if (space < 0) continue;
    const oid = row.slice(0, space), path = row.slice(space + 1);
    if (execFileSync('git', ['cat-file', '-t', oid], { encoding: 'utf8' }).trim() !== 'blob') continue;
    historyBlobs++;
    const data = execFileSync('git', ['cat-file', 'blob', oid], { maxBuffer: 64 * 1024 * 1024 });
    scan(path, data, `${path}@${oid.slice(0, 8)}`);
  }
}
if (failures.length) { console.error(failures.join('\n')); process.exitCode = 1; }
else console.log(`Publication audit passed (${paths.length} source files, ${historyBlobs} historical blobs; manual review still required).`);
