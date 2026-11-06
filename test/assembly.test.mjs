// S5 / S10 / S11 夹具真跑，不靠纸面断言。宿主用接口等价的内存实现，事务走真 src/assembly.mjs。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performRollover, createRolloverState, eventsToMessages, PENDING_FILE, readonlyFileOf } from '../src/assembly.mjs';
import { createClusterIndex, attachFilePersistence } from '../src/cluster.mjs';
import { planVolumeTitles } from '../src/naming.mjs';

const NOW = () => '2026-11-05T12:00:00.000Z';

function createFixtureHost({
  sessionId = 's-old', title = '网关重构', turns = 10,
  todos = [
    { content: '登录改造', status: 'completed' },
    { content: '令牌刷新', status: 'completed' },
    { content: '网关路由', status: 'in_progress' },
    { content: '回归测试', status: 'pending' },
  ],
  preexisting = [], inFlight = [], isSubagent = false, jobs = [],
  injectThrows = false, createThrows = false, renameThrowsFor = null,
} = {}) {
  const titles = new Map([[sessionId, title], ...preexisting.map((p) => [p.sessionId, p.title])]);
  const events = new Map([[sessionId, Array.from({ length: turns }, (_, i) => ({ kind: 'user/message', text: `第 ${i + 1} 轮` }))]]);
  const calls = [];
  let seq = 0;
  const host = {
    calls, titles, events,
    async listEvents(id) { return events.get(id) ?? []; },
    async getTitle(id) { return titles.get(id) ?? ''; },
    async listTitles() { return [...titles].map(([id, t]) => ({ sessionId: id, title: t })); },
    async getTodos() { return todos; },
    async inFlightTools() { return inFlight; },
    async isSubagent() { return isSubagent; },
    async listRunningJobs() { return jobs; },
    async createSession() {
      if (createThrows) { calls.push({ op: 'create', ok: false }); throw new Error('create rejected'); }
      seq += 1;
      const id = `s-new-${seq}`;
      titles.set(id, '');
      events.set(id, []);
      calls.push({ op: 'create', id });
      return { sessionId: id };
    },
    async injectFirstMessage(id, text) {
      calls.push({ op: 'inject', id, bytes: text.length });
      if (injectThrows) throw new Error('prompt admission failed');
      events.get(id).push({ kind: 'user/message', text });
    },
    async renameSession(id, next) {
      calls.push({ op: 'rename', id, to: next });
      if (renameThrowsFor === id) throw new Error('rename rejected');
      titles.set(id, next);
    },
    log(ev, data) { calls.push({ op: 'log', ev, data }); },
  };
  return host;
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'rollover-s-'));
  const index = createClusterIndex();
  const persistence = attachFilePersistence(index, dir);
  const state = createRolloverState(dir);
  return { dir, index, persistence, state };
}

const SUMMARY = [
  ['任务目标', '把网关重构成可灰度路由'],
  ['已完成', '登录改造、令牌刷新'],
  ['进行中', '网关路由'],
  ['下一步', '回归测试'],
  ['约束', '不加第三方依赖'],
  ['已知问题', '暂无'],
  ['在跑任务', '无'],
  ['改动文件', 'src/gateway.mjs'],
];

test('S10：预建同名 -1 时旧卷递增到第一空位、新卷接下一个空位、全簇标题唯一', async () => {
  const host = createFixtureHost({
    preexisting: [{ sessionId: 's-extra', title: '网关重构-1' }],
    todos: [{ content: '路由表', status: 'in_progress' }, { content: '回归', status: 'pending' }],
    jobs: [{ id: 'job-7', command: 'npm test', status: 'running', recoverable: false }],
  });
  const { dir, index, persistence, state } = setup();
  const res = await performRollover({
    host, sessionId: 's-old', index, persistence, state,
    summarySegments: SUMMARY, currentStepIndex: 1, activeIndexes: [1],
    constraints: ['不加第三方依赖'], changedFiles: [{ path: 'src/gateway.mjs' }], now: NOW,
  });

  assert.equal(res.status, 'rolled-over', JSON.stringify(res));
  assert.equal(res.from.title, '网关重构-2', '旧卷取第一空位');
  assert.equal(res.to.title, '网关重构-3', '新卷接下一个空位');
  assert.equal(host.titles.get('s-extra'), '网关重构-1', '预建同名会话不被改写');

  const titles = [...host.titles.values()].filter(Boolean);
  assert.equal(new Set(titles).size, titles.length, '全簇标题无重复: ' + titles.join(','));

  // B7 递增要留日志
  const t6 = res.trace.find((t) => t.step === 'T6');
  assert.equal(t6.bumped, true);
  assert.ok(host.calls.some((c) => c.op === 'log' && c.ev === 'rollover:T6'));

  // T8 提交：簇索引 + turn_counts 同文件同原子，旧卷只读标记落盘
  const idxOnDisk = JSON.parse(readFileSync(join(dir, 'cluster-index.json'), 'utf8'));
  assert.equal(idxOnDisk.sessions['s-old'].name_suffix, '-2');
  assert.equal(idxOnDisk.sessions['s-old'].readonly_by_rollover, true);
  assert.equal(idxOnDisk.sessions['s-new-1'].parent_session_id, 's-old');
  assert.equal(idxOnDisk.sessions['s-new-1'].vol_no, 3);
  assert.equal(idxOnDisk.turn_counts['s-old'], 10);
  assert.equal(idxOnDisk.turn_counts['s-new-1'], 0);
  const ro = JSON.parse(readFileSync(readonlyFileOf(dir, 's-old'), 'utf8'));
  assert.equal(ro.rolledInto, 's-new-1');
  assert.equal(ro.readonly, true);

  // 注入正文落到新会话首条 user/message，且不带分段标记（否则下轮 auto 会误降级）
  const injected = host.events.get('s-new-1')[0].text;
  assert.match(injected, /第 1 步进行中/);
  assert.match(injected, /cluster_id: cluster:网关重构/);
  assert.doesNotMatch(injected, /\[(Checkpoint \d+|Handoff(?: · part)? \d+)\]/);
});

test('S11：T5 注入失败 → 弃未定名卷挂待清理，旧卷零变化、无 -2、索引与只读标记都不落盘', async () => {
  const host = createFixtureHost({ injectThrows: true, preexisting: [{ sessionId: 's-extra', title: '网关重构-1' }] });
  const before = JSON.stringify(host.events.get('s-old'));
  const { dir, index, persistence, state } = setup();
  const res = await performRollover({
    host, sessionId: 's-old', index, persistence, state, summarySegments: SUMMARY, now: NOW,
  });

  assert.equal(res.status, 'failed');
  assert.equal(res.reason, 'inject-failed');
  assert.equal(host.titles.get('s-old'), '网关重构', '旧卷标题一字未动');
  assert.equal(JSON.stringify(host.events.get('s-old')), before, '旧卷事件流一字未动');
  assert.equal(host.calls.filter((c) => c.op === 'rename').length, 0, '注入失败不得发生任何改名');
  assert.equal(host.titles.get('s-new-1'), '', '新会话保持未定名（绝不出现名字叫 -2、摘要是空的）');
  assert.deepEqual([...host.titles.values()].filter((t) => /-2$/.test(t)), [], '无 -2 卷');
  assert.equal(existsSync(join(dir, 'cluster-index.json')), false, '中途失败不落簇索引');
  assert.equal(existsSync(readonlyFileOf(dir, 's-old')), false, '中途失败不置只读');

  const pending = JSON.parse(readFileSync(join(dir, PENDING_FILE), 'utf8'));
  assert.equal(pending['s-new-1'].kind, 'abandoned-untitled');
  assert.equal(pending['s-new-1'].reason, 'inject-failed');
  assert.equal(index.serialize().includes('s-new-1'), false, '内存索引也未半提交');
});

test('S5：T4 新建失败 → 四无（无注入/无改名/无索引/无只读）', async () => {
  const host = createFixtureHost({ createThrows: true });
  const before = JSON.stringify(host.events.get('s-old'));
  const { dir, index, persistence, state } = setup();
  const res = await performRollover({ host, sessionId: 's-old', index, persistence, state, summarySegments: SUMMARY, now: NOW });

  assert.equal(res.status, 'failed');
  assert.equal(res.reason, 'create-failed');
  assert.equal(host.calls.filter((c) => c.op === 'inject').length, 0);
  assert.equal(host.calls.filter((c) => c.op === 'rename').length, 0);
  assert.equal(existsSync(join(dir, 'cluster-index.json')), false);
  assert.equal(existsSync(readonlyFileOf(dir, 's-old')), false);
  assert.equal(existsSync(join(dir, PENDING_FILE)), false);
  assert.equal(host.titles.get('s-old'), '网关重构');
  assert.equal(JSON.stringify(host.events.get('s-old')), before);
});

test('S6 前置：连跑三次只追加 -3，-1/-2 标题不被改写', async () => {
  const titles = new Map([['v1', '网关重构-1'], ['v2', '网关重构-2']]);
  const plan = planVolumeTitles('网关重构-2', [...titles.values()]);
  assert.equal(plan.ok, true);
  assert.equal(plan.oldTarget, null, '已是卷的旧会话不改名');
  assert.equal(plan.newTarget, '网关重构-3');
  const full = planVolumeTitles('网关重构-2', [...titles.values(), '网关重构-3']);
  assert.equal(full.newTarget, '网关重构-4');
});

test('命名预演：-9 封顶与用户改名分别返回零副作用原因', () => {
  const cap = planVolumeTitles('网关重构-9', ['网关重构-9']);
  assert.deepEqual([cap.ok, cap.reason], [false, 'cluster-cap']);
  const user = planVolumeTitles('网关重构', [], { userRenamed: true });
  assert.deepEqual([user.ok, user.reason], [false, 'user-renamed']);
});
test('B9 手动开关：readonly-<sid>.json 改 readonly:false 后放行，改回 true 再拦', async () => {
  const host = createFixtureHost();
  const { dir, index, persistence, state } = setup();
  const res = await performRollover({ host, sessionId: 's-old', index, persistence, state, summarySegments: SUMMARY, now: NOW });
  assert.equal(res.status, 'rolled-over');
  assert.equal(state.isReadonly('s-old'), true, '默认只读');
  const p = readonlyFileOf(dir, 's-old');
  const rec = JSON.parse(readFileSync(p, 'utf8'));
  writeFileSync(p, JSON.stringify({ ...rec, readonly: false }));
  assert.equal(state.isReadonly('s-old'), false, '手动开关放行');
  writeFileSync(p, JSON.stringify({ ...rec, readonly: true }));
  assert.equal(state.isReadonly('s-old'), true, '关回去再拦');
});

// 回归（实机缺陷）：宿主真实事件把正文放 data.content[].text，
// 旧实现只读 e.text / e.data.text → markers 恒 false，auto 降级分支在真机从未生效。
const hostShapedTurns = (markerAt = -1) => Array.from({ length: 10 }, (_, i) => ({
  type: 'user/message',
  data: { content: [{ type: 'text', text: i === markerAt ? '第 4 轮：继续。[Handoff · part 2]' : `第 ${i + 1} 轮：继续。` }] },
}));

test('AC-R3-9 回归：宿主 data.content[].text 形态能检出分段标记', () => {
  const msgs = eventsToMessages(hostShapedTurns(3));
  assert.equal(msgs.length, 10);
  assert.match(msgs[3].text, /\[Handoff · part 2\]/);
});

test('AC-R3-9 回归：auto 检出标记降 manual（零副作用，不建会话不改名）', async () => {
  const host = createFixtureHost();
  host.events.set('s-old', hostShapedTurns(3));
  const { dir, index, persistence, state } = setup();
  const res = await performRollover({ host, sessionId: 's-old', index, persistence, state, summarySegments: SUMMARY, now: NOW });
  assert.equal(res.status, 'skipped');
  assert.equal(res.reason, 'manual-pending');
  assert.equal(res.notice, true);
  assert.equal(res.downgraded, true);
  assert.equal(host.calls.filter((c) => c.op === 'create' || c.op === 'rename' || c.op === 'inject').length, 0);
  assert.equal(existsSync(join(dir, 'cluster-index.json')), false);
});

test('AC-R3-9 回归：forceAuto 同一会话照常分卷（downgraded:false）', async () => {
  const host = createFixtureHost();
  host.events.set('s-old', hostShapedTurns(3));
  const { dir, index, persistence, state } = setup();
  const res = await performRollover({
    host, sessionId: 's-old', index, persistence, state,
    config: { forceAuto: true }, summarySegments: SUMMARY, now: NOW,
  });
  assert.equal(res.status, 'rolled-over');
  const t1 = res.trace.find((t) => t.step === 'T1');
  assert.deepEqual([t1.mode, t1.downgraded, t1.markers], ['auto', false, true]);
});