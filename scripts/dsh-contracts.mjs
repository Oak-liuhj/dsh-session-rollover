/** 检查 npm 公共声明中的依赖面；不执行上游包，不把声明扫描当作真实宿主验收。 */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
const run = promisify(execFile);

export async function registryJSON(url) {
    const response = await fetch(url, {signal: AbortSignal.timeout(30000)});
    assert.equal(response.status, 200, `Registry unavailable: ${url} (${response.status})`);
    return response.json();
}

/** 按官方发布时刻枚举基线之后的每个版本，包含 alpha/rc 和后续补丁。 */
export function publishedTargets(metadata, baseline) {
    const since = Date.parse(metadata.time?.[baseline]);
    assert.ok(Number.isFinite(since), 'Missing baseline publication time');
    const versions = Object.keys(metadata.versions ?? {});
    assert.ok(versions.includes(baseline), 'Missing baseline package version');
    for (const version of versions) {
        assert.match(version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);
        assert.ok(Number.isFinite(Date.parse(metadata.time?.[version])), `Missing publication time: ${version}`);
    }
    return versions.filter(version => Date.parse(metadata.time?.[version]) >= since)
        .sort((a, b) => Date.parse(metadata.time[a]) - Date.parse(metadata.time[b]));
}

export function inspectDeclarations(text, contract) {
    // 去除注释，避免已删除的方法只在弃用说明中出现时误判通过。
    const source = text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, '');
    const missing = [];
    for (const method of contract.methods ?? []) {
        assert.match(method, /^\w+$/);
        if (!new RegExp(`\\b${method}\\s*(?:<[^;{}]*?>\\s*)?\\(`).test(source)) missing.push(method + '()');
    }
    for (const token of contract.tokens ?? []) if (!source.includes(token)) missing.push(token);
    for (const group of contract.alternatives ?? []) {
        if (!group.some(token => source.includes(token))) missing.push(group.join(' | '));
    }
    return missing;
}

export async function checkPackage(contract, version, policy, directory) {
    const metadata = await registryJSON(policy.registry + encodeURIComponent(contract.package) + '/' + encodeURIComponent(version));
    assert.equal(metadata.version, version);
    assert.equal(new URL(metadata.dist.tarball).hostname, new URL(policy.registry).hostname);
    assert.match(metadata.dist.integrity, /^sha512-[A-Za-z0-9+/=]+$/);
    const response = await fetch(metadata.dist.tarball, {signal: AbortSignal.timeout(30000)});
    assert.equal(response.status, 200);
    const archive = Buffer.from(await response.arrayBuffer());
    assert.equal('sha512-' + createHash('sha512').update(archive).digest('base64'), metadata.dist.integrity);
    const file = path.join(directory, contract.package.replace(/[^\w-]/g, '_') + '.tgz');
    await fs.writeFile(file, archive);
    const {stdout} = await run('tar', ['-tzf', file], {windowsHide: true, maxBuffer: 4 * 1024 * 1024});
    const declarations = stdout.split(/\r?\n/).filter(name => /^package\/lib\/.*\.d\.ts$/.test(name));
    assert.ok(declarations.length > 0, 'Missing public type declarations');
    let text = '';
    for (let offset = 0; offset < declarations.length; offset += 40) {
        const names = declarations.slice(offset, offset + 40);
        assert.ok(names.every(name => !name.split('/').includes('..') && !name.includes('\\')));
        // 只读 tar stdout，不把上游归档解压到任何宿主目录。
        text += (await run('tar', ['-xOf', file, ...names], {windowsHide: true, maxBuffer: 16 * 1024 * 1024})).stdout + '\n';
    }
    return {package: contract.package, version, integrity: metadata.dist.integrity,
        declarations: declarations.length,
        missing: inspectDeclarations(text, {...contract, ...contract.versionOverrides?.[version]})};
}
