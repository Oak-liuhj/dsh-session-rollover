// 服务端插件：注册服务、拦截只读旧卷、调度自动/手动分卷与告警。
import {appendFileSync, mkdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {countTurns, hasOpenTurn, DEFAULT_THRESHOLD} from '../domain/turns.mjs';
import {createClusterIndex} from '../domain/cluster-index.mjs';
import {attachFilePersistence, resolveDataDir} from '../storage/index-store.mjs';
import {createRolloverState} from '../storage/rollover-state.mjs';
import {performRollover} from '../application/rollover.mjs';
import {textOf} from '../domain/summary.mjs';
import {transitionInFlight} from '../domain/mode.mjs';
import {createNoticeStore} from '../storage/notices.mjs';
import {createHostAdapter} from './host-adapter.mjs';
import {attachNoticeRoutes, handlePendingNotices} from './notice-route.mjs';
import {inspectHost, preflightHost, INCOMPATIBLE_MESSAGE} from './compatibility.mjs';

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
    'cluster-cap': '同簇已达 9 卷上限，请新建独立会话继续。',
    'storage-unavailable': '分卷数据目录不可写，已保留原会话，请检查目录后重试。',
    'user-renamed': '已保留手动设置的会话名称。',
    'host-incompatible': INCOMPATIBLE_MESSAGE,
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
    static inject = ['sessions', 'sessionTitle', 'sessionController', 'sessionProjections', 'workspaceRegistry', 'connection'];

    /**
     * @param {object} ctx 宿主服务容器
     * @param {RolloverConfig} [config]
     */
    constructor(ctx, config = {}) {
        this.ctx = ctx;
        this.services = typeof ctx.inject === 'function' ? {} : ctx;
        if (ctx.inject) {
            for (const name of ['jobs', 'agentDefaultModel', 'workingDirectory', 'agents']) ctx.inject([name], scope => {
                const service = scope[name];
                this.services[name] = service;
                scope.effect?.(() => () => { if (this.services[name] === service) delete this.services[name]; });
            });
        }
        this.config = {mode: 'auto', threshold: DEFAULT_THRESHOLD, ...config};
        this.dataDir = resolveDataDir({configDir: this.config.dataDir, env: process.env});
        this.index = createClusterIndex();
        this.persistence = attachFilePersistence(this.index, this.dataDir);
        this.state = createRolloverState(this.dataDir);
        // B6：去重键＋「未发显」队列落盘（与 readonly 开关同目录），server 侧不再 append 系统消息
        this.notices = createNoticeStore(this.dataDir);
        this.state.modelFallback = id => this.notices.queue(id, 'model-fallback', '新卷未能继承原模型，已回落默认模型。');
        this.busy = new Set();
        this.lastCheckedTurn = new Map();
        this.loadIndex();
        ctx.provide('sessionRollover', {
            rollover: (id) => this.rolloverNow(id),
            info: (id) => this.handoffInfo(id),
            setReadonly: (id, value) => this.setReadonly(id, value),
            compatibility: () => inspectHost(this.ctx),
        });
        ctx.effect(() => () => {
            this.busy.clear();
        }); // 卸载时放弃在跑的判定，不残留定时/监听
        ctx.on('agent/pre-step', (payload, next) => this.onPreStep(payload, next), {prepend: true});
        // 用户轮次计数与执行切点分离：等真实回合/压缩结束后检查，不在模型执行中切卷。
        ctx.on('session/event', (session, event) => {
            if (['turn/end', 'compaction/end', 'part/end', 'tool/result'].includes(event.type ?? event.kind)) {
                queueMicrotask(() => void this.maybeRollover({agent: {session}}).catch(e => this.log('error', {error: String(e.message)})));
            }
        });
        this.attachRoutes(ctx);
        this.log('boot', {
            dataDir: this.dataDir, mode: this.config.mode, threshold: this.config.threshold,
            degraded: this.persistence.degraded, notices: this.notices.path, noticesDegraded: this.notices.degraded,
            compatibility: inspectHost(ctx),
        });
    }

    /** 路由实现独立维护；保留方法入口便于宿主接线与诊断。 */
    attachRoutes(ctx) {
        attachNoticeRoutes(ctx, {
            handlePending: (req, res) => this.handlePending(req, res),
            log: (event, data) => this.log(event, data),
            plugin: this,
        });
    }

    handlePending(req, res) {
        return handlePendingNotices({
            notices: this.notices,
            log: (event, data) => this.log(event, data),
        }, req, res);
    }

    /** 索引=缓存：回灌后用已注入且未废弃的交接补齐缺项，不按任意 -N 标题猜测。 */
    loadIndex() {
        try {
            const doc = JSON.parse(readFileSync(this.persistence.path, 'utf8'));
            if (!doc.sessions || typeof doc.sessions !== 'object' || Array.isArray(doc.sessions) ||
                Object.values(doc.sessions).some(r => !r?.cluster_id || !Number.isInteger(r.vol_no))) throw new Error('invalid-index');
            for (const [sessionId, r] of Object.entries(doc.sessions ?? {})) {
                this.index.record({
                    sessionId, clusterId: r.cluster_id, parentSessionId: r.parent_session_id,
                    volNo: r.vol_no, nameSuffix: r.name_suffix, rolloverState: r.rollover_state,
                    readonlyByRollover: r.readonly_by_rollover, summaryRetry: r.summary_retry,
                });
            }
            if (doc.turn_counts) this.index.setTurnCounts(doc.turn_counts);
        } catch { /* 缺失/坏文件继续从可信交接重建。 */ }
        this.reconcileIndex();
    }

    /** 启动修复缓存缺项；失败注入产生的待清理卷不参与有效父链。 */
    reconcileIndex() {
        if (!inspectHost(this.ctx).compatible) return;
        let sessions;
        try { sessions = this.ctx.sessions.list(); } catch { return; }
        if (!Array.isArray(sessions)) return;
        let changed = false;
        const abandoned = new Set(this.state.pendingList().map(r => r.sessionId));
        const snapshots = new Map();
        for (const session of sessions) {
            if (!session || typeof session.id !== 'string') continue;
            if (abandoned.has(session.id)) continue;
            let h;
            let events;
            try { events = session.snapshotEvents(); } catch { continue; }
            if (!Array.isArray(events)) continue;
            for (const e of events) {
                const text = textOf(e);
                if (!text.startsWith('【分卷交接】')) continue;
                try { h = JSON.parse(/```json\s*([\s\S]*?)```/.exec(text)?.[1]); } catch { /* 非本插件快照 */ }
                if (h?.rollover === 'v1') { try { this.state.handoffSave(session.id, h); } catch {} break; }
            }
            if (h?.rollover === 'v1' && h?.cluster?.cluster_id) snapshots.set(session.id, h);
        }
        const depth = (id, seen = new Set()) => {
            if (seen.has(id)) return 1;
            seen.add(id);
            const h = snapshots.get(id);
            return h ? h.cluster.vol_no || (h.cluster.independent ? 1 : depth(h.from_session_id, seen) + 1) : 1;
        };
        for (const [sessionId, h] of snapshots) {
            const volume = depth(sessionId);
            const parent = h.cluster.independent ? null : h.from_session_id;
            const parentRec = parent && this.index.get(parent);
            if (parent && (!parentRec || parentRec.rollover_state !== 'sealed')) {
                changed = true;
                this.index.record({sessionId: parent, clusterId: h.cluster.cluster_id,
                    parentSessionId: parentRec?.parent_session_id, volNo: volume - 1,
                    nameSuffix: parentRec?.name_suffix ?? '', rolloverState: 'sealed',
                    readonlyByRollover: this.state.readonlyRecord(parent)?.readonly ?? true,
                    summaryRetry: parentRec?.summary_retry ?? 0});
            }
            const own = this.index.get(sessionId);
            if (!own) {
                changed = true;
                this.index.record({sessionId, clusterId: h.cluster.cluster_id,
                    parentSessionId: parent, volNo: volume, nameSuffix: h.to_session_title?.match(/-\d+$/)?.[0] ?? '',
                    rolloverState: 'active', readonlyByRollover: false});
            }
        }
        if (changed) this.persistence.persist();
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
        const parent = handoff?.cluster?.independent ? null : handoff?.from_session_id ?? record?.parent_session_id;
        let title = handoff?.from_title || parent;
        const source = parent && this.sessionOf(parent);
        if (source) { try { title = this.ctx.sessionTitle.get(source)?.title || title; } catch {} }
        const session = this.sessionOf(id);
        let events = [];
        try { const snapshot = session?.snapshotEvents?.(); if (Array.isArray(snapshot)) events = snapshot; } catch {}
        let sessionTitle = '';
        try { sessionTitle = session ? this.ctx.sessionTitle.get(session)?.title ?? '' : ''; } catch {}
        const sealed = record?.rollover_state === 'sealed';
        const turnCount = countTurns(events);
        const children = record ? this.index.cluster(record.cluster_id).filter(r => r.parent_session_id === id) : [];
        const retry = this.state.retryGet(id).attempts;
        return {source: parent ? {sessionId: parent, title} : null, handoff,
            readonly: this.isReadonly(id), sealed, sessionId: id,
            title: sessionTitle,
            compatibility: session ? preflightHost(this.ctx, session, this.services) : inspectHost(this.ctx),
            turnCount, threshold: this.config.threshold, volume: record?.vol_no ?? null, cap: 9,
            capped: record?.vol_no >= 9, summaryRetry: retry,
            retryLimitReached: retry >= 3, degraded: this.persistence.degraded || !!this.stateDegraded?.has(id),
            previousTurnCount: source ? (() => { try { const e = source.snapshotEvents(); return Array.isArray(e) ? countTurns(e) : null; } catch { return null; } })() : null,
            nextSessionId: children[0]?.sessionId ?? null};
    }

    isReadonly(id) {
        const per = this.state.readonlyRecord(id);
        return per ? per.readonly !== false : this.state.isReadonly(id) || !!this.index.get(id)?.readonly_by_rollover;
    }

    setReadonly(id, readonly) {
        if (typeof readonly !== 'boolean') throw new Error('readonly must be boolean');
        if (!this.sessionOf(id)) throw new Error('session-unavailable');
        const rec = this.index.get(id);
        if (rec?.rollover_state !== 'sealed') throw new Error('session-not-archived');
        this.state.setReadonly(id, readonly);
        rec.readonly_by_rollover = readonly;
        this.persistence.persist();
        return this.handoffInfo(id);
    }

    /** 显式手动分卷：绕过轮次/模式门槛，仍执行只读、子会话与工具安全检查。 */
    async rolloverNow(id) {
        const session = this.sessionOf(id);
        if (!session) return {status: 'failed', reason: 'session-unavailable'};
        const compatibility = preflightHost(this.ctx, session, this.services);
        if (!compatibility.compatible) return {status: 'failed', reason: 'host-incompatible', compatibility};
        if (this.busy.has(inflightKey(id))) return {status: 'skipped', reason: 'busy'};
        if (this.index.get(id)?.rollover_state === 'sealed') return {status: 'skipped', reason: 'readonly'};
        this.busy.add(inflightKey(id));
        try {
            try { this.state.retrySave(id, 0); } catch (e) {
                return {status: 'failed', reason: 'storage-unavailable', error: String(e.message)};
            } // 显式人工操作开始一次新尝试，不恢复无限自动重试。
            const host = this.hostFor(session);
            const result = await performRollover({host, sessionId: id, index: this.index,
                persistence: this.persistence, state: this.state, config: this.config, manual: true,
            });
            this.afterResult(session, result);
            return result;
        } finally { this.busy.delete(inflightKey(id)); }
    }

    /** 每次事务绑定来源会话，避免工作区、模型选择和事件读取串到其他会话。 */
    hostFor(session) {
        return createHostAdapter({
            ctx: this.ctx, session, state: this.state,
            services: this.services,
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
            if (firstStep && sid && this.isReadonly(sid)) {
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
        const compatibility = preflightHost(this.ctx, session, this.services);
        if (!compatibility.compatible) {
            this.notifyOnce(session, {reason: 'host-incompatible'});
            return;
        }
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
        if (hasOpenTurn(events) || transitionInFlight(events)) return;
        const turns = countTurns(events);
        this.seen ??= new Set();
        if (!this.seen.has(id)) {
            this.seen.add(id);
            this.log('pre-step-seen', {sessionId: id, turns, events: events.length});
        }
        if (turns < this.config.threshold) return;
        if (this.state.retryGet(id).attempts >= 3) {
            this.notifyOnce(session, {reason: 'retry-limit'});
            return;
        }
        if (this.lastCheckedTurn.get(id) === turns) return; // 同一轮次不重复试探
        this.lastCheckedTurn.set(id, turns);
        this.busy.add(inflightKey(id));
        try {
            // 待办取日志最后一次 todo/write：此刻 turn/start 已把实时投影清零（见 domain/todos.mjs）。
            const res = await performRollover({
                host: this.hostFor(session), sessionId: id, index: this.index,
                persistence: this.persistence, state: this.state, config: this.config,
            });
            if (res.reason === 'unsafe-cut-point' || res.reason === 'transition-in-flight') this.lastCheckedTurn.delete(id);
            this.afterResult(session, res);
            if (res.status === 'rolled-over') {
                this.log('rolled-over', {
                    from: id,
                    to: res.newSessionId,
                    cluster: res.clusterId,
                    bytes: res.handoffBytes
                });
                // B6：成功一次即清该会话去重键（否则键只增不减，后续真失败会被历史键吃掉）
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

    afterResult(session, result) {
        try {
            if (result.status === 'rolled-over') {
                this.lastCompleted ??= new Map();
                this.lastCompleted.set(session.id, result.newSessionId);
                try { this.ctx.emit?.('rollover/completed', {fromSessionId: session.id, sessionId: result.newSessionId}); } catch {}
                this.state.retrySave(session.id, 0);
                this.notices.clearSession(session.id);
                this.notices.queue(session.id, 'completed', '分卷完成，已创建接续会话。');
            } else if (['oversize', 'summary-missing', 'summary-error', 'summary-too-long'].includes(result.reason)) {
                const n = this.state.retryGet(session.id).attempts + 1;
                this.state.retrySave(session.id, n);
                const rec = this.index.get(session.id);
                if (rec) { rec.summary_retry = n; this.persistence.persist(); }
                if (n >= 3) result.reason = 'retry-limit';
            }
            if (result.degraded) {
                this.stateDegraded ??= new Set();
                for (const id of [session.id, result.newSessionId].filter(Boolean)) this.stateDegraded.add(id);
            }
        } catch (e) {
            // 会话已经建成时，通知或重试状态落盘失败不能把成功结果翻成失败后再次建卷。
            result.degraded = true;
            this.stateDegraded ??= new Set();
            for (const id of [session.id, result.newSessionId].filter(Boolean)) this.stateDegraded.add(id);
            this.log('state-degraded', {sessionId: session.id, error: String(e.message)});
        }
        if (result.status === 'failed' || result.notice) this.notifyOnce(session, result);
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
