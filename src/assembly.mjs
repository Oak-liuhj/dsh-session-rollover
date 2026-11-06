// dsh-session-rollover · 装配层（事务 T0–T8，细化稿 §3 方案 A：注入前置为第一方案）
// 顺序：T0 轮次 → T1 mode 拦截 → T2 硬闸+快照+命名预演 → T3 八段摘要 → T4 建未定名新会话
//      → T5 注入摘要（首条 user/message）→ T6 旧卷改名 → T7 新卷改名 → T8 提交（簇索引+turn_counts+-1 只读）
// 零副作用前置：T0–T3 任一不过，旧卷与新会话都不存在/未动；T5 炸=弃未定名卷挂待清理；T6/T7 炸=回滚已改名保原名。
// 依赖注入：host（宿主适配器）与 state/index/persistence（存储）都由调用方给，夹具可全内存替换真跑。
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { countTurns, DEFAULT_THRESHOLD } from './turns.mjs';
import { parseVolume, planVolumeTitles } from './naming.mjs';
import { effectiveRolloverMode, markersFound } from './mode.mjs';
import { buildHandoff, todosMarkdown } from './handoff.mjs';
import { textOf } from './summary.mjs'; // 取值实现全仓唯一（工程约定：单一份取值实现）

export const PENDING_FILE = 'pending-cleanup.json';
export const READONLY_FILE = 'readonly-by-rollover.json'; // 旧版聚合标记：只读兼容
/** 需求 B9：开关状态存 <dataDir>/readonly-<sessionId>.json（与簇索引同目录同优先级，不写会话元数据）。 */
export const readonlyFileOf = (dir, sessionId) => join(dir, `readonly-${sessionId}.json`);

function readJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}
function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + '.tmp';
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, path); // 与簇索引同一原子手法：临时文件 + rename
}

/** 插件数据目录下的两份旁路状态：待清理卷清单、-1 只读标记（都不进 work_dir、不进发布 zip）。 */
export function createRolloverState(dir) {
  const pendingPath = join(dir, PENDING_FILE);
  const readonlyPath = join(dir, READONLY_FILE);
  return {
    dir,
    pendingPath,
    readonlyPath,
    pendingList: () => Object.values(readJson(pendingPath, {})),
    pendingAdd(rec) {
      const all = readJson(pendingPath, {});
      all[rec.sessionId] = rec;
      writeJsonAtomic(pendingPath, all);
      return rec;
    },
    pendingRemove(sessionId) {
      const all = readJson(pendingPath, {});
      delete all[sessionId];
      writeJsonAtomic(pendingPath, all);
    },
    markReadonly(sessionId, payload) {
      const rec = { readonly: true, ...payload };
      writeJsonAtomic(readonlyFileOf(dir, sessionId), rec);
      return rec;
    },
    /**
     * 手动开关：把 readonly-<sessionId>.json 里的 readonly 改成 false 即放行（保留历史全景）。
     * 兼容旧版聚合文件 readonly-by-rollover.json。
     */
    isReadonly(sessionId) {
      const per = readJson(readonlyFileOf(dir, sessionId), null);
      if (per) return per.readonly !== false;
      return !!readJson(readonlyPath, {})[sessionId];
    },
  };
}

/** 事件 → 分段检测用的 {text} 列表（只读文本，不猜结构）。
 *  宿主真实事件把用户正文放在 data.content[].text（user/message、assistant/message），
 *  只有测试夹具用扁平 {text}；三种形态都读，否则 markers 在真机恒 false（AC-R3-9 实拍发现的缺陷）。 */
export function eventsToMessages(events) {
  return events.map((e) => ({ text: textOf(e) }));
}

/**
 * 注入正文（新会话首条 user/message）。刻意不含 "[Checkpoint N]"/"[Handoff · part N]" 形态：
 * 那是模式检测的降级信号，自己写进去会让下一轮 auto 误降 manual（S9 三路线要求的 auto 直通）。
 * cluster_id / parent_session_id 两行是重建对账标记（rebuildFromTitles 的 markers 来源）。
 */
export function renderHandoffMessage(payload, { volume = null, at = null } = {}) {
  const lines = [];
  lines.push(`【分卷交接】${volume ? `进入第 ${volume} 卷` : '进入新卷'} ← 会话 ${payload.from_session_id ?? '(未知)'}`);
  lines.push('rollover: v1');
  lines.push(`cluster_id: ${payload.cluster?.cluster_id ?? payload.cluster?.degraded_link ?? 'unknown'}`);
  lines.push(`parent_session_id: ${payload.from_session_id ?? 'unknown'}`);
  if (at) lines.push(`at: ${at}`);
  lines.push('');
  const segs = Object.entries(payload.summary);
  const covered = (kw) => segs.some(([name]) => name.includes(kw)); // 八段摘要已覆盖的块不再重复贴
  segs.forEach(([name, text], i) => { lines.push(`## ${i + 1}. ${name}`, String(text), ''); });
  lines.push('## 待办（旧卷最后一次投影）', todosMarkdown(Array.isArray(payload.todos) ? payload.todos : []), '');
  const cs = payload.current_step;
  if (cs && typeof cs === 'object') {
    const items = Array.isArray(payload.todos) ? payload.todos : [];
    const cur = items[cs.index - 1];
    lines.push(`## 当前进度`, `第 ${cs.index} 步进行中${cur ? `：${cur.content}` : ''}`, '');
  } else {
    lines.push('## 当前进度', String(cs ?? '尚未开始'), '');
  }
  const jobs = payload.open_jobs ?? [];
  if (!covered('在跑')) {
    lines.push('## 在跑 / 未收尾任务', jobs.length ? jobs.map((j) => `- ${j.id} \`${j.command ?? ''}\` status=${j.status}${j.recoverable ? '' : '（需重跑）'}`).join('\n') : '无', '');
  }
  if (!covered('约束')) lines.push('## 约束（原文）', (payload.constraints ?? []).map((c) => `- ${c}`).join('\n'), '');
  const files = payload.changed_files ?? [];
  if (!covered('改动文件')) lines.push('## 改动文件', files.length ? files.map((f) => `- ${f.path}${f.deleted ? '（已删除）' : ''}${f.note ? ` — ${f.note}` : ''}`).join('\n') : '无', '');
  return lines.join('\n');
}

function result(status, reason, extra = {}) { return { status, reason, ...extra }; }

/**
 * 跑一次分卷事务。host 接口（全部 async，夹具可内存实现）：
 *   listEvents(sessionId) / getTitle(sessionId) / listTitles() / getTodos(sessionId)
 *   inFlightTools(sessionId) / isSubagent(sessionId) / listRunningJobs()
 *   createSession({cwd}) -> {sessionId} / injectFirstMessage(sessionId, text) / renameSession(sessionId, title)
 *   log(event, data)
 */
export async function performRollover({
  host, sessionId, index, persistence, state, config = {}, summarySegments,
  currentStepIndex = null, activeIndexes = [], constraints = [], changedFiles = [], cwd,
  userRenamed = false, now = () => new Date().toISOString(),
}) {
  const trace = [];
  const mark = (step, data = {}) => { const rec = { step, at: now(), ...data }; trace.push(rec); host.log?.(`rollover:${step}`, rec); return rec; };
  const done = (status, reason, extra = {}) => ({ status, reason, sessionId, trace, ...extra });

  // 只读卷（-1）一律不动：连触发都不许（AC-R3-7 的服务端闸）
  if (state?.isReadonly(sessionId)) return done('skipped', 'readonly');

  // T0 轮次口径：全 log 数 user/message，1 条 = 1 轮
  const events = await host.listEvents(sessionId);
  const turnCount = countTurns(events);
  const threshold = config.threshold ?? DEFAULT_THRESHOLD;
  mark('T0', { turnCount, threshold });
  if (turnCount < threshold) return done('skipped', 'below-threshold', { turnCount });

  // T1 mode 拦截（零副作用）：off 直接返回；manual 只提示；auto 检出外部分段特征降 manual
  const markers = markersFound(eventsToMessages(events));
  const { mode, downgraded } = effectiveRolloverMode(config.mode ?? 'auto', { forceAuto: !!config.forceAuto, hasMarkers: markers });
  mark('T1', { mode, downgraded, markers });
  if (mode === 'off') return done('skipped', 'mode-off');
  if (mode === 'manual') return done('skipped', 'manual-pending', { notice: true, downgraded });

  // T2 硬闸 + 快照（同刻取 running job 全集，切点后新起的不入交接）
  if (await host.isSubagent(sessionId)) return done('skipped', 'subagent-never');
  const inFlight = await host.inFlightTools(sessionId);
  mark('T2', { inFlight: inFlight.length, tools: inFlight.map((t) => t?.name ?? t?.callId ?? '?') });
  if (inFlight.length > 0) return done('skipped', 'unsafe-cut-point', { inFlight: inFlight.length });

  // 命名预演放在建会话之前：cluster-cap / user-renamed 也必须是零副作用
  const currentTitle = await host.getTitle(sessionId);
  const titles = (await host.listTitles()).map((t) => t.title);
  const plan = planVolumeTitles(currentTitle, titles, { userRenamed });
  mark('T2:plan', { currentTitle, ...plan });
  if (!plan.ok) return done('skipped', plan.reason, { currentTitle });

  const jobs = await host.listRunningJobs();
  const todos = await host.getTodos(sessionId);
  mark('T2:snapshot', { jobs: jobs.length, todos: todos.length });

  // T3 八段摘要（失败=不分卷，旧卷零动作；retry 计数由调用方按 index.summary_retry 维护）
  if (!Array.isArray(summarySegments) || summarySegments.length === 0) return done('failed', 'summary-missing');
  const clusterId = index?.get(sessionId)?.cluster_id ?? `cluster:${plan.base}`;
  const built = buildHandoff({
    summarySegments, todos, activeIndexes, currentStepIndex, openJobs: jobs,
    constraints, changedFiles, cluster: { cluster_id: clusterId }, fromSessionId: sessionId,
    toSessionTitle: plan.newTarget,
  });
  mark('T3', { ok: built.ok, bytes: built.bytes, reason: built.reason });
  if (!built.ok) return done('failed', built.reason, { bytes: built.bytes });

  // T4 新建会话（暂不定名：宿主 create 本身没有标题参数）
  let newSessionId;
  try {
    const created = await host.createSession({ cwd });
    newSessionId = created.sessionId;
  } catch (e) {
    mark('T4', { error: String(e?.message ?? e) });
    return done('failed', 'create-failed', { error: String(e?.message ?? e) }); // 四无：无注入/无改名/无索引/无只读
  }
  mark('T4', { newSessionId });

  // T5 注入摘要（首条 user/message）。炸了绝不改名：弃未定名卷、旧卷一字未动，挂待清理
  const text = renderHandoffMessage(built.payload, { volume: plan.newK, at: now() });
  try {
    await host.injectFirstMessage(newSessionId, text);
  } catch (e) {
    mark('T5', { error: String(e?.message ?? e) });
    state?.pendingAdd({ sessionId: newSessionId, kind: 'abandoned-untitled', reason: 'inject-failed', at: now(), error: String(e?.message ?? e) });
    return done('failed', 'inject-failed', { newSessionId, abandoned: newSessionId, error: String(e?.message ?? e) });
  }
  mark('T5', { bytes: text.length });

  // T6 旧卷改名（仅当旧卷还是原始标题；已是 -k 的卷不动）
  const renamedOld = [];
  if (plan.oldTarget && plan.oldTarget !== currentTitle) {
    try {
      await host.renameSession(sessionId, plan.oldTarget);
      renamedOld.push({ sessionId, from: currentTitle, to: plan.oldTarget });
    } catch (e) {
      mark('T6', { error: String(e?.message ?? e) });
      state?.pendingAdd({ sessionId: newSessionId, kind: 'abandoned-untitled', reason: 'rename-old-failed', at: now(), error: String(e?.message ?? e) });
      return done('failed', 'rename-old-failed', { newSessionId, abandoned: newSessionId });
    }
    mark('T6', { to: plan.oldTarget, bumped: plan.bumped });
  } else {
    mark('T6', { skipped: true, reason: 'already-volume' });
  }

  // T7 新卷改名。炸了回滚旧卷改名（保原名），新卷仍未定名挂待清理
  try {
    await host.renameSession(newSessionId, plan.newTarget);
    mark('T7', { to: plan.newTarget, bumped: plan.bumped });
  } catch (e) {
    mark('T7', { error: String(e?.message ?? e) });
    const rolledBack = [];
    let rollbackFailed = false;
    for (const r of renamedOld) {
      try { await host.renameSession(r.sessionId, r.from); rolledBack.push(r); }
      catch (e2) { rollbackFailed = true; mark('T7:rollback-failed', { sessionId: r.sessionId, error: String(e2?.message ?? e2) }); }
    }
    state?.pendingAdd({ sessionId: newSessionId, kind: 'abandoned-untitled', reason: 'rename-new-failed', at: now(), error: String(e?.message ?? e) });
    // rollbackFailed 决定告警文案：回滚失败时「已保留原名」不成立（B6 第二句的前提，已核定）
    return done('failed', 'rename-new-failed', { newSessionId, abandoned: newSessionId, rolledBack, rollbackFailed });
  }

  // T8 提交：簇索引（七字段）+ turn_counts 同文件同原子提交，旧卷置只读标记
  const oldRec = index.record({
    sessionId, clusterId, parentSessionId: null,
    volNo: plan.oldTarget ? parseVolume(plan.oldTarget).k : plan.oldK,
    nameSuffix: plan.oldTarget ? `-${parseVolume(plan.oldTarget).k}` : `-${plan.oldK}`,
    rolloverState: 'sealed', readonlyByRollover: true,
  });
  const newRec = index.record({
    sessionId: newSessionId, clusterId, parentSessionId: sessionId,
    volNo: plan.newK, nameSuffix: `-${plan.newK}`, rolloverState: 'active', readonlyByRollover: false,
  });
  index.setTurnCounts?.({ ...index.turnCounts?.(), [sessionId]: turnCount, [newSessionId]: 0 });
  const persisted = persistence?.persist?.() ?? null; // null = 显式降级（L3），不静默丢：调用方看 persistence.degraded
  const ro = state?.markReadonly(sessionId, { clusterId, volNo: oldRec.vol_no, rolledAt: now(), rolledInto: newSessionId }) ?? null;
  state?.pendingRemove(newSessionId);
  mark('T8', { clusterId, persisted, readonly: !!ro, degraded: persistence?.degraded ?? false });

  return {
    status: 'rolled-over', reason: 'threshold-reached', sessionId, newSessionId, trace, turnCount,
    clusterId,
    from: { sessionId, title: plan.oldTarget ?? currentTitle, record: oldRec },
    to: { sessionId: newSessionId, title: plan.newTarget, record: newRec },
    persisted, degraded: persistence?.degraded ?? false,
    handoffBytes: built.bytes,
  };
}