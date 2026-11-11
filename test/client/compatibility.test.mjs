import test from 'node:test';
import assert from 'node:assert/strict';
import {createRolloverUI} from '../../src/client/rollover-ui.js';

test('缺失可选导航/输入服务时记录兼容提示，仍装载可用面板', () => {
    const originalDocument = globalThis.document;
    const originalWarn = console.warn;
    globalThis.document = {createElement: () => ({setAttribute() {}, remove() {}}), head: {appendChild() {}}};
    console.warn = () => {};
    try {
        const mounted = [];
        const scope = {uiWorkspace: {}, slots: {inject: (_name, setup) => setup(), register: (meta) => { mounted.push(meta.name); return () => {}; }},
            conversation: {}, uiConversation: {}, effect: setup => setup()};
        scope.inject = (_names, setup) => setup(scope);
        const ui = createRolloverUI({});
        assert.doesNotThrow(() => ui.apply(scope));
        assert.ok(mounted.includes('conversation.input.dock'));
        assert.ok(ui.clientWarnings.has('conversation'));
        assert.ok(ui.clientWarnings.has('uiWorkspace'));
    } finally { globalThis.document = originalDocument; console.warn = originalWarn; }
});
