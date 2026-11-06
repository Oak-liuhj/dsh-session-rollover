// 将宿主公开服务转换为分卷事务接口；事件计数与正文等纯解析规则委托给 domain。
import {eventType} from '../domain/turns.mjs';
import {openToolCalls} from '../domain/inflight.mjs';
import {lastTodos} from '../domain/todos.mjs';

/**
 * 为一个来源会话创建适配器。新卷继承其工作区和模型选择。
 * @param {object} deps
 * @param {object} deps.ctx 宿主公开服务容器
 * @param {object} deps.session 来源会话（id、snapshotEvents、header）
 * @param {object} deps.state 插件旁路状态存储
 * @param {(id: string) => object|null} deps.sessionOf 查询当前存活会话
 * @param {(event: string, data?: object) => void} deps.log 诊断日志回调
 * @returns {object} performRollover 所需的异步宿主接口
 */
export function createHostAdapter({ctx, session, state, sessionOf, log}) {
    const id = session.id;
    const eventsOf = (sid) => {
        const s = sid === id ? session : sessionOf(sid);
        try {
            return s?.snapshotEvents?.() ?? [];
        } catch {
            return [];
        }
    };
    return {
        listEvents: async (sid) => eventsOf(sid),
        getTitle: async (sid) => {
            const s = sid === id ? session : sessionOf(sid);
            try {
                return ctx.sessionTitle.get(s)?.title ?? '';
            } catch {
                return '';
            }
        },
        listTitles: async () => {
            const out = [];
            for (const s of ctx.sessions.list()) {
                try {
                    out.push({sessionId: s.id, title: ctx.sessionTitle.get(s)?.title ?? ''});
                } catch { /* 单条坏不影响整表 */
                }
            }
            return out;
        },
        getTodos: async (sid) => {
            const events = eventsOf(sid);
            // 出现过实时待办事件即以日志为准；只有完全没有该事件时才继承交接快照。
            // 空数组是用户清空清单，不能用继承值把它重新填回去。
            if (events.some(e => eventType(e) === 'todo/write')) return lastTodos(events);
            const inherited = state.handoffGet(sid)?.todos;
            return Array.isArray(inherited) ? inherited : [];
        },
        inFlightTools: async (sid) => openToolCalls(eventsOf(sid)),
        isSubagent: async (sid) => {
            const s = sid === id ? session : sessionOf(sid);
            try {
                return s?.header?.parentSession !== undefined && s?.header?.parentSession !== null;
            } catch {
                return false;
            }
        },
        listRunningJobs: async (sid) => {
            const open = new Map();
            for (const e of eventsOf(sid)) {
                const runId = e?.data?.runId ?? e?.data?.id ?? e?.seq;
                if (eventType(e) === 'tool-workflow/run-start') open.set(runId, {
                    id: String(runId),
                    command: e.data?.command ?? e.data?.name ?? 'workflow',
                    status: 'running',
                    recoverable: true
                });
                else if (eventType(e) === 'tool-workflow/run-end') open.delete(e.data?.runId ?? e.data?.id ?? e.seq);
            }
            return [...open.values()]; // 同刻全量；切点后新起的 run 不在快照里
        },
        createSession: async () => {
            // 优先归入来源工作区；来源不属于工作区时才按其 cwd 建会话。
            const cwd = ctx.sessionProjections.stateOf(session, 'workingDirectory');
            const workspace = ctx.workspaceRegistry.list().find(w => w.sessionIds.includes(session.id));
            return ctx.sessionController.create(workspace ? {workspaceId: workspace.id} : typeof cwd === 'string' ? {cwd} : {});
        },
        injectFirstMessage: async (sessionId, text) => {
            // 宿主 create() 建的是空壳会话，没有 model selection，会落到默认 provider
            // （实测 "deepseek-official" 无 key → MISSING_CREDENTIAL）。先继承旧卷的模型，再注入。
            try {
                const sel = ctx.sessionProjections.stateOf(session, 'modelSelection');
                const pick = sel?.pending ?? sel?.lastUsed;
                if (pick?.provider && pick?.model) {
                    await ctx.sessionController.selectModel({
                        sessionId, provider: pick.provider, model: pick.model,
                        ...(pick.reasoningEffort ? {reasoningEffort: pick.reasoningEffort} : {}),
                    });
                }
            } catch (e) {
                log('model-inherit-failed', {sessionId, error: String(e?.message ?? e)});
            }
            // 宿主 prompt(request, signal)：signal.throwIfAborted() 是第一行，必须给 AbortSignal
            await ctx.sessionController.prompt({
                requestId: `rollover-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                sessionId, mode: 'queue', content: [{type: 'text', text}],
            }, new AbortController().signal);
        },
        renameSession: async (sessionId, title) => {
            const target = sessionOf(sessionId);
            if (!target) throw new Error(`session "${sessionId}" is not live in this store`);
            ctx.sessionTitle.rename(target, title); // ds-bot roster 用的同一个调用
        },
        log: (event, data) => log(event, data),
    };
}
