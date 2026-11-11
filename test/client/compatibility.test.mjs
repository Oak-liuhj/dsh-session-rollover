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

test('宿主热替换 uiConversation 时先释放旧交接插槽，重新注入不会重复注册', () => {
    const documentBefore = globalThis.document;
    globalThis.document = {createElement: () => ({setAttribute() {}, remove() {}}), head: {appendChild() {}}};
    try {
        const active = new Set();
        const registrations = [];
        let textScope, reinject;
        const root = {
            slots: {inject: (_name, setup) => setup(), register(meta) {
                const key = `${meta.name}:${meta.key ?? meta.id}`;
                assert.equal(active.has(key), false, `duplicate slot: ${key}`);
                active.add(key); registrations.push(key);
                return () => active.delete(key);
            }},
            uiWorkspace: {openSession() {}},
            conversation: {blocks: {storeFor() {}, set() {}}},
            uiConversation: {userText: {register: () => () => {}}},
        };
        function scope(parent) {
            const child = Object.create(parent);
            const disposers = [];
            child.effect = setup => { const off = setup(); disposers.push(off); return off; };
            child.dispose = () => { for (const off of disposers.reverse()) off?.(); };
            child.inject = (names, setup) => {
                const start = () => { const nested = scope(child); setup(nested); return nested; };
                const nested = start();
                if (names[0] === 'uiConversation') { textScope = nested; reinject = start; }
            };
            return child;
        }
        const ui = createRolloverUI({});
        ui.apply(scope(root));
        const key = 'conversation.user.text.node:dsr-handoff';
        assert.ok(active.has(key));
        textScope.dispose();
        assert.equal(active.has(key), false);
        textScope = reinject();
        assert.ok(active.has(key));
        assert.equal(registrations.filter(value => value === key).length, 2);
        assert.equal(ui.clientWarnings.size, 0);
        textScope.dispose();
    } finally { globalThis.document = documentBefore; }
});
