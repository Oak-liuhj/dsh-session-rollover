// dsh-session-rollover · 交接七件套（接口契约 §3.2；v1.2 表 15 取数 + 八段排版，段名数组由调用方定，兼容 4/8 段裁定）
export const MAX_BYTES = 16 * 1024; // 16KB 硬预算（ralph 同款上限）

const encoder = new TextEncoder();

/** 摘要重试状态机（B5）：生成失败→不分卷，记 summary-error，下轮重试 ≤2，超限只提醒不动作 */
export function createSummaryRetry(maxRetries = 2) {
  let attempts = 0;
  return {
    get attempts() { return attempts; },
    reset() { attempts = 0; },
    recordFailure() {
      attempts++;
      return attempts <= maxRetries ? { action: 'retry', attempts } : { action: 'remind-only', attempts };
    },
  };
}

/**
 * 组七项交接。summarySegments: [[段名, 文本]]（四段/八段皆可，裁定后传对应表）。
 * B4 无待办→「无结构化待办」；B3 active 多项逐项列；⑤ 抓不到约束→「未识别到显式约束」。
 * @returns {{ok:true, payload:object, bytes:number} | {ok:false, reason:string, bytes?:number}}
 */
export function buildHandoff(input) {
  const {
    summarySegments, todos, activeIndexes = [], currentStepIndex = null,
    openJobs = [], constraints = [], changedFiles = [],
    cluster, fromSession, toSessionTitle,
  } = input;
  if (!Array.isArray(summarySegments) || summarySegments.length === 0) return { ok: false, reason: 'summary-missing' }; // B5 前置：调用方失败即不分卷
  const todoItems = Array.isArray(todos) ? todos : null;
  const payload = {
    rollover: 'v1',
    from_session_id: input.fromSessionId ?? null,
    cluster: cluster ?? { degraded_link: `from:${input.fromSessionId ?? 'unknown'}` }, // ⑦ 缺失降级单向链接
    summary: Object.fromEntries(summarySegments),
    todos: todoItems ?? '无结构化待办', // ② 双份之二（JSON 全表）
    current_step: currentStepIndex == null ? '尚未开始' : { index: currentStepIndex, active_items: activeIndexes }, // ③
    open_jobs: openJobs.map((j) => ({ id: j.id, command: j.command, status: j.status, recoverable: j.recoverable !== false })), // ④ 不可恢复标「需重跑」
    constraints: constraints.length ? constraints : ['未识别到显式约束'], // ⑤ 原文摘录不总结
    changed_files: changedFiles.map((f) => ({ path: f.path, note: f.note, deleted: !!f.deleted })), // ⑥
    to_session_title: toSessionTitle ?? null,
  };
  const json = JSON.stringify(payload);
  const bytes = encoder.encode(json).length;
  if (bytes > MAX_BYTES) return { ok: false, reason: 'oversize', bytes };
  return { ok: true, payload, bytes };
}

/** 人读列表（②双份之一）：注入首条消息用的 Markdown 段 */
export function todosMarkdown(todos) {
  if (!Array.isArray(todos) || todos.length === 0) return '无结构化待办';
  const mark = { completed: '[x]', in_progress: '[~]', pending: '[ ]' };
  return todos.map((t, i) => `${i + 1}. ${mark[t.status]} ${t.content}`).join('\n');
}
