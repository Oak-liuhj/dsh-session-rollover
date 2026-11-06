// 交接消息排版与模式检测输入转换；不访问宿主或文件系统。
import {todosMarkdown} from '../domain/handoff.mjs';
import {textOf} from '../domain/summary.mjs';

/** 事件 → 分段检测用的 {text} 列表（只读文本，不猜结构）。
 *  宿主真实事件把用户正文放在 data.content[].text（user/message、assistant/message），
 *  只有测试夹具用扁平 {text}；三种形态都读，否则 markers 在真机恒 false（AC-R3-9 实拍发现的缺陷）。 */
export function eventsToMessages(events) {
    return events.map((e) => {
        const type = e.type ?? e.kind;
        const source = e.data?.source ?? e.source;
        return {type, text: textOf(e), internal: textOf(e).startsWith('【分卷交接】') ||
            (type === 'user/message' && !!source?.kind && source.kind !== 'user')};
    });
}

/**
 * 注入正文（新会话首条 user/message）。刻意不含 "[Checkpoint N]"/"[Handoff · part N]" 形态：
 * 那是模式检测的降级信号，自己写进去会让下一轮 auto 误降 manual（S9 三路线要求的 auto 直通）。
 * cluster_id / parent_session_id 两行是重建对账标记（rebuildFromTitles 的 markers 来源）。
 */
export function renderHandoffMessage(payload, {volume = null, at = null} = {}) {
    const lines = [];
    lines.push(`【分卷交接】${volume ? `进入第 ${volume} 卷` : '进入新卷'} ← 会话 ${payload.from_session_id ?? '(未知)'}`);
    lines.push('rollover: v1');
    lines.push(`cluster_id: ${payload.cluster?.cluster_id ?? payload.cluster?.degraded_link ?? 'unknown'}`);
    lines.push(`parent_session_id: ${payload.from_session_id ?? 'unknown'}`);
    if (at) lines.push(`at: ${at}`);
    lines.push('');
    const segs = Object.entries(payload.summary);
    const covered = (kw) => segs.some(([name]) => name.includes(kw)); // 八段摘要已覆盖的块不再重复贴
    segs.forEach(([name, text], i) => {
        lines.push(`## ${i + 1}. ${name}`, String(text), '');
    });
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
    lines.push('## 交接快照 JSON', '```json', JSON.stringify(payload), '```');
    return lines.join('\n');
}
