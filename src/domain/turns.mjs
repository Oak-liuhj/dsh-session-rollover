// dsh-session-rollover · 轮次计数与触发（接口契约 §3.1；纯逻辑）
// 从完整事件日志统计：优先 turn/end，其次 turn/start，最后兼容仅含 user/message 的旧日志；step 不计。
// 事件判别字段：session.v4 落盘事件用 `type`，内存/夹具事件历史上用 `kind` —— 两种都认（实机踩坑：只认 kind 会数成 0）
export const DEFAULT_THRESHOLD = 10;
export const eventType = (e) => e?.type ?? e?.kind;

/** 优先返回已完成轮数；前一种计数为 0 时才回退到后一种事件口径。 */
export function countTurns(events) {
    let ended = 0;
    let started = 0;
    let userMessages = 0;
    for (const e of events) {
        const t = eventType(e);
        if (t === 'turn/end') ended++;
        else if (t === 'turn/start') started++;
        else if (t === 'user/message') userMessages++;
    }
    // 只数「已完成轮次」：pre-step 时当前轮已有 turn/start 但还没有 turn/end，
    // 用 turn/start 会让第 10 轮当场触发、快照只含 9 轮（实机读数：第 3 步而非第 4 步）。
    // 老事件流/合成夹具没有 turn/end 时退回 turn/start，再退回 user/message。
    return ended || started || userMessages;
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
