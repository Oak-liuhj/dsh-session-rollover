// dsh-session-rollover · 模式降级（AC-R3-8）：auto 检测到外部分段特征自动降 manual，配置可强制
// 检测对象 = 会话内出现的「[Checkpoint N]」/「[Handoff · part N]」类外部压缩-换段标记（billion-context 代理层产物）
export const SEGMENT_MARKER = /\[(?:Checkpoint \d+|Handoff(?: · part)? \d+)\]/;

export function markersFound(messages) {
  return messages.some((m) => m && typeof m.text === 'string' && SEGMENT_MARKER.test(m.text));
}

/**
 * @param configured 'auto' | 'manual' | 'off'（rollover.mode）
 * @param opts.forceAuto 配置强制 auto（不豁免外部分段告警展示，仅不降级）
 * @returns {{mode:'auto'|'manual'|'off', downgraded:boolean}}
 */
export function effectiveRolloverMode(configured = 'auto', opts = {}) {
  if (configured === 'off') return { mode: 'off', downgraded: false };
  if (configured === 'manual') return { mode: 'manual', downgraded: false };
  if (opts.forceAuto) return { mode: 'auto', downgraded: false };
  if (opts.hasMarkers) return { mode: 'manual', downgraded: true }; // 自动降 manual
  return { mode: 'auto', downgraded: false };
}
