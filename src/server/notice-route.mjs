// 一次性提示的同源 HTTP 入口；认证由宿主 webServer 统一处理。
/** client 半取件口：同源 GET，宿主 webServer 统一过登录校验（dsh-pick 同款）。
 *  取走即删＝「未发显」标记的投递；渲染由 client 半负责，server 不碰 DOM。 */
export function attachNoticeRoutes(ctx, {handlePending, log}) {
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
            log('route-registered', {path: '/api-dsh-session-rollover/pending'});
            scope.effect?.(() => () => {
                try {
                    dispose?.();
                } catch { /* 卸载容错 */
                }
            }, 'rollover: pending route');
            return undefined;
        });
    } catch (e) {
        log('route-failed', {error: String(e?.message ?? e)});
    }
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
