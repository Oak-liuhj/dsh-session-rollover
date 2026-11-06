import assert from 'node:assert/strict';
import test from 'node:test';
import { lastTodos, activeIndex } from '../../src/domain/todos.mjs';

const T = (s) => [{ content: 'a', status: s }, { content: 'b', status: 'pending' }];

test('lastTodos 取最后一条 todo/write，忽略其后的 turn/start', () => {
  const events = [
    { type: 'turn/start', data: { turn: 10 } },
    { type: 'todo/write', data: { todos: T('completed') } },
    { type: 'turn/end', data: { turn: 10 } },
    { type: 'turn/start', data: { turn: 11 } }, // 实时投影已被这条清零
  ];
  assert.equal(lastTodos(events).length, 2);
  assert.equal(lastTodos(events)[0].status, 'completed');
});

test('lastTodos 兼容老日志 kind 字段与无 todo/write', () => {
  assert.equal(lastTodos([{ kind: 'todo/write', data: { todos: T('in_progress') } }]).length, 2);
  assert.deepEqual(lastTodos([{ type: 'turn/start' }]), []);
  assert.deepEqual(lastTodos([]), []);
});

test('lastTodos 忽略非数组 data.todos', () => {
  const events = [{ type: 'todo/write', data: { todos: [{ content: 'ok', status: 'pending' }] } },
    { type: 'todo/write', data: { todos: 'oops' } }];
  assert.equal(lastTodos(events).length, 1);
});

test('activeIndex 返回 in_progress 的 1 起位置，没有则 null', () => {
  const todos = [{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress' }, { content: 'c', status: 'pending' }];
  assert.equal(activeIndex(todos), 2);
  assert.equal(activeIndex([{ content: 'a', status: 'pending' }]), null);
  assert.equal(activeIndex([]), null);
});
