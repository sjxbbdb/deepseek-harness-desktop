import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const main = readFileSync(join(root, 'main.js'), 'utf8');
const preload = readFileSync(join(root, 'preload.js'), 'utf8');
const boot = readFileSync(join(root, 'boot.html'), 'utf8');

assert.equal(pkg.main, 'main.js');
assert.equal(pkg.build?.asar, false);
assert.equal(pkg.build?.productName, 'DeepSeek Harness');
assert.equal(typeof pkg.dependencies?.['@deepseek-ai/dsh'], 'string');

for (const file of ['main.js', 'preload.js', 'boot.html', 'icons/icon.png']) {
  assert.ok(existsSync(join(root, file)), `missing ${file}`);
}

assert.match(main, /startDshService/);
assert.match(main, /probeService/);
assert.match(main, /READY_MARKER/);
assert.match(preload, /desktop:action/);
assert.match(preload, /desktop:status/);
assert.match(boot, /window\.dshDesktop/);
assert.match(boot, /正在启动 dsh 服务/);

console.log('desktop smoke checks passed');
