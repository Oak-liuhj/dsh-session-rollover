// dsh-session-rollover · 八段摘要（无模型依赖的确定性版本；后续可换成模型生成的同结构输入，接口不变）
// 裁定依据：AC-R3-2 要求八段全非空；把「有据可查」的段从日志/投影直接摘出来，比让模型自由发挥更可复核。
import {eventType} from './turns.mjs';

const FILE_HINT = /(?:^|[\s"'`(（])([A-Za-z]:[\\/][^\s"'`]+|(?:\.{0,2}[\\/])?(?:[\w.@-]+[\\/])+[\w.@-]+\.[A-Za-z0-9]{1,8})/g;
const CONSTRAINT_HINT = /(不许|不要|禁止|必须|不得|硬约束|一票否决|不能|只能)/;

/** 一条消息事件的正文：宿主落盘形状是 data.content=[{type:'text',text}]，不是 data.text
 *  工程约定：全仓只此一份取值实现，assembly 复用此处，禁止各写一套。 */
export function textOf(e) {
    const d = e?.data ?? {};
    const c = d.content ?? e?.content;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) return c.map((p) => (typeof p === 'string' ? p : p?.text ?? '')).filter(Boolean).join('\n');
    return String(e?.text ?? d.text ?? '');
}

function textsOf(events, kind) {
    return events.filter((e) => eventType(e) === kind).map(textOf).filter((t) => t.trim());
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
    return [...seen.values()].slice(0, 20);
}

export function constraintsFrom(events) {
    const out = [];
    for (const t of textsOf(events, 'user/message')) {
        for (const line of t.split(/\r?\n/)) {
            if (CONSTRAINT_HINT.test(line) && line.trim().length <= 200) out.push(line.trim());
        }
    }
    return [...new Set(out)].slice(0, 8);
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
        ['任务目标', goal],
        ['已完成', list(done, '尚无已完成项')],
        ['进行中', list(doing, cur ? `${cur.content}（第 ${currentStepIndex} 步）` : '无进行中项')],
        ['下一步', list(pending, '无待办项')],
        ['约束', list(constraints, '未识别到显式约束')], // ⑤：原文摘录，不总结
        ['已知问题', list(failed, '无已知中断项')],
        ['在跑任务', list(jobs.map((j) => `${j.id} ${j.command ?? ''} status=${j.status}${j.recoverable === false ? '（需重跑）' : ''}`), '无后台任务')],
        ['改动文件', list(files.map((f) => f.path), '未从工具调用中识别到文件路径')],
    ];
}