// client 半即时提示：时长 5s/8s 后 DOM 归零（fake timer，不真等）、补显 300ms、
// 同 id 不重复、取件走 /api-dsh-session-rollover/pending。无第三方 DOM 库，自带最小桩。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '..', 'client.js'), 'utf8');

function makeDoc() {
  const make = (tag) => {
    const node = {
      tagName: tag.toUpperCase(), children: [], parentNode: null, style: {}, attrs: {},
      className: '', textContent: '', childNodes: null,
      appendChild(child) { child.parentNode = node; node.children.push(child); child.childNodes = child.children; return child; },
      removeChild(child) { const at = node.children.indexOf(child); if (at >= 0) node.children.splice(at, 1); child.parentNode = null; return child; },
      setAttribute(key, value) { node.attrs[key] = value; },
      getBoundingClientRect() { return { top: 700, left: 0, width: 520, height: 64 }; },
    };
    node.childNodes = node.children;
    return node;
  };
  const body = make('body');
  const head = make('head');
  const composer = make('div');
  const doc = {
    body, head, visibilityState: 'visible', createElement: make,
    querySelector: (sel) => (sel === 'div[contenteditable="true"]' ? composer : null),
    querySelectorAll: (sel) => {
      const out = [];
      const walk = (n) => n.children.forEach((c) => {
        if (sel === '.dsr-toast' && String(c.className).split(/\s+/).includes('dsr-toast')) out.push(c);
        walk(c);
      });
      walk(body);
      return out;
    },
    addEventListener() {}, removeEventListener() {},
  };
  return { doc, composer };
}

function makeTimers() {
  let now = 0;
  let next = 0;
  const queue = new Map();
  return {
    setTimeout(fn, ms) { next += 1; queue.set(next, { fn, at: now + Math.max(0, ms) }); return next; },
    clearTimeout(id) { queue.delete(id); },
    advance(ms) {
      const target = now + ms;
      let guard = 0;
      for (;;) {
        let pick = null;
        for (const [id, t] of queue) {
          if (t.at <= target && (!pick || t.at < pick.t.at || (t.at === pick.t.at && id < pick.id))) pick = { id, t };
        }
        if (!pick) break;
        queue.delete(pick.id);
        now = pick.t.at;
        pick.t.fn();
        if ((guard += 1) > 20000) throw new Error('timer loop');
      }
      now = target;
    },
    get size() { return queue.size; },
  };
}

function loadClient() {
  const { doc } = makeDoc();
  const window = {
    innerHeight: 800, location: { search: '' },
    localStorage: { getItem: () => JSON.stringify({ sessionId: 'S1' }) },
    console: { debug() {} },
    setTimeout, clearTimeout,
  };
  let exported = null;
  window.__ModuleLoader__ = { load(def) { exported = def.factory(() => ({})); } };
  const sandbox = { window, document: doc, console: { debug() {} }, Promise, setTimeout, clearTimeout };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return { mod: exported, doc, window, env: { doc, win: window } };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('durationFor：常规 5s，rollback-failed 8s', () => {
  const { mod } = loadClient();
  assert.equal(mod.__test.durationFor('failed'), 5000);
  assert.equal(mod.__test.durationFor('manual-pending'), 5000);
  assert.equal(mod.__test.durationFor('rollback-failed'), 8000);
});

test('DOM 计数：常规句 5000ms 后归零（4999 仍在）', () => {
  const { mod, doc, env } = loadClient();
  const timers = makeTimers();
  const toaster = mod.__test.createToaster({ ...env, timers });
  toaster.show({ id: 'n1', reason: 'failed', text: '分卷未完成' });
  assert.equal(doc.querySelectorAll('.dsr-toast').length, 1);
  timers.advance(4999);
  assert.equal(doc.querySelectorAll('.dsr-toast').length, 1);
  timers.advance(1);
  assert.equal(doc.querySelectorAll('.dsr-toast').length, 0, '5000ms 后 DOM 计数归零');
});

test('DOM 计数：rollback-failed 8000ms 后归零（7999 仍在）', () => {
  const { mod, doc, env } = loadClient();
  const timers = makeTimers();
  const toaster = mod.__test.createToaster({ ...env, timers });
  toaster.show({ id: 'n2', reason: 'rollback-failed', text: '原会话名称可能未复原' });
  timers.advance(7999);
  assert.equal(doc.querySelectorAll('.dsr-toast').length, 1);
  timers.advance(1);
  assert.equal(doc.querySelectorAll('.dsr-toast').length, 0, '8000ms 后 DOM 计数归零');
});

test('两条提示独立计时：常规句先消失，rollback-failed 后消失', () => {
  const { mod, doc, env } = loadClient();
  const timers = makeTimers();
  const toaster = mod.__test.createToaster({ ...env, timers });
  toaster.show({ id: 'a', reason: 'failed', text: 'A' });
  toaster.show({ id: 'b', reason: 'rollback-failed', text: 'B' });
  assert.equal(doc.querySelectorAll('.dsr-toast').length, 2);
  timers.advance(5000);
  assert.equal(doc.querySelectorAll('.dsr-toast').length, 1);
  timers.advance(3000);
  assert.equal(doc.querySelectorAll('.dsr-toast').length, 0);
});

test('补显：进入会话延迟 300ms 才取件；同 id 第二次投递不重复渲染', async () => {
  const { mod, doc, env } = loadClient();
  const timers = makeTimers();
  const calls = [];
  const fetchStub = (url) => {
    calls.push(url);
    return Promise.resolve({
      ok: true,
      json: async () => ({ version: 1, notices: [{ id: 'n1', reason: 'failed', text: '分卷未完成' }] }),
    });
  };
  const toaster = mod.__test.createToaster({ ...env, timers });
  const stop = mod.__test.start({ ...env, timers, fetch: fetchStub }, toaster);
  assert.equal(calls.length, 0, '首帧不抢跑');
  timers.advance(299);
  assert.equal(calls.length, 0);
  timers.advance(1);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /\/api-dsh-session-rollover\/pending\?session=S1$/);
  await tick();
  await tick();
  assert.equal(doc.querySelectorAll('.dsr-toast').length, 1);

  timers.advance(1000); // 下一轮轮询同一 id
  await tick();
  await tick();
  assert.equal(doc.querySelectorAll('.dsr-toast').length, 1, '同 id 不重复渲染');
  stop();
  const before = calls.length;
  timers.advance(5000);
  assert.equal(calls.length, before, '停用后不再轮询');
});

test('页面隐藏不取件；可见后立即取', async () => {
  const { mod, doc, env } = loadClient();
  const timers = makeTimers();
  const calls = [];
  const fetchStub = (url) => { calls.push(url); return Promise.resolve({ ok: true, json: async () => ({ notices: [] }) }); };
  const toaster = mod.__test.createToaster({ ...env, timers });
  doc.visibilityState = 'hidden';
  const stop = mod.__test.start({ ...env, timers, fetch: fetchStub }, toaster);
  timers.advance(5000);
  assert.equal(calls.length, 0);
  doc.visibilityState = 'visible';
  timers.advance(1000);
  timers.advance(300);
  await tick();
  assert.equal(calls.length >= 1, true);
  stop();
});