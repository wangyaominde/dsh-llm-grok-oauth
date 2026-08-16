import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8');

if (pkg.main !== 'lib/index.js') throw new Error('package.json main must stay lib/index.js');
if (pkg.exports?.['./client'] !== './lib/client.js') throw new Error('missing client export');
if (!Array.isArray(pkg.dsh?.client?.inject) || pkg.dsh.client.inject.length === 0) {
  throw new Error('missing dsh.client.inject');
}
if (pkg.dsh.client.platform !== 'web') throw new Error('dsh.client.platform must be web');
if (!patch.includes('id: llm-grok')) throw new Error('cordis.patch.yml must insert llm-grok');
if (typeof pkg.dependencies?.undici !== 'string') throw new Error('undici must be a runtime dependency');

console.log('smoke ok', pkg.name, pkg.version);
