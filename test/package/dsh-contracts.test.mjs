import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectDeclarations, publishedTargets} from '../../scripts/dsh-contracts.mjs';

test('升级目标覆盖基线之后每个正式、预发布和补丁版本，排除更早版本', () => {
    const versions = ['0.2.0', '0.2.1-rc.5', '0.2.2-alpha.3', '0.2.2-rc.1', '0.2.1'];
    const metadata = {versions: Object.fromEntries(versions.map(v => [v, {}])), time: Object.fromEntries(versions.map((v, i) => [v, new Date(1000 * i).toISOString()]))};
    assert.deepEqual(publishedTargets(metadata, '0.2.1-rc.5'), versions.slice(1));
    assert.throws(() => publishedTargets(metadata, 'missing'), /baseline/);
    delete metadata.time['0.2.2-alpha.3'];
    assert.throws(() => publishedTargets(metadata, '0.2.1-rc.5'), /Missing publication time/);
});

test('已移除接口不能只靠注释通过；声明检查能指出缺失方法和替代插槽', () => {
    const rule = {methods: ['prompt', 'create'], alternatives: [['new.slot', 'old.slot']]};
    assert.deepEqual(inspectDeclarations('/** prompt(request): void */ create(): void; "old.slot"', rule), ['prompt()']);
    assert.deepEqual(inspectDeclarations('prompt<T>(request: T): void; create(): void; "new.slot"', rule), []);
    assert.deepEqual(inspectDeclarations('prompt(): void; create(): void;', rule), ['new.slot | old.slot']);
});
