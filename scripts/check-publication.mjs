import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, readFile, lstat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(path.join(root, 'source-manifest.json'), 'utf8'));
const added = [
  '.gitignore', 'README.md', 'package.json', 'source-manifest.json',
  'backend/package.json', 'backend/package-lock.json', 'backend/tsconfig.json',
  'backend/test-support/offline.mjs',
  'docs/architecture.md', 'docs/judge-guide.md', 'docs/publication-scope.md',
  'onchain/README.md', 'onchain/addresses.json',
  'integrations/ios/README.md',
  'scripts/check-publication.mjs', 'scripts/inspect-chain.mjs',
];
const allowed = new Set([...added, ...manifest.files.map(x => x.path)]);
const ignored = new Set(['.git', 'node_modules', 'dist']);
const findings = [];
const rules = [
  ['private key', /-----BEGIN (?:[A-Z ]+)?PRIVATE KEY-----/],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{30,})/],
  ['API token', /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{30,}/],
  ['AWS access key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ['JWT literal', /\beyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/],
  ['credential in URL', /(?:postgres(?:ql)?|rediss?|https?):\/\/[^\s/'"<>]+:[^\s/'"<>]+@/],
  ['Solana keypair literal', /\[\s*(?:\d{1,3}\s*,\s*){63}\d{1,3}\s*\]/],
];
const found = new Set();
async function walk(directory) {
  for (const name of await readdir(directory)) {
    if (ignored.has(name)) continue;
    const absolute = path.join(directory, name);
    const relative = path.relative(root, absolute).split(path.sep).join('/');
    const stat = await lstat(absolute);
    if (stat.isSymbolicLink()) { findings.push(`${relative}: symlinks are not publishable`); continue; }
    if (stat.isDirectory()) { await walk(absolute); continue; }
    found.add(relative);
    if (!allowed.has(relative)) findings.push(`${relative}: outside publication allowlist`);
    const text = await readFile(absolute, 'utf8');
    for (const [label, pattern] of rules) {
      if (pattern.test(text)) findings.push(`${relative}: possible ${label}`);
    }
  }
}
await walk(root);
for (const name of allowed) if (!found.has(name)) findings.push(`${name}: missing`);
if (existsSync(path.join(root, '.git'))) {
  const tracked = new Set(execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean));
  for (const name of tracked) if (!allowed.has(name)) findings.push(`${name}: tracked outside publication allowlist`);
  for (const name of allowed) if (!tracked.has(name)) findings.push(`${name}: not included in Git index`);
}
for (const file of manifest.files) {
  if (!file.path.startsWith('backend/') || file.path.split('/').includes('..')) throw new Error('Invalid manifest path');
  const bytes = await readFile(path.join(root, file.path));
  if (createHash('sha256').update(bytes).digest('hex') !== file.sha256) findings.push(`${file.path}: snapshot hash changed`);
}
const lock = JSON.parse(await readFile(path.join(root, 'backend/package-lock.json'), 'utf8'));
for (const [name, entry] of Object.entries(lock.packages)) {
  if (entry.resolved && (!entry.resolved.startsWith('https://registry.npmjs.org/') || !entry.integrity)) {
    findings.push(`${name}: dependency must use the public npm registry with integrity`);
  }
}
if (findings.length) {
  console.error(findings.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Publication checks passed: ${found.size} files; ${manifest.files.length} unchanged source files. No credential-pattern findings.`);
}
