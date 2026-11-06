import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openToolCalls, callIdOf } from '../../src/domain/inflight.mjs';

// 真机事件形状（session.v4）：tool/call 用 data.callId，tool/result 用 data.toolCallId
test('in-flight：真机 tool/result 形状能收尾（回归：曾把 10 次 todo_write 全算未完成）', () => {
  const events = [
    { type: 'tool/call', data: { callId: 'c1', name: 'todo_write' } },
    { type: 'tool/result', data: { message: { toolCallId: 'c1', source: { kind: 'tool', callId: 'c1' } } } },
    { type: 'tool/call', data: { callId: 'c2', name: 'todo_write' } },
    { type: 'tool/result', data: { toolCallId: 'c2' } },
  ];
  assert.deepEqual(openToolCalls(events), []);
});

test('in-flight：仍在跑的一条被留下（切点不安全）', () => {
  const events = [
    { type: 'tool/call', data: { callId: 'c1', name: 'todo_write' } },
    { type: 'tool/result', data: { toolCallId: 'c1' } },
    { type: 'tool/call', data: { callId: 'c9', name: 'bash' } },
  ];
  const open = openToolCalls(events);
  assert.equal(open.length, 1);
  assert.equal(open[0].name, 'bash');
});

test('in-flight：kind 字段的老日志也能识别', () => {
  assert.deepEqual(openToolCalls([
    { kind: 'tool/call', data: { callId: 'k1' } },
    { kind: 'tool/result', data: { message: { callId: 'k1' } } },
  ]), []);
  assert.equal(callIdOf({ data: { message: { toolCallId: 'x' } } }), 'x');
});
