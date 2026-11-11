/** 校验真正交付的 tgz：隔离安装、稳定导出、清单和预构建浏览器入口；不接触 DSH profile。 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {pathToFileURL, fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const run = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const npm = process.env.npm_execpath;
assert.ok(npm && path.basename(npm) === 'npm-cli.js', 'Run this check with npm run check:package');
const owned = await fs.mkdtemp(path.join(tmpdir(), 'dsh-rollover-package-'));
const output = path.join(root, 'out');
try {
    // 调用方已完成 build:check 和发布检查；这里禁用生命周期，确保检查同一份构建产物。
    const packed = JSON.parse((await run(process.execPath, [npm, 'pack', '--json', '--ignore-scripts', '--pack-destination', owned],
        {cwd: root, windowsHide: true, maxBuffer: 4 * 1024 * 1024})).stdout)[0];
    const archive = path.join(owned, path.basename(packed.filename));
    const install = path.join(owned, 'install');
    await fs.mkdir(install);
    await fs.writeFile(path.join(install, 'package.json'), '{"name":"dsh-rollover-package-check","private":true}\n');
    await run(process.execPath, [npm, 'install', archive, '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false'],
        {cwd: install, windowsHide: true, maxBuffer: 4 * 1024 * 1024});
    const installed = path.join(install, 'node_modules', 'dsh-session-rollover');
    const manifest = JSON.parse(await fs.readFile(path.join(installed, 'package.json'), 'utf8'));
    const entry = await import(pathToFileURL(path.join(installed, manifest.main)).href);
    assert.equal(entry.default, entry.SessionRolloverPlugin);
    assert.equal(typeof entry.default, 'function');
    const files = packed.files.map(file => file.path);
    for (const required of ['client.js', 'src/server/compatibility.mjs', 'compatibility/policy.json', 'docs/COMPATIBILITY.md']) {
        assert.ok(files.includes(required), `Missing packed resource: ${required}`);
    }
    // 从安装后的目录重新校验全部面板资源和 ModuleLoader，避免只检查源码目录。
    await run(process.execPath, [path.join(installed, 'scripts/check-release.mjs')], {cwd: installed, windowsHide: true});
    const bytes = await fs.readFile(archive);
    await fs.mkdir(output, {recursive: true});
    await fs.copyFile(archive, path.join(output, packed.filename));
    const report = {passed: true, level: 'isolated-package-install', runtimeVerified: false,
        checkedAt: new Date().toISOString(), platform: process.platform, node: process.version,
        name: manifest.name, version: manifest.version, files: files.length,
        sha256: createHash('sha256').update(bytes).digest('hex'), artifact: packed.filename};
    await fs.writeFile(path.join(output, 'package-verification.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(`Package PASS: ${manifest.name}@${manifest.version}; isolated install, exports, client and resources (${files.length} files).`);
} finally {
    if (path.dirname(path.resolve(owned)) !== path.resolve(tmpdir()) || !path.basename(owned).startsWith('dsh-rollover-package-')) {
        throw new Error('Refusing cleanup outside the owned temporary directory');
    }
    await fs.rm(owned, {recursive: true, force: true});
}
