// 旧卷待办快照：取日志里最后一次 todo/write。
// 不能读实时投影：宿主 todos 投影在 turn/start 归零（tool-todo: apply 遇 turn/start 返回 null），
// 而分卷判定恰好发生在第 N+1 轮 pre-step（turn/start 之后），此刻 stateOf 必为 null。
// 判定/交接要的是「上一轮结束时的清单」，日志最后一条 todo/write 才是它。

function typeOf(e) {
    return e?.type ?? e?.kind;
}

export function lastTodos(events = []) {
    let last = null;
    for (const e of events) {
        if (typeOf(e) !== 'todo/write') continue;
        const todos = e?.data?.todos;
        if (Array.isArray(todos)) last = todos;
    }
    return last ?? [];
}

export function activeIndex(todos = []) {
    const i = todos.findIndex((t) => t?.status === 'in_progress');
    return i < 0 ? null : i + 1;
}