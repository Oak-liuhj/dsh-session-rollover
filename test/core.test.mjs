import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextVolumeTitle, clusterVolumeCount, VOLUME_CAP } from '../src/naming.mjs';
import { countTurns, shouldTriggerRollover } from '../src/turns.mjs';
import { effectiveRolloverMode, markersFound } from '../src/mode.mjs';
import { buildHandoff, createSummaryRetry, todosMarkdown, MAX_BYTES } from '../src/handoff.mjs';
import { createClusterIndex, attachFilePersistence, rebuildFromTitles, resolveDataDir, FIELDS } from '../src/cluster.mjs';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// —— -N 命名（B7/B8/B11）——
test('命名：原标题→-1；-1→-2 不嵌套；重名递增第一空位', () => {
  assert.equal(nextVolumeTitle('foo', []).next, 'foo-1');
  assert.equal(nextVolumeTitle('foo-1', ['foo-1']).next, 'foo-2');
  assert.equal(nextVolumeTitle('foo', ['foo-1', 'foo-2']).next, 'foo-3');
});
test('命名：用户手动改名不覆盖（B8）', () => {
  assert.deepEqual(nextVolumeTitle('foo', [], { userRenamed: true }), { ok: false, reason: 'user-renamed' });
});
test('命名：同簇 -9 封顶停自动（B11）', () => {
  assert.equal(nextVolumeTitle('foo-9', []).ok, false);
  assert.equal(nextVolumeTitle('foo-9', []).reason, 'cluster-cap');
  assert.equal(nextVolumeTitle('foo', Array.from({ length: 9 }, (_, i) => `foo-${i + 1}`)).reason, 'cluster-cap');
  assert.equal(VOLUME_CAP, 9);
  assert.equal(clusterVolumeCount('foo-3', ['foo-1', 'foo-2', 'foo-3', 'other-1']), 3);
});

// —— 轮次计数（B1/B2/AC-R3-8）——
test('计数：只数 user/message；压缩替换段照计（全 log）', () => {
  const events = [
    { kind: 'user/message' }, { kind: 'agent/message' }, { kind: 'tool/call' },
    { kind: 'user/message', surfaceOp: { op: 'replace', startSeq: 1, endSeq: 5 } }, // 就地替换不删原
    { kind: 'user/message' },
  ];
  assert.equal(countTurns(events), 3);
  assert.equal(countTurns(events), countTurns(events.slice())); // 重建一致（纯函数）
});
test('触发：阈值10/安全切点/subagent 永不/job 不阻断', () => {
  assert.equal(shouldTriggerRollover(9).trigger, false);
  assert.equal(shouldTriggerRollover(10, { isSubagent: true }).reason, 'subagent-never');
  assert.equal(shouldTriggerRollover(10, { hasInFlightTool: true }).reason, 'unsafe-cut-point');
  assert.equal(shouldTriggerRollover(10, { clusterCapReached: true }).reason, 'cluster-cap');
  assert.equal(shouldTriggerRollover(10, {}).trigger, true); // job 在跑不阻断（B2 句柄进交接④）
});

// —— AC-R3-9 模式降级 ——
test('mode：auto 遇外部分段标记降 manual；manual/off 不变；forceAuto 豁免', () => {
  assert.equal(effectiveRolloverMode('auto', { hasMarkers: true }).mode, 'manual');
  assert.equal(effectiveRolloverMode('auto', { hasMarkers: true, forceAuto: true }).mode, 'auto');
  assert.equal(effectiveRolloverMode('manual', { hasMarkers: true }).mode, 'manual');
  assert.equal(effectiveRolloverMode('off', { hasMarkers: true }).mode, 'off');
  assert.equal(markersFound([{ text: '📦 [ACP] blah' }, { text: '[Checkpoint 3] x' }]), true);
  assert.equal(markersFound([{ text: '[Handoff · part 2] go' }]), true);
  assert.equal(markersFound([{ text: '普通消息 [TODO 1]' }]), false);
});

// —— 交接七件套 ——
const okInput = {
  fromSessionId: 's1', toSessionTitle: 'foo-2',
  summarySegments: [['Primary Request and Intent', '...'], ['Current Work', '第 4 步进行中']],
  todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress' }],
  activeIndexes: [2], currentStepIndex: 2,
  openJobs: [{ id: 'local-1', command: 'pnpm dev', status: 'running' }, { id: 'local-2', command: 'build', status: 'running', recoverable: false }],
  constraints: ['不许新增第三方依赖'], changedFiles: [{ path: 'src/a.mjs', note: '改' }, { path: 'src/b.mjs', note: '删', deleted: true }],
  cluster: { cluster_id: 'c1', parent_session_id: 's1', vol_no: 2 },
};
test('交接：七项齐 + AC-R3-3 快照 index=2 + ⑤⑥⑦ 形状', () => {
  const r = buildHandoff(okInput);
  assert.equal(r.ok, true); assert.equal(r.payload.current_step.index, 2);
  assert.equal(r.payload.open_jobs.find((j) => j.id === 'local-2').recoverable, false);
  assert.equal(r.payload.changed_files[1].deleted, true);
  assert.equal(r.bytes <= MAX_BYTES, true);
});
test('B4 无待办写「无结构化待办」不造假；⑤ 抓不到写「未识别到显式约束」', () => {
  const r = buildHandoff({ ...okInput, todos: null, constraints: [] });
  assert.equal(r.payload.todos, '无结构化待办');
  assert.deepEqual(r.payload.constraints, ['未识别到显式约束']);
  assert.equal(todosMarkdown(null), '无结构化待办');
  assert.match(todosMarkdown([{ content: 'b', status: 'in_progress' }]), /1\. \[~\] b/);
});
test('⑦ 簇缺失降级单向链接', () => {
  const r = buildHandoff({ ...okInput, cluster: undefined });
  assert.equal(r.payload.cluster.degraded_link, 'from:s1');
});
test('16KB 预算硬闸', () => {
  const r = buildHandoff({ ...okInput, constraints: ['x'.repeat(20000)] });
  assert.equal(r.ok, false); assert.equal(r.reason, 'oversize'); assert.ok(r.bytes > MAX_BYTES);
});
test('B5 摘要重试：≤2 重试，超限 remind-only，成功清零', () => {
  const s = createSummaryRetry();
  assert.equal(s.recordFailure().action, 'retry');
  assert.equal(s.recordFailure().action, 'retry');
  assert.equal(s.recordFailure().action, 'remind-only');
  s.reset(); assert.equal(s.recordFailure().action, 'retry');
});

// —— 簇元数据旁路索引（表 B2）——
test('B2 七字段索引：记录/查询/幂等覆盖/原子落盘可重载', () => {
  const idx = createClusterIndex();
  idx.record({ sessionId: 's2', clusterId: 'c1', parentSessionId: 's1', volNo: 2, nameSuffix: '-2' });
  const rec = idx.get('s2');
  for (const f of FIELDS) assert.ok(f in rec, '缺字段 ' + f);
  idx.record({ sessionId: 's2', clusterId: 'c1', parentSessionId: 's1', volNo: 2, nameSuffix: '-2', rolloverState: 'rolled' });
  assert.equal(idx.get('s2').rollover_state, 'rolled'); // 幂等覆盖非重复
  assert.equal(idx.cluster('c1').length, 1);
  const dir = mkdtempSync(join(tmpdir(), 'rollover-'));
  const p = attachFilePersistence(idx, dir);
  p.persist();
  const back = attachFilePersistence(createClusterIndex(), dir).load();
  assert.equal(back.get('s2').vol_no, 2);
  assert.equal(JSON.parse(readFileSync(p.path, 'utf8')).sessions.s2.name_suffix, '-2');
});

// —— 升级安全落点（接口契约：目录不可写时降级纯内存）——
test('数据目录：config > env > DSH_HOME > ~/.dsh；空白 env 视为未设置', () => {
  assert.equal(resolveDataDir({ configDir: 'X:\\cfg' }), 'X:\\cfg');
  assert.equal(resolveDataDir({ env: { DSH_ROLLOVER_DATA_DIR: 'X:\\rd' }, home: '/h' }), 'X:\\rd');
  assert.equal(resolveDataDir({ env: { DSH_HOME: 'D:\\dsh' }, home: '/h' }), join('D:\\dsh', 'plugin-data', 'dsh-session-rollover'));
  assert.equal(resolveDataDir({ env: { DSH_HOME: '   ' }, home: '/h' }), join('/h', '.dsh', 'plugin-data', 'dsh-session-rollover')); // 空白=未设置（home-paths 语义）
  assert.equal(resolveDataDir({ env: {}, home: '/h' }), join('/h', '.dsh', 'plugin-data', 'dsh-session-rollover'));
});
test('对账重建：索引=缓存，标题 -N + cluster: 标记可重建七字段', () => {
  const idx = rebuildFromTitles(
    [{ sessionId: 's1', title: '重构网关-1' }, { sessionId: 's2', title: '重构网关-2' }, { sessionId: 's3', title: '别的会话' }],
    { s2: { clusterId: 'c-real', parentSessionId: 's1' } },
  );
  assert.equal(idx.get('s2').vol_no, 2);
  assert.equal(idx.get('s2').cluster_id, 'c-real'); // 真标记优先于 recon:
  assert.equal(idx.get('s2').parent_session_id, 's1');
  assert.equal(idx.get('s2').rollover_state, 'reconstructed');
  assert.equal(idx.get('s3').vol_no, 0);
  assert.equal(idx.cluster('c-real').length, 2); // 无标记成员按同 base 归簇
});
test('目录不可写：显式降级纯内存（degraded+日志码），不抛不静默', () => {
  const idx = createClusterIndex();
  idx.record({ sessionId: 's1', clusterId: 'c1', volNo: 1, nameSuffix: '-1' });
  const p = attachFilePersistence(idx, 'X:\\盘符不存在\\rollover');
  assert.equal(p.persist(), null);
  assert.equal(p.degraded, true);
  assert.ok(p.lastError); // 日志码 cluster-index-missing 的数据面
  assert.equal(idx.get('s1').vol_no, 1); // 内存索引仍工作
});
