import test from 'node:test';
import assert from 'node:assert/strict';
import {createRolloverUI} from '../../src/client/rollover-ui.js';

test('归档输入阻塞与其他插件共存，解除/卸载时恢复最新外部原因并移除订阅', () => {
    let value = {reason: '请选择模型'};
    const listeners = new Set();
    const store = {getSnapshot: () => value, subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); }};
    const blocks = {storeFor: () => store, set: (_id, next) => {
        if (value?.reason === next?.reason) return;
        value = next; for (const fn of listeners) fn();
    }};
    const {blockComposer} = createRolloverUI({});
    const release = blockComposer(blocks, 'archived', '归档只读');
    assert.equal(value.reason, '归档只读');
    blocks.set('archived', {reason: '模型不可用'});
    assert.equal(value.reason, '归档只读');
    release();
    assert.equal(value.reason, '模型不可用');
    assert.equal(listeners.size, 0);
    blocks.set('archived', undefined);
    const unmount = blockComposer(blocks, 'archived', '归档只读');
    unmount();
    assert.equal(value, undefined);
    assert.equal(listeners.size, 0);
});
