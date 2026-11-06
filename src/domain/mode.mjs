// dsh-session-rollover · 模式降级（AC-R3-8）：auto 检测到外部分段特征自动降 manual，配置可强制
// 检测对象 = 会话内出现的「[Checkpoint N]」/「[Handoff · part N]」类外部压缩-换段标记（billion-context 代理层产物）
export const SEGMENT_MARKER = /\[(?:Checkpoint \d+|Handoff(?: · part)? \d+)\]/;

export function markersFound(messages) {
    return messages.some((m) => m && !m.internal && m.type !== 'system/message' && typeof m.text === 'string' && SEGMENT_MARKER.test(m.text));
}

/** 压缩正在执行时不并发建卷；forceAuto 只豁免标记降级，不豁免安全切点。 */
export function transitionInFlight(events) {
    const open = new Map();
    for (const e of events) {
        const type = e.type ?? e.kind;
        if (!/^(compaction|part)\/(start|end)$/.test(type)) continue;
        const [kind, phase] = type.split('/');
        const key = `${kind}:${e.data?.id ?? e.data?.turn ?? ''}`;
        if (phase === 'start') open.set(key, true);
        else open.delete(key);
    }
    return open.size > 0;
}

/**
 * @param configured 'auto' | 'manual' | 'off'（rollover.mode）
 * @param opts.forceAuto 配置强制 auto（不豁免外部分段告警展示，仅不降级）
 * @returns {{mode:'auto'|'manual'|'off', downgraded:boolean}}
 */
export function effectiveRolloverMode(configured = 'auto', opts = {}) {
    if (configured === 'off') return {mode: 'off', downgraded: false};
    if (configured === 'manual') return {mode: 'manual', downgraded: false};
    if (opts.forceAuto) return {mode: 'auto', downgraded: false};
    if (opts.hasMarkers) return {mode: 'manual', downgraded: true}; // 自动降 manual
    return {mode: 'auto', downgraded: false};
}
