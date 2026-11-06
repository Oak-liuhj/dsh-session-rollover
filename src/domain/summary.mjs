// dsh-session-rollover · 八段摘要（无模型依赖的确定性版本；后续可换成模型生成的同结构输入，接口不变）
// 裁定依据：AC-R3-2 要求八段全非空；把「有据可查」的段从日志/投影直接摘出来，比让模型自由发挥更可复核。
import {eventType, isUserMessage} from './turns.mjs';

const FILE_HINT = /(?:^|[\s"'`(（])([A-Za-z]:[\\/][^\s"'`]+|(?:\.{0,2}[\\/])?(?:[\w.@-]+[\\/])+[\w.@-]+\.[A-Za-z0-9]{1,8})/g;
const CONSTRAINT_HINT = /(不许|不要|禁止|必须|不得|硬约束|一票否决|不能|只能)/;

/** 一条消息事件的正文：宿主落盘形状是 data.content=[{type:'text',text}]，不是 data.text
 *  application/handoff-message.mjs 复用此处，避免正文解析口径不一致。 */
export function textOf(e) {
    const d = e?.data ?? {};
    const c = d.content ?? e?.content;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) return c.map((p) => (typeof p === 'string' ? p : p?.text ?? '')).filter(Boolean).join('\n');
    return String(e?.text ?? d.text ?? '');
}

function textsOf(events, kind) {
    return events.filter((e) => kind === 'user/message' ? isUserMessage(e) : eventType(e) === kind).map(textOf).filter((t) => t.trim());
}

/** 从 tool/call 的 arguments 里捞文件路径（⑥ 改动文件；只报「碰过」不判改没改） */
export function changedFilesFrom(events) {
    const seen = new Map();
    for (const e of events) {
        if (eventType(e) !== 'tool/call') continue;
        const raw = typeof e.data?.arguments === 'string' ? e.data.arguments : JSON.stringify(e.data?.arguments ?? {});
        for (const m of raw.matchAll(FILE_HINT)) {
            const path = m[1].replace(/^[（(]|["'`]$/g, '');
            if (path.length < 3 || path.startsWith('http')) continue;
            seen.set(path, {path, note: e.data?.name ?? 'tool', deleted: false});
        }
    }
    return [...seen.values()];
}

export function constraintsFrom(events) {
    const out = [];
    for (const t of textsOf(events, 'user/message')) {
        for (const line of t.split(/\r?\n/)) {
            if (CONSTRAINT_HINT.test(line)) out.push(line.trim());
        }
    }
    return [...new Set(out)];
}

/**
 * 八段：[任务目标, 已完成, 进行中, 下一步, 约束, 已知问题, 在跑任务, 改动文件]
 * @returns {Array<[string,string]>} 段名与文本，八段皆非空
 */
export function buildSummarySegments({events = [], todos = [], jobs = [], currentStepIndex = null} = {}) {
    const userMsgs = textsOf(events, 'user/message');
    const goal = (userMsgs[0] ?? '').split(/\r?\n/)[0].slice(0, 300) || '未记录（旧卷无用户消息）';
    const done = todos.filter((t) => t.status === 'completed').map((t) => t.content);
    const doing = todos.filter((t) => t.status === 'in_progress').map((t) => t.content);
    const pending = todos.filter((t) => t.status === 'pending').map((t) => t.content);
    const failed = todos.filter((t) => t.status === 'failed').map((t) => t.content); // 数据态四态里的「中断」
    const cur = currentStepIndex != null ? todos[currentStepIndex - 1] : null;
    const files = changedFilesFrom(events);
    const constraints = constraintsFrom(events);
    const list = (a, empty) => (a.length ? a.map((x, i) => `${i + 1}. ${x}`).join('\n') : empty);
    return [
        ['上轮工作摘要', `${goal}\n已完成：\n${list(done, '尚无已完成项')}`],
        ['当前进度与关键约束', `${currentStepIndex ? `第 ${currentStepIndex} 步进行中` : '尚未开始'}\n${list(doing, '无进行中项')}\n关键约束（原文）：\n${list(constraints, '本轮未提供')}\n中断项：\n${list(failed, '无')}`],
        ['文件、代码与未竟事项', `文件：\n${list(files.map(f => f.path), '本轮未提供')}\n未竟后台任务：\n${list(jobs.map(j => `${j.id} ${j.command ?? ''} status=${j.status}${j.recoverable === false ? '（需重跑）' : ''}`), '无后台任务')}`],
        ['下一步与待办快照', list(pending, '本轮未提供')],
    ];
}
