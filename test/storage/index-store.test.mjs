import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createClusterIndex, rebuildFromTitles, FIELDS} from '../../src/domain/cluster-index.mjs';
import {attachFilePersistence, resolveDataDir} from '../../src/storage/index-store.mjs';

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
test('目录不可写：显式降级纯内存（degraded+日志码），不抛不静默', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'rollover-unwritable-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  // 文件不能作为父目录：在 Windows/Linux 和高权限运行器上都稳定失败。
  const blocked = join(dir, 'file-as-parent');
  writeFileSync(blocked, 'fixture');
  const idx = createClusterIndex();
  idx.record({ sessionId: 's1', clusterId: 'c1', volNo: 1, nameSuffix: '-1' });
  const p = attachFilePersistence(idx, join(blocked, 'rollover'));
  assert.equal(p.persist(), null);
  assert.equal(p.degraded, true);
  assert.ok(p.lastError); // 日志码 cluster-index-missing 的数据面
  assert.equal(idx.get('s1').vol_no, 1); // 内存索引仍工作
});
