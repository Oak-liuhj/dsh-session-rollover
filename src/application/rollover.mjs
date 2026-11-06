// dsh-session-rollover · 装配层（事务 T0–T8，细化稿 §3 方案 A：注入前置为第一方案）
// 顺序：T0 轮次 → T1 mode 拦截 → T2 硬闸+快照+命名预演 → T3 八段摘要 → T4 建未定名新会话
//      → T5 注入摘要（首条 user/message）→ T6 旧卷改名 → T7 新卷改名 → T8 提交（簇索引+turn_counts+-1 只读）
// T0–T3 不过时不创建会话、不改名；注入失败登记待清理，新卷改名失败则尝试回滚旧卷标题。
// 依赖注入：host（宿主适配器）与 state/index/persistence（存储）都由调用方给，夹具可全内存替换真跑。
import {countTurns, DEFAULT_THRESHOLD} from '../domain/turns.mjs';
import {parseVolume, planVolumeTitles} from '../domain/naming.mjs';
import {effectiveRolloverMode, markersFound} from '../domain/mode.mjs';
import {buildHandoff, MAX_BYTES} from '../domain/handoff.mjs';
import {eventsToMessages, renderHandoffMessage} from './handoff-message.mjs';

/**
 * 跑一次分卷事务。host 接口（全部 async，夹具可内存实现）：
 *   listEvents(sessionId) / getTitle(sessionId) / listTitles() / getTodos(sessionId)
 *   inFlightTools(sessionId) / isSubagent(sessionId) / listRunningJobs(sessionId)
 *   createSession({cwd}) -> {sessionId} / injectFirstMessage(sessionId, text) / renameSession(sessionId, title)
 *   log(event, data)
 * manual=true 仅绕过 T0/T1 自动门槛；只读、子会话、未收尾工具和完整消息字节预算仍生效。
 * T8 的各文件分别提交，不是跨文件数据库事务；索引存储失败通过 degraded 显式返回。
 */
export async function performRollover({
                                          host,
                                          sessionId,
                                          index,
                                          persistence,
                                          state,
                                          config = {},
                                          summarySegments,
                                          currentStepIndex = null,
                                          activeIndexes = [],
                                          constraints = [],
                                          changedFiles = [],
                                          cwd,
                                          userRenamed = false,
                                          manual = false,
                                          now = () => new Date().toISOString(),
                                      }) {
    const trace = [];
    const mark = (step, data = {}) => {
        const rec = {step, at: now(), ...data};
        trace.push(rec);
        host.log?.(`rollover:${step}`, rec);
        return rec;
    };
    const done = (status, reason, extra = {}) => ({status, reason, sessionId, trace, ...extra});

    // 只读卷（-1）一律不动：连触发都不许（AC-R3-7 的服务端闸）
    if (state?.isReadonly(sessionId)) return done('skipped', 'readonly');

    // T0 轮次口径由 domain/turns.mjs 统一定义，优先使用完整日志中的已完成轮次。
    const events = await host.listEvents(sessionId);
    const turnCount = countTurns(events);
    const threshold = config.threshold ?? DEFAULT_THRESHOLD;
    mark('T0', {turnCount, threshold});
    if (!manual && turnCount < threshold) return done('skipped', 'below-threshold', {turnCount});

    // T1 mode 拦截（零副作用）：off 直接返回；manual 只提示；auto 检出外部分段特征降 manual
    const markers = markersFound(eventsToMessages(events));
    const {mode, downgraded} = effectiveRolloverMode(config.mode ?? 'auto', {
        forceAuto: !!config.forceAuto,
        hasMarkers: markers
    });
    mark('T1', {mode, downgraded, markers});
    if (!manual && mode === 'off') return done('skipped', 'mode-off');
    if (!manual && mode === 'manual') return done('skipped', 'manual-pending', {notice: true, downgraded});

    // T2 硬闸 + 快照（同刻取 running job 全集，切点后新起的不入交接）
    if (await host.isSubagent(sessionId)) return done('skipped', 'subagent-never');
    const inFlight = await host.inFlightTools(sessionId);
    mark('T2', {inFlight: inFlight.length, tools: inFlight.map((t) => t?.name ?? t?.callId ?? '?')});
    if (inFlight.length > 0) return done('skipped', 'unsafe-cut-point', {inFlight: inFlight.length});

    // 命名预演放在建会话之前：cluster-cap / user-renamed 也必须是零副作用
    const currentTitle = await host.getTitle(sessionId);
    const titles = (await host.listTitles()).map((t) => t.title);
    let plan = planVolumeTitles(currentTitle, titles, {userRenamed});
    // 达到卷号上限后，显式手动分卷允许新建独立接续系列，保留来源卷的标题与索引。
    if (manual && !plan.ok && plan.reason === 'cluster-cap') {
        const base = parseVolume(currentTitle).base;
        let n = 1;
        while (titles.includes(`${base}（接续 ${n}）`)) n++;
        plan = {ok: true, independent: true, base: `${base}（接续 ${n}）`, oldTarget: null,
            oldK: parseVolume(currentTitle).k, newK: 1, newTarget: `${base}（接续 ${n}）`};
    }
    mark('T2:plan', {currentTitle, ...plan});
    if (!plan.ok) return done('skipped', plan.reason, {currentTitle});

    const jobs = await host.listRunningJobs(sessionId);
    const todos = await host.getTodos(sessionId);
    mark('T2:snapshot', {jobs: jobs.length, todos: todos.length});

    // T3 八段摘要（失败=不分卷，旧卷零动作；retry 计数由调用方按 index.summary_retry 维护）
    if (!Array.isArray(summarySegments) || summarySegments.length === 0) return done('failed', 'summary-missing');
    const clusterId = (!plan.independent && index?.get(sessionId)?.cluster_id) || `cluster:${plan.base}`;
    const built = buildHandoff({
        summarySegments, todos, activeIndexes, currentStepIndex, openJobs: jobs,
        constraints, changedFiles, cluster: {cluster_id: clusterId}, fromSessionId: sessionId,
        toSessionTitle: plan.newTarget,
    });
    mark('T3', {ok: built.ok, bytes: built.bytes, reason: built.reason});
    if (!built.ok) return done('failed', built.reason, {bytes: built.bytes});
    const text = renderHandoffMessage(built.payload, {volume: plan.newK, at: now()});
    const messageBytes = new TextEncoder().encode(text).length;
    if (messageBytes > MAX_BYTES) return done('failed', 'oversize', {bytes: messageBytes});

    // T4 新建会话（暂不定名：宿主 create 本身没有标题参数）
    let newSessionId;
    try {
        const created = await host.createSession({cwd});
        newSessionId = created.sessionId;
    } catch (e) {
        mark('T4', {error: String(e?.message ?? e)});
        return done('failed', 'create-failed', {error: String(e?.message ?? e)}); // 四无：无注入/无改名/无索引/无只读
    }
    mark('T4', {newSessionId});

    // T5 注入摘要（首条 user/message）。炸了绝不改名：弃未定名卷、旧卷一字未动，挂待清理
    try {
        state?.handoffSave?.(newSessionId, {...built.payload, from_title: plan.oldTarget ?? currentTitle});
        await host.injectFirstMessage(newSessionId, text);
    } catch (e) {
        mark('T5', {error: String(e?.message ?? e)});
        state?.pendingAdd({
            sessionId: newSessionId,
            kind: 'abandoned-untitled',
            reason: 'inject-failed',
            at: now(),
            error: String(e?.message ?? e)
        });
        return done('failed', 'inject-failed', {newSessionId, abandoned: newSessionId, error: String(e?.message ?? e)});
    }
    mark('T5', {bytes: text.length});

    // T6 旧卷改名（仅当旧卷还是原始标题；已是 -k 的卷不动）
    const renamedOld = [];
    if (plan.oldTarget && plan.oldTarget !== currentTitle) {
        try {
            await host.renameSession(sessionId, plan.oldTarget);
            renamedOld.push({sessionId, from: currentTitle, to: plan.oldTarget});
        } catch (e) {
            mark('T6', {error: String(e?.message ?? e)});
            state?.pendingAdd({
                sessionId: newSessionId,
                kind: 'abandoned-untitled',
                reason: 'rename-old-failed',
                at: now(),
                error: String(e?.message ?? e)
            });
            return done('failed', 'rename-old-failed', {newSessionId, abandoned: newSessionId});
        }
        mark('T6', {to: plan.oldTarget, bumped: plan.bumped});
    } else {
        mark('T6', {skipped: true, reason: 'already-volume'});
    }

    // T7 新卷改名。炸了回滚旧卷改名（保原名），新卷仍未定名挂待清理
    try {
        await host.renameSession(newSessionId, plan.newTarget);
        mark('T7', {to: plan.newTarget, bumped: plan.bumped});
    } catch (e) {
        mark('T7', {error: String(e?.message ?? e)});
        const rolledBack = [];
        let rollbackFailed = false;
        for (const r of renamedOld) {
            try {
                await host.renameSession(r.sessionId, r.from);
                rolledBack.push(r);
            } catch (e2) {
                rollbackFailed = true;
                mark('T7:rollback-failed', {sessionId: r.sessionId, error: String(e2?.message ?? e2)});
            }
        }
        state?.pendingAdd({
            sessionId: newSessionId,
            kind: 'abandoned-untitled',
            reason: 'rename-new-failed',
            at: now(),
            error: String(e?.message ?? e)
        });
        // rollbackFailed 决定告警文案：回滚失败时「已保留原名」不成立（B6 第二句的前提，已核定）
        return done('failed', 'rename-new-failed', {newSessionId, abandoned: newSessionId, rolledBack, rollbackFailed});
    }

    // T8 提交：簇索引（七字段）+ turn_counts 同文件同原子提交，旧卷置只读标记
    const oldRec = plan.independent ? index.get(sessionId) : index.record({
        sessionId, clusterId, parentSessionId: index.get(sessionId)?.parent_session_id ?? null,
        volNo: plan.oldTarget ? parseVolume(plan.oldTarget).k : plan.oldK,
        nameSuffix: plan.oldTarget ? `-${parseVolume(plan.oldTarget).k}` : `-${plan.oldK}`,
        rolloverState: 'sealed', readonlyByRollover: true,
    });
    const newRec = index.record({
        sessionId: newSessionId, clusterId, parentSessionId: sessionId,
        volNo: plan.newK, nameSuffix: `-${plan.newK}`, rolloverState: 'active', readonlyByRollover: false,
    });
    index.setTurnCounts?.({...index.turnCounts?.(), [sessionId]: turnCount, [newSessionId]: 0});
    const persisted = persistence?.persist?.() ?? null; // null = 显式降级（L3），不静默丢：调用方看 persistence.degraded
    const ro = (!plan.independent && state?.markReadonly(sessionId, {
        clusterId,
        volNo: oldRec.vol_no,
        rolledAt: now(),
        rolledInto: newSessionId
    })) || null;
    state?.pendingRemove(newSessionId);
    mark('T8', {clusterId, persisted, readonly: !!ro, degraded: persistence?.degraded ?? false});

    return {
        status: 'rolled-over', reason: manual ? 'manual' : 'threshold-reached', sessionId, newSessionId, trace, turnCount,
        clusterId,
        from: {sessionId, title: plan.oldTarget ?? currentTitle, record: oldRec},
        to: {sessionId: newSessionId, title: plan.newTarget, record: newRec},
        persisted, degraded: persistence?.degraded ?? false,
        handoffBytes: built.bytes,
    };
}
