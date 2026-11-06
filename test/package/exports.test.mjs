// 从包公开子路径导入，验证重构后原有消费者仍能获得同一份导出。
import {test} from 'node:test';
import assert from 'node:assert/strict';
import Plugin, {SessionRolloverPlugin} from '@deepseek-ai/dsh-session-rollover';
import Implementation from '../../src/server/plugin.mjs';

test('包主入口保留默认与具名插件类导出', () => {
    assert.equal(Plugin, Implementation);
    assert.equal(SessionRolloverPlugin, Implementation);
});

const legacyModules = {
    turns: ['domain/turns'],
    mode: ['domain/mode'],
    naming: ['domain/naming'],
    todos: ['domain/todos'],
    inflight: ['domain/inflight'],
    summary: ['domain/summary'],
    handoff: ['domain/handoff'],
    notices: ['storage/notices'],
    cluster: ['domain/cluster-index', 'storage/index-store'],
    assembly: ['application/rollover', 'application/handoff-message', 'storage/rollover-state'],
};

for (const [legacy, targets] of Object.entries(legacyModules)) {
    test(`旧子路径 src/${legacy}.mjs 保持导出兼容`, async () => {
        const actual = await import(`@deepseek-ai/dsh-session-rollover/src/${legacy}.mjs`);
        const expected = Object.assign({}, ...await Promise.all(targets.map(
            (target) => import(`@deepseek-ai/dsh-session-rollover/src/${target}.mjs`),
        )));
        assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort());
        for (const name of Object.keys(expected)) assert.equal(actual[name], expected[name], name);
    });
}
