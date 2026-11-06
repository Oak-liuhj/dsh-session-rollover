// 接线冒烟：真 index.js（插件类）+ 假 ctx/channel，验证 pre-step 到事务的整条路、改名只走 sessionTitle.rename
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Plugin from '../../index.js';

function createCtx({ turns = 10, todos }) {
  const events = Array.from({ length: turns }, (_, i) => ({ kind: 'user/message', text: i === 0 ? '把网关重构成可灰度路由，不许加第三方依赖' : `第 ${i + 1} 轮：继续做路由` }));
  if (todos) events.push({ kind: 'todo/write', data: { todos } }); // 真机形状：待办从日志最后一条 todo/write 取
  events.push({ kind: 'tool/call', data: { callId: 'c1', name: 'read', arguments: '{"path":"src/gateway.mjs"}' } });
  events.push({ kind: 'tool/result', data: { callId: 'c1' } });
  const sessions = new Map();
  const notices = [];
  const session = { id: 's1', title: '网关重构', header: {}, snapshotEvents: () => events, append: (kind, payload, opts) => notices.push({ kind, ...payload, opts }) };
  sessions.set('s1', session);
  const calls = { rename: [], prompt: [], create: 0, events: [] };
  let seq = 0;
  const ctx = {
    provide: (name, service) => { ctx[name] = service; },
    workspaceRegistry: {list: () => []},
    sessions: { get: (id) => sessions.get(id) ?? null, list: () => [...sessions.values()] },
    sessionTitle: {
      get: (s) => (s.title ? { title: s.title } : undefined),
      rename: (s, title) => { calls.rename.push({ id: s.id, title }); s.title = title; },
    },
    sessionController: {
      create: async () => { calls.create += 1; seq += 1; const s = { id: `s-new-${seq}`, header: {}, snapshotEvents: () => [] }; sessions.set(s.id, s); return { sessionId: s.id }; },
      // 工程约定：假宿主必须与真宿主同形 —— data.content=[{type:'text',text}]，
      // 禁止再用扁平 {text}；夹具形状失真等于没测（eventsToMessages 恒 false 的一课）。
      prompt: async (req) => { calls.prompt.push(req); const s = sessions.get(req.sessionId); s.events = [{ kind: 'user/message', data: { content: [{ type: 'text', text: req.content[0].text }] } }]; s.snapshotEvents = () => s.events; },
    },
    sessionProjections: { stateOf: () => todos },
    on: (name, fn) => { calls.events.push(name); },
    effect: () => {},
    logger: () => ({ info: () => {} }),
  };
  return { ctx, calls, sessions, session, notices };
}

const TODOS = [
  { content: '登录改造', status: 'completed' },
  { content: '网关路由', status: 'in_progress' },
  { content: '回归测试', status: 'pending' },
];

for (const withWorkspace of [true, false]) {
  test(`接线：新卷继承${withWorkspace ? '工作区' : '工作目录'}，并在注入前继承模型`, async () => {
    const {ctx, calls} = createCtx({turns: 1, todos: TODOS});
    const cwd = 'D:/work/rollover-fixture';
    ctx.workspaceRegistry.list = () => withWorkspace ? [{id: 'workspace-1', sessionIds: ['s1']}] : [];
    ctx.sessionProjections.stateOf = (_session, name) => name === 'workingDirectory'
      ? cwd : {pending: {provider: 'fixture-provider', model: 'fixture-model', reasoningEffort: 'high'}};
    const create = ctx.sessionController.create;
    ctx.sessionController.create = async (options) => {
      calls.createOptions = options;
      return create(options);
    };
    const sequence = [];
    ctx.sessionController.selectModel = async (selection) => {
      sequence.push('model');
      calls.model = selection;
    };
    const prompt = ctx.sessionController.prompt;
    ctx.sessionController.prompt = async (request, signal) => {
      sequence.push('prompt');
      assert.equal(signal.aborted, false);
      return prompt(request, signal);
    };
    new Plugin(ctx, {dataDir: mkdtempSync(join(tmpdir(), 'rollover-inherit-')), mode: 'manual'});
    const result = await ctx.sessionRollover.rollover('s1');
    assert.equal(result.status, 'rolled-over');
    assert.deepEqual(calls.createOptions, withWorkspace ? {workspaceId: 'workspace-1'} : {cwd});
    assert.deepEqual(calls.model, {
      sessionId: result.newSessionId, provider: 'fixture-provider',
      model: 'fixture-model', reasoningEffort: 'high',
    });
    assert.deepEqual(sequence, ['model', 'prompt']);
  });
}

test('接线：新卷明确清空待办后，下一次手动交接不恢复继承清单', async () => {
  const {ctx, sessions} = createCtx({turns: 1, todos: TODOS});
  const plugin = new Plugin(ctx, {dataDir: mkdtempSync(join(tmpdir(), 'rollover-cleared-')), mode: 'manual'});
  const first = await ctx.sessionRollover.rollover('s1');
  assert.equal(first.status, 'rolled-over');
  sessions.get(first.newSessionId).events.push({type: 'todo/write', data: {todos: []}});
  const second = await ctx.sessionRollover.rollover(first.newSessionId);
  assert.equal(second.status, 'rolled-over');
  assert.deepEqual(plugin.state.handoffGet(second.newSessionId).todos, []);
});

test('manual shared service retains inherited todos through a second handoff and keeps the parent chain', async () => {
  const {ctx, sessions} = createCtx({turns: 1, todos: TODOS});
  const plugin = new Plugin(ctx, {dataDir: mkdtempSync(join(tmpdir(), 'rollover-manual-')), mode: 'manual'});
  const first = await ctx.sessionRollover.rollover('s1');
  assert.equal(first.status, 'rolled-over');
  assert.equal(plugin.handoffInfo(first.newSessionId).source.sessionId, 's1');
  const second = await ctx.sessionRollover.rollover(first.newSessionId);
  assert.equal(second.status, 'rolled-over');
  const snapshot = plugin.state.handoffGet(second.newSessionId);
  assert.deepEqual(snapshot.todos, TODOS);
  assert.equal(plugin.index.get(first.newSessionId).parent_session_id, 's1');
  assert.equal(plugin.index.get(second.newSessionId).parent_session_id, first.newSessionId);
});

test('接线：10 轮 + 无 in-flight → 建未定名会话、注入、旧卷 -1、新卷 -2、索引落盘', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rollover-wire-'));
  const { ctx, calls, sessions } = createCtx({ todos: TODOS });
  const plugin = new Plugin(ctx, { dataDir: dir, threshold: 10 });
  // 分卷成功一次即清该会话去重键（B6 补条）
  plugin.notices.queue('s1', 'failed', '旧告警');
  await plugin.maybeRollover({ agent: { session: sessions.get('s1') } });
  assert.equal(plugin.notices.snapshot().dedupe['s1|failed'], undefined, '成功分卷后去重键已清');
  assert.deepEqual(plugin.notices.takePending('s1').map(n => n.reason), ['completed'], '清旧告警后只保留成功提示');

  assert.deepEqual(calls.rename.map((r) => `${r.id}→${r.title}`), ['s1→网关重构-1', 's-new-1→网关重构-2']);
  assert.equal(calls.prompt.length, 1, '注入一次');
  assert.equal(calls.prompt[0].sessionId, 's-new-1');
  assert.match(calls.prompt[0].content[0].text, /## 1\. 上轮工作摘要/);
  assert.match(calls.prompt[0].content[0].text, /第 2 步进行中：网关路由/);
  assert.match(calls.prompt[0].content[0].text, /src\/gateway\.mjs/);
  assert.doesNotMatch(calls.prompt[0].content[0].text, /\[(Checkpoint \d+|Handoff(?: · part)? \d+)\]/);

  const doc = JSON.parse(readFileSync(join(dir, 'cluster-index.json'), 'utf8'));
  assert.equal(doc.sessions.s1.rollover_state, 'sealed');
  assert.equal(doc.sessions['s-new-1'].parent_session_id, 's1');
  assert.equal(doc.turn_counts.s1, 10);
});

test('接线：in-flight 工具未收尾 → 整个事务零副作用（连会话都不建）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rollover-wire2-'));
  const { ctx, calls, sessions } = createCtx({ todos: TODOS });
  sessions.get('s1').snapshotEvents = () => {
    const base = Array.from({ length: 10 }, (_, i) => ({ kind: 'user/message', text: `第 ${i + 1} 轮` }));
    return [...base, { kind: 'tool/call', data: { callId: 'still-running', name: 'bash' } }];
  };
  const plugin = new Plugin(ctx, { dataDir: dir, threshold: 10 });
  await plugin.maybeRollover({ agent: { session: sessions.get('s1') } });
  assert.equal(calls.create, 0);
  assert.equal(calls.prompt.length, 0);
  assert.equal(calls.rename.length, 0);
});

test('接线：mode=off → 零副作用', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rollover-wire3-'));
  const { ctx, calls, sessions } = createCtx({ todos: TODOS });
  const plugin = new Plugin(ctx, { dataDir: dir, mode: 'off' });
  await plugin.maybeRollover({ agent: { session: sessions.get('s1') } });
  assert.equal(calls.create, 0);
  assert.equal(calls.rename.length, 0);
});
test('接线：已封卷 -1 永不再分卷（手动开关只放行继续写，不另开新卷）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rollover-wire4-'));
  const { ctx, calls, sessions } = createCtx({ todos: TODOS });
  const plugin = new Plugin(ctx, { dataDir: dir, threshold: 10 });
  plugin.index.record({ sessionId: 's1', clusterId: 'cluster:x', parentSessionId: null, volNo: 1, nameSuffix: '-1', rolloverState: 'sealed', readonlyByRollover: true });
  await plugin.maybeRollover({ agent: { session: sessions.get('s1') } });
  assert.equal(calls.create, 0, '不再建卷');
  assert.equal(calls.prompt.length, 0, '不再注入');
  assert.equal(calls.rename.length, 0, '不改名');
});

test('接线 B6：manual 到阈值只入队一次（同会话同原因去重，连跑两轮不刷屏，不 append 会话）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rollover-wire5-'));
  const { ctx, sessions, notices } = createCtx({ todos: TODOS });
  const plugin = new Plugin(ctx, { dataDir: dir, threshold: 10, mode: 'manual' });
  await plugin.maybeRollover({ agent: { session: sessions.get('s1') } });
  await plugin.maybeRollover({ agent: { session: sessions.get('s1') } });
  assert.equal(notices.length, 0, 'server 侧不再 append system/message（v4 实测不渲染不落盘）');
  const doc = JSON.parse(readFileSync(join(dir, 'notices.json'), 'utf8'));
  assert.equal(doc.pending.s1[0].text, '已到分卷阈值：manual 模式下自动分卷已暂停，可手动发起分卷。');
  assert.equal(plugin.notices.takePending('s1').length, 1, '同因只入队一次');
  assert.equal(plugin.notices.snapshot().dedupe['s1|manual-pending'] !== undefined, true, '去重键落盘');
});

test('接线 B6：client 取件口只投一次，且按会话隔离', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rollover-wire6-'));
  const { ctx, sessions } = createCtx({ todos: TODOS });
  const routes = [];
  ctx.inject = (deps, cb) => { cb({ webServer: { register: (r) => { routes.push(r); return () => {}; } }, effect: () => {} }); };
  const plugin = new Plugin(ctx, { dataDir: dir, threshold: 10, mode: 'manual' });
  await plugin.maybeRollover({ agent: { session: sessions.get('s1') } });

  assert.equal(routes.length, 2, '提示与 owner 会话控制分别注册');
  assert.equal(routes[0].path, '/api-dsh-session-rollover/pending');
  const get = (url) => {
    const res = { code: 0, headers: {}, body: '', writeHead(c, h) { this.code = c; this.headers = h; }, end(b) { this.body = b; } };
    routes[0].handler({ method: 'GET', url }, res);
    return { code: res.code, body: JSON.parse(res.body) };
  };
  const first = get('/api-dsh-session-rollover/pending?session=s1');
  assert.equal(first.code, 200);
  assert.equal(first.body.notices.length, 1);
  assert.equal(first.body.notices[0].reason, 'manual-pending');
  const second = get('/api-dsh-session-rollover/pending?session=s1');
  assert.equal(second.body.notices.length, 0, '取走一次＝投递一次');
  assert.equal(get('/api-dsh-session-rollover/pending').code, 400, '缺 session 拒绝');
});
