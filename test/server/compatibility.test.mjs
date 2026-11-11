import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {fixture} from '../support/host.mjs';
import {handleSessionRequest} from '../../src/server/notice-route.mjs';
import Plugin from '../../index.js';

for (const method of ['create', 'prompt', 'selectModel']) {
    test(`宿主升级移除 ${method} 时，手动/自动分卷均不建卷、改名或消耗重试`, async () => {
        const f = fixture();
        delete f.ctx.sessionController[method];
        assert.equal(f.ctx.sessionRollover.compatibility().compatible, false);
        const manual = await f.plugin.rolloverNow('old');
        assert.equal(manual.reason, 'host-incompatible');
        await f.run(); await f.run();
        assert.equal(f.calls.create.length, 0);
        assert.equal(f.sessions.get('old').title, '巡检');
        assert.equal(f.plugin.index.get('old'), null);
        assert.equal(existsSync(join(f.dir, 'retry-old.json')), false);
        assert.deepEqual(f.plugin.notices.takePending('old').map(n => n.reason), ['host-incompatible']);
    });
}

test('宿主事件/工作区读取形状变化，停止分卷并保持可读取的诊断状态', async () => {
    for (const broken of ['events', 'workspace']) {
        const f = fixture();
        if (broken === 'events') f.sessions.get('old').snapshotEvents = () => ({events: []});
        else f.ctx.workspaceRegistry.list = () => [{id: 'changed', sessions: []}];
        const result = await f.plugin.rolloverNow('old');
        assert.equal(result.reason, 'host-incompatible');
        assert.equal(f.plugin.handoffInfo('old').compatibility.compatible, false);
        assert.equal(f.calls.create.length, 0);
    }
});

test('新版领域服务优先读取目录和活动模型，不调用弃用投影读取面', async () => {
    const f = fixture();
    f.ctx.workingDirectory = {get: () => 'D:/new-owner'};
    f.ctx.agents = {get: () => ({model: {current: () => ({provider: 'modern', model: 'selected'})}})};
    f.ctx.sessionProjections.stateOf = () => { throw new Error('deprecated projection called'); };
    const result = await f.plugin.rolloverNow('old');
    assert.equal(result.status, 'rolled-over');
    assert.deepEqual(f.calls.create, [{cwd: 'D:/new-owner'}]);
    assert.equal(f.calls.model[0].provider, 'modern');
    assert.equal(f.calls.model[0].model, 'selected');
});

test('未知模型结构不能静默回落默认模型；合法的空选择仍可建卷', async () => {
    for (const value of [{selected: {provider: 'changed', model: 'changed'}}, {lastUsed: {provider: 'incomplete'}}]) {
        const f = fixture();
        const read = f.ctx.sessionProjections.stateOf;
        f.ctx.sessionProjections.stateOf = (session, key) => key === 'modelSelection' ? value : read(session, key);
        assert.equal((await f.plugin.rolloverNow('old')).reason, 'host-incompatible');
        assert.equal(f.calls.create.length, 0);
    }
    const changed = fixture();
    changed.ctx.agents = {get: () => ({model: {current: () => ({selected: 'changed'})}})};
    assert.equal((await changed.plugin.rolloverNow('old')).reason, 'host-incompatible');
    assert.equal(changed.calls.create.length, 0);
    const empty = fixture();
    const read = empty.ctx.sessionProjections.stateOf;
    empty.ctx.sessionProjections.stateOf = (session, key) => key === 'modelSelection' ? {pending: null, lastUsed: null} : read(session, key);
    assert.equal((await empty.plugin.rolloverNow('old')).status, 'rolled-over');
});

test('宿主升级后仍拦截旧卷写入，已保存的交接与只读状态保持可读', async () => {
    const f = fixture(); await f.run();
    const before = f.plugin.handoffInfo('new-1').handoff;
    delete f.ctx.sessionController.prompt;
    let called = false;
    const result = await f.plugin.onPreStep({step: 1, agent: {session: f.sessions.get('old')}}, async () => { called = true; });
    assert.deepEqual(result, {kind: 'reject'}); assert.equal(called, false);
    assert.equal(f.plugin.handoffInfo('old').readonly, true);
    assert.deepEqual(f.plugin.handoffInfo('new-1').handoff, before);
});

test('升级后 sessions.list 改变结构，重启仍加载历史索引及归档写入拦截', async () => {
    const f = fixture(); await f.run();
    f.ctx.sessions.list = () => ({sessions: [...f.sessions.values()]});
    const restarted = new Plugin(f.ctx, {dataDir: f.dir});
    assert.equal(restarted.handoffInfo('old').readonly, true);
    assert.equal(restarted.handoffInfo('old').compatibility.compatible, false);
    assert.equal(restarted.handoffInfo('new-1').handoff.from_session_id, 'old');
    assert.deepEqual(await restarted.onPreStep({step: 1, agent: {session: f.sessions.get('old')}}, () => assert.fail('must block')), {kind: 'reject'});
    assert.equal((await restarted.rolloverNow('new-1')).reason, 'host-incompatible');
    assert.equal(f.calls.create.length, 1);
});

test('不兼容时 owner 的建卷 HTTP 操作返回 503，不调用宿主创建接口', async () => {
    const f = fixture(); delete f.ctx.sessionController.prompt;
    for (const action of ['new', 'rollover']) {
        const req = Readable.from([JSON.stringify({sessionId: 'old', action})]);
        Object.assign(req, {method: 'POST', url: '/api-dsh-session-rollover/session', headers: {'content-type': 'application/json', host: 'localhost'}});
        let code, body;
        await handleSessionRequest(f.plugin, req, {writeHead: status => {code = status;}, end: value => {body = JSON.parse(value);}});
        assert.equal(code, 503); assert.equal(body.error, 'host-incompatible');
    }
    assert.equal(f.calls.create.length, 0);
});
