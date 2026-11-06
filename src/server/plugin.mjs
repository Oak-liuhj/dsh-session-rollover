// 服务端插件：注册服务、拦截只读旧卷、调度自动/手动分卷与告警。
import {appendFileSync, mkdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {countTurns, DEFAULT_THRESHOLD} from '../domain/turns.mjs';
import {createClusterIndex} from '../domain/cluster-index.mjs';
import {attachFilePersistence, resolveDataDir} from '../storage/index-store.mjs';
import {createRolloverState} from '../storage/rollover-state.mjs';
import {performRollover} from '../application/rollover.mjs';
import {buildSummarySegments} from '../domain/summary.mjs';
import {createNoticeStore} from '../storage/notices.mjs';
import {lastTodos} from '../domain/todos.mjs';
import {createHostAdapter} from './host-adapter.mjs';
import {attachNoticeRoutes, handlePendingNotices} from './notice-route.mjs';

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

/**
 * @typedef {object} RolloverConfig
 * @property {'auto'|'manual'|'off'} [mode='auto'] 自动判定模式；不限制显式手动调用
 * @property {number} [threshold=10] 自动分卷的轮次阈值
 * @property {boolean} [forceAuto=false] 检测到外部分段标记时仍保留 auto
 * @property {string} [dataDir] 插件数据目录；未指定时使用环境变量或 DSH 默认目录
 */

/**
 * 宿主插件生命周期入口。业务规则由 domain 层维护，分卷副作用由 application 层编排。
 * 自动与手动入口共用会话锁；宿主服务转换与提示路由分别委托给独立模块。
 */
export default class SessionRolloverPlugin {
    static inject = ['sessions', 'sessionTitle', 'sessionController', 'sessionProjections', 'workspaceRegistry'];

    /**
     * @param {object} ctx 宿主服务容器
     * @param {RolloverConfig} [config]
     */
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
        ctx.provide('sessionRollover', {
            rollover: (id) => this.rolloverNow(id),
            info: (id) => this.handoffInfo(id),
        });
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

    /** 路由实现独立维护；保留方法入口便于宿主接线与诊断。 */
    attachRoutes(ctx) {
        attachNoticeRoutes(ctx, {
            handlePending: (req, res) => this.handlePending(req, res),
            log: (event, data) => this.log(event, data),
        });
    }

    handlePending(req, res) {
        return handlePendingNotices({
            notices: this.notices,
            log: (event, data) => this.log(event, data),
        }, req, res);
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

    /** 查询来源卷、完整交接快照和只读状态；供面板读取，不触发分卷。 */
    handoffInfo(id) {
        const record = this.index.get(id);
        const handoff = this.state.handoffGet(id);
        const parent = handoff?.from_session_id ?? record?.parent_session_id;
        let title = handoff?.from_title || parent;
        const source = parent && this.sessionOf(parent);
        if (source) title = this.ctx.sessionTitle.get(source)?.title || title;
        return {source: parent ? {sessionId: parent, title} : null, handoff,
            readonly: this.state.isReadonly(id)};
    }

    /** 显式手动分卷：绕过轮次/模式门槛，仍执行只读、子会话与工具安全检查。 */
    async rolloverNow(id) {
        const session = this.sessionOf(id);
        if (!session) return {status: 'failed', reason: 'session-unavailable'};
        if (this.busy.has(inflightKey(id))) return {status: 'skipped', reason: 'busy'};
        if (this.index.get(id)?.rollover_state === 'sealed') return {status: 'skipped', reason: 'readonly'};
        this.busy.add(inflightKey(id));
        try {
            const events = session.snapshotEvents();
            const host = this.hostFor(session);
            const todos = await host.getTodos(id);
            const activeIndexes = todos.flatMap((t, i) => t.status === 'in_progress' ? [i + 1] : []);
            const jobs = await host.listRunningJobs(id);
            const currentStepIndex = activeIndexes[0] ?? null;
            return await performRollover({host, sessionId: id, index: this.index,
                persistence: this.persistence, state: this.state, config: this.config, manual: true,
                summarySegments: buildSummarySegments({events, todos, jobs, currentStepIndex}),
                currentStepIndex, activeIndexes,
            });
        } finally { this.busy.delete(inflightKey(id)); }
    }

    /** 每次事务绑定来源会话，避免工作区、模型选择和事件读取串到其他会话。 */
    hostFor(session) {
        return createHostAdapter({
            ctx: this.ctx, session, state: this.state,
            sessionOf: (id) => this.sessionOf(id),
            log: (event, data) => this.log(event, data),
        });
    }

    /** 首步拦截已封旧卷；正常回合放行后异步检查分卷，不等待事务完成。 */
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

    /** 自动入口：会话内每个轮次最多检查一次，锁在事务结束后释放。 */
    async maybeRollover({agent} = {}) {
        const session = agent?.session;
        if (!session?.id) return;
        const id = session.id;
        if (this.busy.has(inflightKey(id))) return;
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
            // 待办取日志最后一次 todo/write：此刻 turn/start 已把实时投影清零（见 domain/todos.mjs）。
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
