// dsh-session-rollover · 轮次计数与触发（接口契约 §3.1；纯逻辑）
// 一条用户消息=一轮；内部 turn/step 不计。安全切点由 hasOpenTurn 独立判断。
// 事件判别字段：session.v4 落盘事件用 `type`，内存/夹具事件历史上用 `kind` —— 两种都认（实机踩坑：只认 kind 会数成 0）
export const DEFAULT_THRESHOLD = 10;
export const eventType = (e) => e?.type ?? e?.kind;

/** 宿主也用 user/message 记录时间、技能目录等上下文；它们不是用户发言。 */
export function isUserMessage(e) {
    const source = e?.data?.source ?? e?.source;
    return eventType(e) === 'user/message' && (!source?.kind || source.kind === 'user') &&
        !e?.data?.rollover && !String(e?.data?.content?.[0]?.text ?? e?.text ?? '').startsWith('【分卷交接】');
}

/** 从完整日志重建用户轮次；插件生成的交接消息不计入。 */
export function countTurns(events) {
    // B1：内部 turn/start、turn/end 的数量不代表用户发言轮数。
    // 交接首条消息由插件生成，不占用新卷的用户轮次。
    return events.filter(isUserMessage).length;
}

export function hasOpenTurn(events) {
    return events.findLastIndex(e => eventType(e) === 'turn/start') >
        events.findLastIndex(e => eventType(e) === 'turn/end');
}

/**
 * 触发判定（agent/pre-step 旁挂调用）。
 * @param turnCount 全 log 轮数
 * @param opts { threshold, hasInFlightTool, isSubagent, clusterCapReached, rolloverPending }
 * 后台 job 在跑不阻断（B2：job 句柄写入交接，不开新会话拆 job）
 */
export function shouldTriggerRollover(turnCount, opts = {}) {
    const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
    if (opts.isSubagent) return {trigger: false, reason: 'subagent-never'}; // B10
    if (turnCount < threshold) return {trigger: false, reason: 'below-threshold'};
    if (opts.hasInFlightTool) return {trigger: false, reason: 'unsafe-cut-point'}; // 安全切分点
    if (opts.clusterCapReached) return {trigger: false, reason: 'cluster-cap'}; // B11 停自动
    if (opts.rolloverPending) return {trigger: false, reason: 'pending'};
    return {trigger: true, reason: 'threshold-reached'};
}

/** 从日志重建计数（重启一致性，AC-R3-8）：纯函数天然满足，给出显式入口供接线层用 */
export const rebuildTurnCount = countTurns;
