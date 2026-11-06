// dsh-session-rollover · 宿主接线（server 半）。只用公开服务：sessions / sessionTitle / sessionController / sessionProjections
// 对 Bot 会话改名一律走 ctx.sessionTitle.rename —— 与 ds-bot roster 改名链路同一条（Bot id 即 session id，标题即会话名），
// 不自己 append session/title，不绕开 ds-bot 的改名语义（rename 会把标题 pin 成 user source）。
import {appendFileSync, mkdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {countTurns, DEFAULT_THRESHOLD, eventType} from './src/turns.mjs';
import {openToolCalls} from './src/inflight.mjs';
import {attachFilePersistence, createClusterIndex, resolveDataDir} from './src/cluster.mjs';
import {createRolloverState, performRollover} from './src/assembly.mjs';
import {buildSummarySegments} from './src/summary.mjs';
import {createNoticeStore} from './src/notices.mjs';

import {lastTodos} from './src/todos.mjs';

const inflightKey = (id) => `rollover:${id}`;

/** B6/B5 用户可见告警文案（需求 v1.2 表15：旧卷保留原名与内容＋告警一次；B5 超限只提醒）
 *  文案经 UI 定稿：一行系统消息、无 emoji、无内部术语（T6/T7/rollback 不外露）。 */
const NOTICE_TEXT = {
    failed: '分卷未完成：已保留原会话名与内容，下次发消息时自动重试。',
    'rename-old-failed': '分卷未完成：已保留原会话名与内容，下次发消息时自动重试。',
    // 旧卷改名后回滚本身失败：此时「已保留原名」不成立，必须换一句，让用户去侧栏核对（文案第②点）
    'rollback-failed': '分卷未完成：新卷未建立，原会话名称可能未复原，请在侧栏核对。',
    'manual-pending': '已到分卷阈值：manual 模式下自动分卷已暂停，可手动发起分卷。',
    'retry-limit': '分卷摘要连续失败，已停止自动重试；原会话名与内容保持不变。',
    'summary-error': '分卷摘要连续失败，已停止自动重试；原会话名与内容保持不变。',
};

export default class SessionRolloverPlugin {
    static inject = ['sessions', 'sessionTitle', 'sessionController', 'sessionProjections'];

    constructor(ctx, config = {}) {
        this.ctx = ctx;
        this.config = {mode: 'auto', threshold: DEFAULT_THRESHOLD, ...config};
        this.dataDir = resolveDataDir({configDir: this.config.dataDir, env: process.env});
        this.index = createClusterIndex();
        this.persistence = attachFilePersistence(this.index, this.dataDir);
        this.state = createRolloverState(this.dataDir);
        // B6：去重键＋「未发显」队列落盘（与 readonly 开关同目录），server 侧不再 append 系统消息
        this.notices = createNoticeStore(this.dataDir);
        this.busy = new Set();
        this.lastCheckedTurn = new Map();
        this.loadIndex();
        ctx.effect(() => () => {
            this.busy.clear();
        }); // 卸载时放弃在跑的判定，不残留定时/监听
        ctx.on('agent/pre-step', (payload, next) => this.onPreStep(payload, next), {prepend: true});
        this.attachRoutes(ctx);
        this.log('boot', {
            dataDir: this.dataDir, mode: this.config.mode, threshold: this.config.threshold,
            degraded: this.persistence.degraded, notices: this.notices.path, noticesDegraded: this.notices.degraded,
        });
    }

    /** client 半取件口：同源 GET，宿主 webServer 统一过登录校验（dsh-pick 同款）。
     *  取走即删＝「未发显」标记的投递；渲染由 client 半负责，server 不碰 DOM。 */
    attachRoutes(ctx) {
        if (typeof ctx.inject !== 'function') return;
        try {
            ctx.inject(['webServer'], (scope) => {
                const ws = scope.webServer ?? scope.get?.('webServer');
                if (!ws || typeof ws.register !== 'function') {
                    this.log('route-unavailable');
                    return undefined;
                }
                const dispose = ws.register({
                    kind: 'exact',
                    path: '/api-dsh-session-rollover/pending',
                    handler: (req, res) => this.handlePending(req, res),
                });
                this.log('route-registered', {path: '/api-dsh-session-rollover/pending'});
                scope.effect?.(() => () => {
                    try {
                        dispose?.();
                    } catch { /* 卸载容错 */
                    }
                }, 'rollover: pending route');
                return undefined;
            });
        } catch (e) {
            this.log('route-failed', {error: String(e?.message ?? e)});
        }
    }

    handlePending(req, res) {
        const send = (code, body) => {
            try {
                res.writeHead(code, {'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store'});
                res.end(JSON.stringify(body));
            } catch { /* 连接已断不阻断 */
            }
        };
        try {
            if (req.method !== 'GET') return send(405, {error: 'method-not-allowed'});
            const url = new URL(req.url ?? '/', 'http://127.0.0.1');
            const sessionId = url.searchParams.get('session');
            if (!sessionId) return send(400, {error: 'missing-session'});
            const notices = this.notices.takePending(sessionId);
            if (notices.length) this.log('notice-delivered', {
                sessionId,
                count: notices.length,
                reasons: notices.map((n) => n.reason)
            });
            return send(200, {version: 1, notices});
        } catch (e) {
            this.log('notice-deliver-failed', {error: String(e?.message ?? e)});
            return send(500, {error: 'internal'});
        }
    }

    /** 索引=缓存：读盘回灌；坏文件/无文件 → 空索引，靠 rebuild 对账（不抛） */
    loadIndex() {
        try {
            const doc = JSON.parse(readFileSync(this.persistence.path, 'utf8'));
            for (const [sessionId, r] of Object.entries(doc.sessions ?? {})) {
                this.index.record({
                    sessionId, clusterId: r.cluster_id, parentSessionId: r.parent_session_id,
                    volNo: r.vol_no, nameSuffix: r.name_suffix, rolloverState: r.rollover_state,
                    readonlyByRollover: r.readonly_by_rollover, summaryRetry: r.summary_retry,
                });
            }
            if (doc.turn_counts) this.index.setTurnCounts(doc.turn_counts);
        } catch { /* 首启/坏文件：空索引 */
        }
    }

    log(event, data = {}) {
        try {
            this.ctx.logger?.('dsh-session-rollover')?.info?.(event, data);
        } catch { /* 无 logger 也不影响主流程 */
        }
        try {
            this.ctx.get?.('telemetry')?.event?.('rollover', {event, ...data});
        } catch { /* 可选面 */
        }
        // 证据面：同一条日志落插件数据目录（不进 work_dir、不进发布 zip），便于实机取证与排障
        try {
            mkdirSync(this.dataDir, {recursive: true});
            appendFileSync(join(this.dataDir, 'plugin.log.jsonl'), `${JSON.stringify({
                at: new Date().toISOString(),
                event, ...data
            })}\n`);
        } catch { /* 落盘失败不阻断 */
        }
    }

    sessionOf(id) {
        try {
            return this.ctx.sessions.get(id) ?? null;
        } catch {
            return null;
        }
    }

    /** 宿主适配器：全部走公开服务；抓不到的面显式降级成空集合（不假装有） */
    hostFor(session) {
        const ctx = this.ctx;
        const id = session.id;
        const eventsOf = (sid) => {
            const s = sid === id ? session : this.sessionOf(sid);
            try {
                return s?.snapshotEvents?.() ?? [];
            } catch {
                return [];
            }
        };
        return {
            listEvents: async (sid) => eventsOf(sid),
            getTitle: async (sid) => {
                const s = sid === id ? session : this.sessionOf(sid);
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
            getTodos: async (sid) => lastTodos(eventsOf(sid)),
            inFlightTools: async (sid) => openToolCalls(eventsOf(sid)),
            isSubagent: async (sid) => {
                const s = sid === id ? session : this.sessionOf(sid);
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
            createSession: async () => ctx.sessionController.create({}), // 不传标题：宿主 create 无标题参数（Q1 证据①）
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
                    this.log('model-inherit-failed', {sessionId, error: String(e?.message ?? e)});
                }
                // 宿主 prompt(request, signal)：signal.throwIfAborted() 是第一行，必须给 AbortSignal
                await ctx.sessionController.prompt({
                    requestId: `rollover-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                    sessionId, mode: 'queue', content: [{type: 'text', text}],
                }, new AbortController().signal);
            },
            renameSession: async (sessionId, title) => {
                const target = this.sessionOf(sessionId);
                if (!target) throw new Error(`session "${sessionId}" is not live in this store`);
                ctx.sessionTitle.rename(target, title); // ds-bot roster 用的同一个调用
            },
            log: (event, data) => this.log(event, data),
        };
    }

    async onPreStep(payload, next) {
        // 只在「新一轮第一步」判定/拦截：分卷触发的那个回合在 T8 才把旧卷标只读，
        // 若后续 step 也拦，触发轮会被自己封死（工具调用链直接 blocked）。
        const firstStep = payload?.step == null || payload.step === 1;
        // AC-R3-7 服务端闸：-1 旧卷只读，连触发都不许（宿主约定 pre-step 返回 {kind:'reject'} → 本回合 blocked）
        const sid = payload?.agent?.session?.id;
        try {
            if (firstStep && sid && this.state.isReadonly(sid)) {
                this.readonlyBlocked ??= new Set();
                if (!this.readonlyBlocked.has(sid)) {
                    this.readonlyBlocked.add(sid);
                    this.log('readonly-blocked', {sessionId: sid});
                }
                return {kind: 'reject'};
            }
        } catch { /* 只读判定失败不阻断正常回合 */
        }
        const out = await next();
        if (firstStep) {
            try {
                void this.maybeRollover(payload).catch((e) => this.log('error', {error: String(e?.message ?? e)}));
            } catch { /* 旁挂判定绝不拖垮回合 */
            }
        }
        return out;
    }

    async maybeRollover({agent} = {}) {
        const session = agent?.session;
        if (!session?.id) return;
        const id = session.id;
        if (this.busy.has(id)) return;
        // 已封卷的 -N 永不再分卷：B9 的手动开关只放行「在旧卷继续写」，不等于再开新卷。
        try {
            const rec = this.index?.get?.(id);
            if (rec?.rollover_state === 'sealed') {
                this.sealedSkipped ??= new Set();
                if (!this.sealedSkipped.has(id)) {
                    this.sealedSkipped.add(id);
                    this.log('skip-sealed', {sessionId: id});
                }
                return;
            }
        } catch { /* 索引读不到不阻断判定 */
        }
        const events = session.snapshotEvents();
        const turns = countTurns(events);
        this.seen ??= new Set();
        if (!this.seen.has(id)) {
            this.seen.add(id);
            this.log('pre-step-seen', {sessionId: id, turns, events: events.length});
        }
        if (turns < this.config.threshold) return;
        if (this.lastCheckedTurn.get(id) === turns) return; // 同一轮次不重复试探
        this.lastCheckedTurn.set(id, turns);
        this.busy.add(inflightKey(id));
        try {
            // 待办取日志最后一次 todo/write：此刻 turn/start 刚把实时投影清零（见 src/todos.mjs）
            const todos = lastTodos(events);
            const stepIndex = todos.findIndex((t) => t.status === 'in_progress') + 1 || null;
            const summarySegments = buildSummarySegments({events, todos, jobs: [], currentStepIndex: stepIndex});
            const res = await performRollover({
                host: this.hostFor(session), sessionId: id, index: this.index,
                persistence: this.persistence, state: this.state, config: this.config,
                summarySegments, currentStepIndex: stepIndex,
                activeIndexes: stepIndex ? [stepIndex] : [],
                constraints: [], // 由 summary 段的「约束」承担原文摘录；这里不二次总结
            });
            if (res.status === 'rolled-over') {
                this.log('rolled-over', {
                    from: id,
                    to: res.newSessionId,
                    cluster: res.clusterId,
                    bytes: res.handoffBytes
                });
                // B6：成功一次即清该会话去重键（否则键只增不减，后续真失败会被历史键吃掉）
                const cleared = this.notices.clearSession(id);
                if (cleared.dedupe || cleared.pending) this.log('notice-dedupe-cleared', {sessionId: id, ...cleared});
            } else {
                this.log('not-rolled-over', {
                    sessionId: id,
                    turns,
                    status: res.status,
                    reason: res.reason ?? null,
                    error: res.error ?? null,
                    bytes: res.handoffBytes ?? null
                });
                // B6 / B5：失败与「只提醒不动作」必须用户看得见一次（需求 v1.2 表15 逐字要求；纯日志不算）
                if (res.status === 'failed' || res.notice === true) this.notifyOnce(session, res);
            }
        } finally {
            this.busy.delete(inflightKey(id));
        }
    }

    /**
     * 告警一次（B6）：入队到落盘镜像，等 client 半取走渲染。
     * v4 实测：server 侧 session.append('system/message') 在 Bot 会话上不渲染、不落盘，
     * 宿主「记忆已更新」同族提示也是 client 即时提示 → B6 通道改为「server 判定 + client 渲染」。
     * 去重键＝(会话, 原因) 落盘：同因连败只提示一次，换因再提示；分卷成功即清该会话键。
     */
    notifyOnce(session, res) {
        if (!session?.id) return;
        const reason = res?.rollbackFailed ? 'rollback-failed' : (res?.reason ?? 'failed');
        const text = NOTICE_TEXT[reason] ?? NOTICE_TEXT.failed;
        try {
            const out = this.notices.queue(session.id, reason, text);
            if (out.duplicate) this.log('notice-dedupe', {sessionId: session.id, reason});
            else if (out.queued) this.log('notice-queued', {
                sessionId: session.id,
                reason,
                text,
                id: out.id,
                degraded: out.degraded ?? null
            });
            else this.log('notice-skipped', {sessionId: session.id, reason, why: out.reason ?? null});
        } catch (e) {
            this.log('notice-failed', {sessionId: session.id, error: String(e?.message ?? e)});
        }
    }
}

export {SessionRolloverPlugin};