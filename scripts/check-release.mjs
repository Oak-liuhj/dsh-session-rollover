/** 只读离线发布校验。YAML 校验限定为本项目固定模板，不作为通用解析器。 */
import assert from 'node:assert/strict';
import {readFile, stat, realpath} from 'node:fs/promises';
import {fileURLToPath, pathToFileURL} from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const root = await realpath(fileURLToPath(new URL('../', import.meta.url)));
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const repo = 'https://github.com/Oak-liuhj/dsh-session-rollover';
async function localFile(relative) {
    assert.equal(typeof relative, 'string');
    assert.ok(!path.isAbsolute(relative) && !relative.split(/[\\/]/).includes('..'), `Unsafe resource: ${relative}`);
    const file = await realpath(path.resolve(root, relative));
    assert.ok(file.startsWith(root + path.sep), `Resource escapes package: ${relative}`);
    assert.ok((await stat(file)).isFile());
    return file;
}
assert.equal(pkg.name, 'dsh-session-rollover');
assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
assert.equal(pkg.author, 'Oak-liuhj');
assert.equal(pkg.license, '(Apache-2.0 AND MIT)');
assert.equal(pkg.repository.url, 'git+' + repo + '.git');
assert.equal(pkg.bugs.url, repo + '/issues');
assert.ok(pkg.keywords.includes('dsh-plugin'));
assert.equal(pkg.dsh.manifestVersion, 1);
assert.equal(pkg.dsh.client.platform, 'web');
const compatibility = JSON.parse(await readFile(await localFile('compatibility/policy.json'), 'utf8'));
assert.equal(compatibility.baseline, pkg.dsh.verifiedDsh);
assert.ok(compatibility.verifiedRuntimeVersions.includes(compatibility.baseline));
assert.ok(compatibility.verifiedRuntimeVersions.every(version => /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)));
assert.equal(pkg.engines.dsh, compatibility.verifiedRuntimeVersions.join(' || '));
await localFile('docs/COMPATIBILITY.md');
assert.deepEqual(Object.keys(pkg.dependencies ?? {}), []);
assert.equal(pkg.scripts.prepare, undefined);
assert.equal(pkg.scripts.postinstall, undefined);

const patch = await readFile(await localFile(pkg.dsh.bundle.patch), 'utf8');
assert.match(patch, /- insert:\s+\n?\s*- id: session-rollover\s+name: 'dsh-session-rollover'/);
for (const lang of ['zh', 'en']) {
    const {meta} = JSON.parse(await readFile(await localFile(pkg.exports['./locale/*.json'].replace('*', lang)), 'utf8'));
    for (const key of ['title', 'description', 'detail']) assert.ok(meta[key]?.trim());
    await localFile(meta.detail);
}
const icon = await readFile(await localFile(pkg.icon));
assert.deepEqual([...icon.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
assert.ok(icon.length <= 256 * 1024);
assert.equal(icon.readUInt32BE(16), icon.readUInt32BE(20));
const shots = JSON.parse(await readFile(await localFile('screenshots.json'), 'utf8'));
assert.ok(Array.isArray(shots) && shots.length >= 1 && shots.length <= 8);
for (const shot of shots) { assert.match(shot, /\.(png|jpe?g|webp)$/i); await localFile(shot); }

const entry = await readFile(await localFile('marketplace/Oak-liuhj__dsh-session-rollover.yml'), 'utf8');
assert.deepEqual(entry.split(/\r?\n/).filter(line => /^\w/.test(line)).map(line => line.split(':')[0]).sort(),
    ['category', 'description', 'icon', 'name', 'url']);
for (const line of [`url: ${repo}`, 'name: Oak-liuhj/dsh-session-rollover', 'category: session',
    `icon: https://raw.githubusercontent.com/Oak-liuhj/dsh-session-rollover/main/${pkg.icon}`]) assert.ok(entry.split(/\r?\n/).includes(line));
assert.match(entry, /^  en: '[^'\n]+\.'$/m);
assert.match(entry, /^  zh: '[^'\n]+。'$/m);
for (const file of ['README.md', 'CHANGELOG.md', 'LICENSE', 'LICENSE.upstream', 'NOTICE']) await localFile(file);
const server = await import(pathToFileURL(await localFile(pkg.main)).href);
assert.equal(typeof server.default, 'function');
let moduleInfo;
const client = await readFile(await localFile('client.js'), 'utf8');
vm.runInNewContext(client, {window: {__ModuleLoader__: {load: value => { moduleInfo = value; }}}});
assert.equal(moduleInfo.id, pkg.name, 'Client ModuleLoader id must match public package');
assert.equal(typeof moduleInfo.factory, 'function');
assert.ok(client.includes(`Version ${pkg.version}.`));
console.log(`Release format PASS: ${pkg.name}@${pkg.version}; bundle, locales, PNG, ${shots.length} screenshots, catalog and runtime entries.`);
