import fs from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {registryJSON, publishedTargets, checkPackage} from './dsh-contracts.mjs';
const policy = JSON.parse(await fs.readFile(new URL('../compatibility/policy.json', import.meta.url), 'utf8'));
const args = process.argv.slice(2);
const list = args.includes('--list');
const target = args.find(value => !value.startsWith('--')) ?? 'latest';
const metadata = await registryJSON(policy.registry + encodeURIComponent(policy.package));
const versions = publishedTargets(metadata, policy.baseline);
if (!versions.length || versions.length > 200) throw new Error('DSH compatibility matrix requires baseline maintenance');
if (list) {
    // 超出 GitHub matrix 上限时明确失败，要求维护者调整基线，不静默漏掉新版本。
    console.log(JSON.stringify({version: versions}));
} else {
    const selected = target === 'all' ? versions : [metadata['dist-tags']?.[target] ?? target];
    const directory = await fs.mkdtemp(path.join(tmpdir(), 'dsh-contracts-'));
    const report = {level: 'public-declaration-smoke', runtimeVerified: false,
        checkedAt: new Date().toISOString(), baseline: policy.baseline, targets: []};
    try {
        for (const version of selected) {
            const results = [];
            for (const contract of policy.contracts) {
                try { results.push(await checkPackage(contract, version, policy, directory)); }
                catch (error) { results.push({package: contract.package, version, error: String(error.message)}); }
            }
            const passed = results.every(result => !result.error && !result.missing?.length);
            report.targets.push({version, passed, packages: results});
            console.log(`${version}: ${passed ? 'PASS' : 'FAIL'} (public declarations; not runtime verification)`);
            for (const result of results.filter(r => r.error || r.missing?.length)) console.error(JSON.stringify(result));
        }
        report.passed = report.targets.every(target => target.passed);
        const output = process.env.DSH_COMPATIBILITY_REPORT ?? path.resolve('out/dsh-compatibility.json');
        await fs.mkdir(path.dirname(output), {recursive: true});
        await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n');
        if (!report.passed) process.exitCode = 1;
    } finally {
        // 只删除 mkdtemp 创建并持有的独立目录。
        if (path.dirname(path.resolve(directory)) !== path.resolve(tmpdir()) || !path.basename(directory).startsWith('dsh-contracts-')) {
            throw new Error('Refusing cleanup outside the owned temporary directory');
        }
        await fs.rm(directory, {recursive: true, force: true});
    }
}
