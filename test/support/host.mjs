import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Plugin from '../../index.js';

/** 有日志、事件、模型和 owner 认证面的隔离宿主；不连接真实模型。 */
export function fixture({turns = 10, title = '巡检', source = 'generated', todos = [
    {content: '收集数据', status: 'completed'}, {content: '分析登录', status: 'in_progress'},
    {content: '生成报表', status: 'in_progress'}, {content: '归档', status: 'pending'},
], config = {}, dir = mkdtempSync(join(tmpdir(), 'rollover-regression-'))} = {}) {
    const events = Array.from({length: turns}, (_, i) => ({type: 'user/message', data: {content: [{type: 'text', text: i ? '继续' : '必须保留巡检范围，不要发送外部消息'}]}}));
    events.push({type: 'todo/write', data: {todos}});
    events.push({type: 'tool/call', data: {callId: 'read-1', name: 'read', arguments: {path: 'src/a.mjs'}}},
        {type: 'tool/result', data: {callId: 'read-1'}});
    const sessions = new Map([['old', {id: 'old', title, titleSource: source, header: {}, events,
        snapshotEvents() { return this.events; }}]]);
    const handlers = new Map(), emitted = [], calls = {create: [], prompt: [], model: []};
    const ctx = {
        sessions: {list: () => [...sessions.values()], get: id => sessions.get(id)},
        sessionTitle: {get: s => ({title: s.title, source: {kind: s.titleSource}}), rename: (s, next) => { s.title = next; s.titleSource = 'user'; }},
        sessionProjections: {stateOf: (_s, name) => name === 'workingDirectory' ? 'D:/work' : name === 'modelSelection' ? {lastUsed: {provider: 'original', model: 'model'}} : todos},
        workspaceRegistry: {list: () => []},
        sessionController: {
            create: async options => { const id = `new-${calls.create.length + 1}`; calls.create.push(options);
                sessions.set(id, {id, title: '', header: {}, events: [], snapshotEvents() { return this.events; }}); return {sessionId: id}; },
            prompt: async req => { calls.prompt.push(req); sessions.get(req.sessionId).events.push({type: 'user/message', data: {content: req.content}}); },
            selectModel: async selection => { calls.model.push(selection); },
        },
        connection: {admit: () => ({peer: {principal: {kind: 'owner'}}})},
        provide: (name, value) => { ctx[name] = value; },
        on: (name, cb) => { handlers.set(name, cb); },
        emit: (name, data) => emitted.push({name, data}), effect: () => {},
    };
    const plugin = new Plugin(ctx, {dataDir: dir, ...config});
    const run = () => plugin.maybeRollover({agent: {session: sessions.get('old')}});
    return {ctx, plugin, sessions, events, calls, handlers, emitted, run, dir};
}
