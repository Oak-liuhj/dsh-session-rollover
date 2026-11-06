import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextVolumeTitle, clusterVolumeCount, VOLUME_CAP } from '../../src/domain/naming.mjs';
import { countTurns, shouldTriggerRollover } from '../../src/domain/turns.mjs';
import { effectiveRolloverMode, markersFound } from '../../src/domain/mode.mjs';
import { buildHandoff, createSummaryRetry, todosMarkdown, MAX_BYTES } from '../../src/domain/handoff.mjs';

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
