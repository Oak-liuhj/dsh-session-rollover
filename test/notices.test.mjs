// B6 落盘镜像：去重键持久化、待投递一次取走、成功清键、坏文件降级、原子写。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNoticeStore, NOTICE_FILE } from '../src/notices.mjs';

const dirOf = (tag) => mkdtempSync(join(tmpdir(), `rollover-notice-${tag}-`));

test('queue：同(会话,原因)只入队一次；换因/换会话再入队', () => {
  const dir = dirOf('dedupe');
  const store = createNoticeStore(dir);
  assert.equal(store.queue('s1', 'failed', 'A').queued, true);
  assert.deepEqual(store.queue('s1', 'failed', 'A'), { queued: false, duplicate: true, id: store.snapshot().dedupe['s1|failed'].id });
  assert.equal(store.queue('s1', 'rollback-failed', 'B').queued, true);
  assert.equal(store.queue('s2', 'failed', 'A').queued, true);
  assert.equal(store.takePending('s1').length, 2);
  assert.equal(store.takePending('s2').length, 1);
});

test('落盘：去重键与未发显队列重启后仍在；取走即删且持久', () => {
  const dir = dirOf('persist');
  const a = createNoticeStore(dir);
  a.queue('s1', 'failed', '文案');
  assert.equal(existsSync(join(dir, NOTICE_FILE)), true);

  const b = createNoticeStore(dir);
  assert.equal(b.queue('s1', 'failed', '文案').duplicate, true, '去重键跨重启仍生效');
  const pending = b.takePending('s1');
  assert.equal(pending.length, 1);
  assert.equal(pending[0].text, '文案');
  assert.equal(pending[0].reason, 'failed');

  const c = createNoticeStore(dir);
  assert.equal(c.takePending('s1').length, 0, '取走一次＝投递一次，不重复投');
  assert.equal(c.queue('s1', 'failed', '文案').duplicate, true, '去重键在投递后仍保留');
});

test('clearSession：分卷成功一次即清该会话去重键与残留队列；清后同因可再提示', () => {
  const dir = dirOf('clear');
  const store = createNoticeStore(dir);
  store.queue('s1', 'failed', 'A');
  store.queue('s1', 'manual-pending', 'B');
  store.queue('s2', 'failed', 'C');
  assert.deepEqual(store.clearSession('s1'), { dedupe: 2, pending: 2 });

  const reloaded = createNoticeStore(dir);
  assert.equal(reloaded.snapshot().dedupe['s2|failed'] !== undefined, true, '别的会话不受影响');
  assert.equal(reloaded.queue('s1', 'failed', 'A').queued, true, '清键后真失败能再提示');
  assert.equal(reloaded.queue('s2', 'failed', 'C').duplicate, true);
});

test('坏文件：不抛、降级 unreadable，下一次写自愈成合法 JSON', () => {
  const dir = dirOf('corrupt');
  writeFileSync(join(dir, NOTICE_FILE), '{oops', 'utf8');
  const store = createNoticeStore(dir);
  assert.equal(store.degraded, 'unreadable');
  assert.equal(store.queue('s1', 'failed', 'A').queued, true);
  const doc = JSON.parse(readFileSync(join(dir, NOTICE_FILE), 'utf8'));
  assert.equal(Object.keys(doc.dedupe).length, 1);
  assert.equal(doc.pending.s1.length, 1);
});

test('原子写：目录内不残留 .tmp', () => {
  const dir = dirOf('atomic');
  const store = createNoticeStore(dir);
  store.queue('s1', 'failed', 'A');
  store.takePending('s1');
  assert.equal(existsSync(join(dir, `${NOTICE_FILE}.tmp`)), false);
});