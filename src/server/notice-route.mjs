// 一次性提示的同源 HTTP 入口；认证由宿主 webServer 统一处理。
/** client 半取件口：同源 GET，宿主 webServer 统一过登录校验（dsh-pick 同款）。
 *  取走即删＝「未发显」标记的投递；渲染由 client 半负责，server 不碰 DOM。 */
export function attachNoticeRoutes(ctx, {handlePending, log, plugin}) {
    if (typeof ctx.inject !== 'function') return;
    try {
        ctx.inject(['webServer'], (scope) => {
            const ws = scope.webServer ?? scope.get?.('webServer');
            if (!ws || typeof ws.register !== 'function') {
                log('route-unavailable');
                return undefined;
            }
            const dispose = ws.register({
                kind: 'exact',
                path: '/api-dsh-session-rollover/pending',
                handler: (req, res) => handlePending(req, res),
            });
            const control = plugin && ws.register({kind: 'exact', path: '/api-dsh-session-rollover/session',
                handler: (req, res) => handleSessionRequest(plugin, req, res)});
            log('route-registered', {path: '/api-dsh-session-rollover/pending'});
            scope.effect?.(() => () => {
                try {
                    dispose?.();
                    control?.();
                } catch { /* 卸载容错 */
                }
            }, 'rollover: pending route');
            return undefined;
        });
    } catch (e) {
        log('route-failed', {error: String(e?.message ?? e)});
    }
}

/** 与 R2 桥接相同的 owner 认证和同源约束；不接收浏览器传来的快照正文。 */
export async function handleSessionRequest(plugin, req, res) {
    const send = (code, value) => { res.writeHead(code, {'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store'}); res.end(JSON.stringify(value)); };
    try {
        const admission = plugin.ctx.connection?.admit(req);
        if (!admission || 'rejection' in admission) return send(admission?.rejection ?? 401, {error: 'unauthorized'});
        if (admission.peer.principal?.kind !== 'owner') return send(403, {error: 'owner-required'});
        if (req.method === 'GET') {
            const id = new URL(req.url, 'http://localhost').searchParams.get('session');
            if (!/^[\w-]{1,160}$/.test(id ?? '')) return send(400, {error: 'invalid-session'});
            if (!plugin.sessionOf(id)) return send(404, {error: 'session-unavailable'});
            return send(200, {...plugin.handoffInfo(id), completedSessionId: plugin.lastCompleted?.get(id) ?? null});
        }
        if (req.method !== 'POST') return send(405, {error: 'method-not-allowed'});
        if (!/^application\/json(?:;|$)/i.test(req.headers?.['content-type'] ?? '')) return send(415, {error: 'json-required'});
        if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) return send(403, {error: 'origin-mismatch'});
        let body = '';
        for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 4096) return send(413, {error: 'too-large'}); }
        let input;
        try { input = JSON.parse(body); } catch { return send(400, {error: 'invalid-json'}); }
        if (!/^[\w-]{1,160}$/.test(input?.sessionId ?? '')) return send(400, {error: 'invalid-session'});
        if (!plugin.sessionOf(input.sessionId)) return send(404, {error: 'session-unavailable'});
        if (input.action === 'readonly' && typeof input.readonly === 'boolean') {
            if (!plugin.handoffInfo(input.sessionId).sealed) return send(409, {error: 'session-not-archived'});
            return send(200, plugin.setReadonly(input.sessionId, input.readonly));
        }
        if (input.action === 'rollover') {
            const result = await plugin.rolloverNow(input.sessionId);
            return send(result.status === 'rolled-over' ? 200 : 409, result);
        }
        if (input.action === 'new') {
            const result = await plugin.hostFor(plugin.sessionOf(input.sessionId)).createSession();
            return send(200, {...result, status: 'created', independent: true});
        }
        return send(400, {error: 'invalid-action'});
    } catch (e) { return send(500, {error: 'operation-failed', message: String(e.message)}); }
}

/** 按会话取走提示，成功取件后即从存储队列删除；此接口不确认浏览器已完成渲染。 */
export function handlePendingNotices({notices: store, log}, req, res) {
    const send = (code, body) => {
        try {
            res.writeHead(code, {'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store'});
            res.end(JSON.stringify(body));
        } catch { /* 连接已断不阻断 */
        }
    };
    try {
        if (req.method !== 'GET') return send(405, {error: 'method-not-allowed'});
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const sessionId = url.searchParams.get('session');
        if (!sessionId) return send(400, {error: 'missing-session'});
        const notices = store.takePending(sessionId);
        if (notices.length) log('notice-delivered', {
            sessionId,
            count: notices.length,
            reasons: notices.map((n) => n.reason)
        });
        return send(200, {version: 1, notices});
    } catch (e) {
        log('notice-deliver-failed', {error: String(e?.message ?? e)});
        return send(500, {error: 'internal'});
    }
}
