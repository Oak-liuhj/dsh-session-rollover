// 只探测已声明的宿主服务；不根据版本号猜测方法签名，也不在探测时写会话。
const REQUIRED = {
    sessions: ['get', 'list'],
    sessionTitle: ['get', 'rename'],
    sessionController: ['create', 'prompt', 'selectModel'],
    sessionProjections: ['stateOf'],
    workspaceRegistry: ['list'],
};

export const INCOMPATIBLE_MESSAGE = '当前 DSH 的会话接口与插件不兼容，已暂停分卷。原会话与归档数据保留，请更新插件后重试。';

/** 方法存在只代表能力探测通过；事件语义、权限和界面仍需逐版本验收。 */
export function inspectHost(ctx, session) {
    const missing = [];
    for (const [service, methods] of Object.entries(REQUIRED)) {
        for (const method of methods) {
            try { if (typeof ctx[service]?.[method] !== 'function') missing.push(`${service}.${method}`); }
            catch { missing.push(`${service}.${method}`); }
        }
    }
    if (session && typeof session.snapshotEvents !== 'function') missing.push('session.snapshotEvents');
    return {contractVersion: 1, compatible: missing.length === 0, missing,
        message: missing.length ? INCOMPATIBLE_MESSAGE : null};
}

/** 在创建新卷之前检查同步读取面的形状；遇到变化时停止，不用空数据继续交接。 */
export function preflightHost(ctx, session, services = ctx) {
    const report = inspectHost(ctx, session);
    if (!report.compatible) return report;
    try {
        if (!Array.isArray(session.snapshotEvents())) throw new Error('session.snapshotEvents:array-required');
        const sessions = ctx.sessions.list();
        if (!Array.isArray(sessions) || sessions.some(s => !s || typeof s.id !== 'string' || !s.id)) {
            throw new Error('sessions.list:session-id-required');
        }
        const workspaces = ctx.workspaceRegistry.list();
        if (!Array.isArray(workspaces) || workspaces.some(w => !w || typeof w.id !== 'string' || !w.id ||
            !Array.isArray(w.sessionIds) || w.sessionIds.some(id => typeof id !== 'string'))) {
            throw new Error('workspaceRegistry.list:sessionIds-required');
        }
        const title = ctx.sessionTitle.get(session);
        if (title != null && (typeof title !== 'object' || typeof title.title !== 'string')) {
            throw new Error('sessionTitle.get:title-required');
        }
        const cwd = readWorkingDirectory(ctx, services, session);
        if (cwd != null && typeof cwd !== 'string') throw new Error('workingDirectory:string-required');
        readModelSelection(ctx, services, session);
    } catch (error) {
        return {...report, compatible: false, missing: [String(error?.message ?? error)], message: INCOMPATIBLE_MESSAGE};
    }
    return report;
}

/** 新版优先使用领域服务；旧宿主回退到已验证的公开投影入口。 */
export function readWorkingDirectory(ctx, services, session) {
    return typeof services.workingDirectory?.get === 'function'
        ? services.workingDirectory.get(session)
        : ctx.sessionProjections.stateOf(session, 'workingDirectory');
}

function validateModel(selection) {
    if (selection != null && (typeof selection.provider !== 'string' || typeof selection.model !== 'string' ||
        !selection.provider || !selection.model ||
        (selection.reasoningEffort != null && typeof selection.reasoningEffort !== 'string'))) {
        throw new Error('modelSelection:provider-model-required');
    }
    return selection;
}

export function readModelSelection(ctx, services, session) {
    const agent = services.agents?.get?.(session.id);
    if (agent) {
        if (typeof agent.model?.current !== 'function') throw new Error('agents.model.current:method-required');
        const current = validateModel(agent.model.current());
        if (current != null) return current;
    }
    const selection = ctx.sessionProjections.stateOf(session, 'modelSelection');
    if (selection == null) return undefined;
    if (typeof selection !== 'object' || Array.isArray(selection) ||
        !('pending' in selection || 'lastUsed' in selection)) throw new Error('modelSelection:projection-shape-required');
    validateModel(selection.pending);
    validateModel(selection.lastUsed);
    return selection.pending ?? selection.lastUsed;
}
