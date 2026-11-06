import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync, unlinkSync, mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Plugin from '../../index.js';
import {fixture} from '../support/host.mjs';
import {countTurns} from '../../src/domain/turns.mjs';
import {handleSessionRequest} from '../../src/server/notice-route.mjs';

test('用户轮次不受内部 turn 数量影响，交接首条消息不占新卷轮次', () => {
    const {events} = fixture();
    for (const n of [9, 20]) assert.equal(countTurns([...events, ...Array.from({length: n}, () => ({type: 'turn/end'}))]), 10);
    assert.equal(countTurns([{type: 'user/message', data: {content: [{text: '【分卷交接】进入下一卷'}]}}]), 0);
    for (const kind of ['runtime-context', 'skill-catalog', 'time-context']) events.push({type: 'user/message', data: {source: {kind}, content: [{text: '宿主上下文'}]}});
    assert.equal(countTurns(events), 10, '真实宿主内部 user/message 不误计为用户发言');
});

test('第十条用户消息等待回合结束；结束事件后只分一次并发出完成事件', async () => {
    const env = fixture();
    env.events.push({type: 'turn/start', data: {turn: 17}});
    await env.run(); assert.equal(env.calls.create.length, 0);
    const end = {type: 'turn/end', data: {turn: 17}};
    env.events.push(end); env.handlers.get('session/event')(env.sessions.get('old'), end);
    await new Promise(resolve => setImmediate(resolve));
    await env.run();
    assert.equal(env.calls.create.length, 1);
    assert.equal(env.emitted.filter(e => e.name === 'rollover/completed').length, 1);
    assert.equal(env.plugin.handoffInfo('new-1').turnCount, 0);
});

test('宿主 system Handoff 不降级，用户外部分段标记仍降级', async () => {
    for (const type of ['system/message', 'user/message']) {
        const env = fixture();
        env.events.push({type, data: {content: [{text: '[Handoff · part 13] 搬运'}]}});
        await env.run();
        assert.equal(env.calls.create.length, type === 'system/message' ? 1 : 0);
    }
});

test('forceAuto 不绕过未结束压缩；压缩结束后同轮可继续分卷', async () => {
    const env = fixture({config: {forceAuto: true}});
    env.events.push({type: 'compaction/start', data: {turn: 10}});
    await env.run(); assert.equal(env.calls.create.length, 0);
    env.events.push({type: 'compaction/end', data: {turn: 10}});
    await env.run(); assert.equal(env.calls.create.length, 1);
});

test('人读摘要和 JSON 同刻继承全部 jobs、多 active、约束和文件', async () => {
    const env = fixture();
    env.events.push({type: 'job/registered', data: {jobId: 'bash-live', label: '后台采集'}},
        {type: 'job/registered', data: {jobId: 'finished'}}, {type: 'job/settled', data: {jobId: 'finished'}});
    env.ctx.jobs = {list: id => [{id: 'registry-live', owner: id, label: '生成截图', status: 'running'},
        {id: 'other', owner: 'another', status: 'running'}]};
    await env.run();
    const h = env.plugin.handoffInfo('new-1').handoff;
    assert.deepEqual(h.current_step.active_items, [2, 3]);
    assert.deepEqual(h.open_jobs.map(j => j.id).sort(), ['bash-live', 'registry-live']);
    assert.match(Object.values(h.summary).join('\n'), /bash-live/);
    assert.match(Object.values(h.summary).join('\n'), /registry-live/);
    assert.deepEqual(Object.keys(h.summary), ['上轮工作摘要', '当前进度与关键约束', '文件、代码与未竟事项', '下一步与待办快照']);
    assert.match(h.constraints[0], /必须保留巡检范围/);
    assert.equal(h.changed_files[0].path, 'src/a.mjs');
});

test('撞名影响名称、不影响真实卷序；手动标题保持原文', async () => {
    const env = fixture({source: 'user'});
    env.sessions.set('occupied', {id: 'occupied', title: '巡检-1', events: [], snapshotEvents() { return this.events; }});
    await env.run();
    assert.equal(env.sessions.get('old').title, '巡检');
    assert.equal(env.sessions.get('new-1').title, '巡检-2');
    assert.equal(env.plugin.handoffInfo('new-1').volume, 2);
    const ordinary = fixture();
    ordinary.sessions.set('occupied', {id: 'occupied', title: '巡检-2', events: [], snapshotEvents() { return this.events; }});
    await ordinary.run();
    assert.equal(ordinary.sessions.get('new-1').title, '巡检-3');
    assert.equal(ordinary.plugin.handoffInfo('new-1').volume, 2);
});

test('第9卷常驻状态及去重通知，显式换会话可建独立系列', async () => {
    const env = fixture({title: '巡检-9'});
    env.plugin.index.record({sessionId: 'old', clusterId: 'c', volNo: 9, nameSuffix: '-9'});
    await env.run();
    assert.equal(env.calls.create.length, 0);
    assert.equal(env.plugin.handoffInfo('old').capped, true);
    assert.deepEqual(env.plugin.notices.takePending('old').map(n => n.reason), ['cluster-cap']);
    const result = await env.ctx.sessionRollover.rollover('old');
    assert.equal(result.status, 'rolled-over');
    assert.equal(env.plugin.index.get(result.newSessionId).parent_session_id, null);
    assert.equal(env.plugin.handoffInfo(result.newSessionId).source, null);
});

test('重名后缀超过9仍按真实卷数接续，不嵌套名称', async () => {
    const env = fixture({title: '巡检-10'});
    env.plugin.index.record({sessionId: 'old', clusterId: 'c', volNo: 2, nameSuffix: '-10'});
    await env.run();
    assert.equal(env.sessions.get('new-1').title, '巡检-11');
    assert.equal(env.plugin.handoffInfo('new-1').volume, 3);
    const named = fixture({title: '业务-3', source: 'user'});
    await named.run();
    assert.equal(named.plugin.handoffInfo('new-1').volume, 2, '用户标题后缀不是实际已有卷数');
});

test('摘要初次失败+两次重试后停止，重启仍保持次数', async () => {
    const env = fixture({todos: [{content: '长'.repeat(20000), status: 'in_progress'}]});
    for (let n = 0; n < 4; n++) { await env.run(); env.events.push({type: 'user/message', text: '继续'}); }
    assert.equal(env.calls.create.length, 0);
    assert.equal(env.plugin.state.retryGet('old').attempts, 3);
    const reloaded = new Plugin(env.ctx, {dataDir: env.dir});
    await reloaded.maybeRollover({agent: {session: env.sessions.get('old')}});
    assert.equal(reloaded.handoffInfo('old').retryLimitReached, true);
    assert.equal(reloaded.state.retryGet('old').attempts, 3);
});

test('只读开关双向持久化，旧卷恢复写入后仍不能再次自动分卷', async () => {
    const env = fixture(); await env.run();
    env.plugin.setReadonly('old', false);
    const reloaded = new Plugin(env.ctx, {dataDir: env.dir});
    assert.equal(reloaded.handoffInfo('old').readonly, false);
    let entered = false;
    await reloaded.onPreStep({step: 1, agent: {session: env.sessions.get('old')}}, async () => { entered = true; });
    assert.equal(entered, true);
    reloaded.setReadonly('old', true);
    assert.equal((await reloaded.onPreStep({step: 1, agent: {session: env.sessions.get('old')}}, async () => {})).kind, 'reject');
    assert.equal(env.calls.create.length, 1);
});

test('索引丢失或损坏后依据快照重建来源和真实卷序，不吞掉恢复写入状态', async () => {
    for (const corrupt of [false, true]) {
        const env = fixture(); await env.run(); env.plugin.setReadonly('old', false);
        if (corrupt) writeFileSync(join(env.dir, 'cluster-index.json'), '{broken');
        else unlinkSync(join(env.dir, 'cluster-index.json'));
        const reloaded = new Plugin(env.ctx, {dataDir: env.dir});
        assert.equal(reloaded.handoffInfo('new-1').source.sessionId, 'old');
        assert.equal(reloaded.handoffInfo('new-1').volume, 2);
        assert.equal(reloaded.handoffInfo('old').readonly, false);
    }
});

test('模型继承失败后使用公开默认模型服务，并向新卷提示', async () => {
    const env = fixture();
    env.ctx.sessionController.selectModel = async pick => { env.calls.model.push(pick); if (pick.provider === 'original') throw new Error('unavailable'); };
    env.ctx.agentDefaultModel = {currentSelection: () => ({provider: 'default', model: 'fallback'})};
    await env.run();
    assert.equal(env.calls.model.at(-1).provider, 'default');
    assert.equal(env.calls.prompt.length, 1);
    assert.equal(env.plugin.notices.takePending('new-1')[0].reason, 'model-fallback');
});

test('索引合法但缺项也能恢复；废弃卷不能重建成有效分卷', async () => {
    const env = fixture(); await env.run(); env.plugin.setReadonly('old', false);
    const file = join(env.dir, 'cluster-index.json');
    const doc = JSON.parse(readFileSync(file, 'utf8'));
    delete doc.sessions['new-1']; writeFileSync(file, JSON.stringify(doc));
    const reloaded = new Plugin(env.ctx, {dataDir: env.dir});
    assert.equal(reloaded.handoffInfo('new-1').volume, 2);
    assert.equal(reloaded.handoffInfo('old').readonly, false);

    const failed = fixture();
    failed.ctx.sessionTitle.rename = () => { throw new Error('rename-failed'); };
    await failed.run();
    assert.equal(failed.plugin.state.pendingList().length, 1);
    const recovered = new Plugin(failed.ctx, {dataDir: failed.dir});
    assert.equal(recovered.handoffInfo('old').sealed, false);
    assert.equal(recovered.handoffInfo('new-1').volume, null);
});

test('提交后辅助状态写盘失败仍返回建卷成功并明确降级，不重复建卷', async () => {
    const env = fixture();
    const save = env.plugin.state.retrySave;
    env.plugin.state.retrySave = () => { throw new Error('disk-full-after-commit'); };
    await assert.doesNotReject(env.run);
    assert.equal(env.plugin.handoffInfo('old').sealed, true);
    assert.equal(env.plugin.handoffInfo('old').degraded, true);
    assert.equal(env.plugin.handoffInfo('new-1').degraded, true);
    assert.equal(env.plugin.lastCompleted.get('old'), 'new-1');
    env.plugin.state.retrySave = save;
    env.events.push({type: 'user/message', text: '继续'});
    await env.run();
    assert.equal(env.calls.create.length, 1);
});

test('内部上下文包含原生 Handoff 标记时不降级为手动', async () => {
    const env = fixture();
    env.events.push({type: 'user/message', data: {source: {kind: 'runtime-context'}, content: [{text: '[Handoff · part 2]'}]}});
    await env.run();
    assert.equal(env.calls.create.length, 1);
});

test('数据目录碰撞在创建会话前返回失败，不抛出第二次清理错误', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rollover-dir-file-'));
    const file = join(dir, 'file'); writeFileSync(file, 'occupied');
    const env = fixture({dir: file});
    await assert.doesNotReject(env.run);
    assert.equal(env.calls.create.length, 0);
    assert.equal(env.sessions.get('old').title, '巡检');
});

async function http(env, {method = 'GET', body, origin, principal = 'owner', id = 'old'} = {}) {
    env.ctx.connection.admit = () => principal ? {peer: {principal: {kind: principal}}} : {rejection: 401};
    const req = {method, url: `/?session=${id}`, headers: {'content-type': 'application/json', host: 'localhost', ...(origin ? {origin} : {})},
        async *[Symbol.asyncIterator]() { if (body !== undefined) yield JSON.stringify(body); }};
    const res = {writeHead(status) { this.status = status; }, end(data) { this.body = JSON.parse(data); }};
    await handleSessionRequest(env.plugin, req, res); return res;
}

test('会话接口拒绝未认证、非owner、跨源与非法会话参数', async () => {
    const env = fixture();
    assert.equal((await http(env, {principal: null})).status, 401);
    assert.equal((await http(env, {principal: 'guest'})).status, 403);
    assert.equal((await http(env, {id: '../outside'})).status, 400);
    assert.equal((await http(env, {method: 'POST', origin: 'http://evil', body: {sessionId: 'old', action: 'rollover'}})).status, 403);
    assert.equal(env.calls.create.length, 0);
});

test('owner可读取并修改归档只读状态；普通会话不能被任意封卷', async () => {
    const env = fixture(); await env.run();
    assert.equal((await http(env)).body.readonly, true);
    assert.equal((await http(env, {method: 'POST', body: {sessionId: 'old', action: 'readonly', readonly: false}})).body.readonly, false);
    assert.equal((await http(env, {method: 'POST', body: {sessionId: 'new-1', action: 'readonly', readonly: true}})).status, 409);
});
