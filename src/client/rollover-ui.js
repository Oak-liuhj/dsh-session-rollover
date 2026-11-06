/** R3 只承担会话状态与交接卡；待办进度复用 R2，不另建任务状态。 */
export function createRolloverUI(React) {
    const {createElement: h, useState, useEffect, useRef} = React;
    const API = '/api-dsh-session-rollover/session';
    const entries = new Map();
    let navigate = null;
    let renderInline = false;

    async function request(sessionId, action) {
        const response = await fetch(action ? API : `${API}?session=${encodeURIComponent(sessionId)}`, action ? {
            method: 'POST', credentials: 'same-origin', headers: {'content-type': 'application/json'},
            body: JSON.stringify({sessionId, ...action}),
        } : {credentials: 'same-origin', cache: 'no-store'});
        const result = await response.json();
        if (!response.ok) throw new Error(result.message ?? result.error ?? '会话状态读取失败');
        return result;
    }

    function entry(id) {
        if (!entries.has(id)) entries.set(id, {value: null, listeners: new Set(), stop: null});
        return entries.get(id);
    }

    function publish(id, value) {
        const item = entry(id);
        item.value = value;
        for (const listener of item.listeners) listener(value);
    }

    function useInfo(id) {
        const [state, setState] = useState(() => entry(id).value);
        useEffect(() => {
            if (!id) return;
            const item = entry(id);
            let alive = true;
            const receive = value => { if (alive) setState(value); };
            item.listeners.add(receive);
            receive(item.value);
            if (!item.stop) {
                let stopped = false, timer;
                const poll = async () => {
                    try {
                        const value = await request(id);
                        if (!stopped) publish(id, value);
                    } catch (e) {
                        if (!stopped) publish(id, {...item.value, sessionId: id, error: '暂时无法读取会话状态，请稍后重试。'});
                    }
                    if (!stopped) timer = setTimeout(poll, 1000);
                };
                item.stop = () => { stopped = true; clearTimeout(timer); };
                void poll();
            }
            return () => {
                alive = false;
                item.listeners.delete(receive);
                if (!item.listeners.size) { item.stop?.(); item.stop = null; entries.delete(id); }
            };
        }, [id]);
        // 会话切换当帧不借用上一会话的只读状态。
        return state?.sessionId === id ? state : null;
    }

    function Source({source}) {
        return source ? h('button', {type: 'button', className: 'dsr-link',
            disabled: !navigate, onClick: () => navigate?.(source.sessionId),
            'aria-label': `跳转到上一卷 ${source.title}`}, `承自 ${source.title}`) : null;
    }

    function ReadonlyControl({info}) {
        const [busy, setBusy] = useState(false);
        const [error, setError] = useState('');
        if (!info?.sealed) return null;
        return h('div', {className: 'dsr-archive', role: 'status'},
            h('span', null, info.readonly ? '此会话已归档，默认只读。历史可回看。' : '此会话已归档，已允许再次写入。'),
            h('button', {type: 'button', role: 'switch', 'aria-checked': !info.readonly,
                disabled: busy, onClick: async () => {
                    setBusy(true); setError('');
                    try { publish(info.sessionId, await request(info.sessionId, {action: 'readonly', readonly: !info.readonly})); }
                    catch { setError('保存失败，请重试；写入权限未改变。'); }
                    finally { setBusy(false); }
                }}, busy ? '正在保存…' : info.readonly ? '允许再次写入' : '恢复只读'),
            error ? h('span', {role: 'alert'}, error) : null);
    }

    function Header(props) {
        const info = useInfo(props.sessionId);
        const [busy, setBusy] = useState(false);
        const [error, setError] = useState('');
        const dialog = useRef(null);
        const action = async type => {
            setBusy(true); setError('');
            try {
                const result = await request(props.sessionId, {action: type});
                if (result.newSessionId ?? result.sessionId) navigate?.(result.newSessionId ?? result.sessionId);
                dialog.current?.close();
            } catch { setError('操作未完成，请稍后重试或检查会话状态。'); }
            finally { setBusy(false); }
        };
        if (!info) return null;
        return h('div', {className: 'dsr-header'},
            h('span', {className: 'dsr-chip'}, `本卷第 ${info.turnCount} 轮 / 阈值 ${info.threshold}`),
            info.volume ? h('span', {className: 'dsr-chip'}, `卷 ${info.volume}/${info.cap}`) : null,
            info.sealed ? h('span', {className: 'dsr-chip'}, info.readonly ? '归档只读' : '归档 · 已恢复写入') : null,
            info.source ? h('span', {className: 'dsr-source'}, h(Source, {source: info.source}),
                info.previousTurnCount != null ? ` · 第 ${info.previousTurnCount} 轮` : '') : null,
            h('button', {type: 'button', 'aria-label': '会话分卷操作', onClick: () => dialog.current?.showModal()}, '⋯'),
            h('dialog', {ref: dialog, className: 'dsr-actions', 'aria-label': '会话操作'},
                h('div', {className: 'dsr-actions-body'},
                    h('button', {type: 'button', disabled: busy || info.sealed || !navigate, onClick: () => action('rollover')}, '现在换会话'),
                    h('button', {type: 'button', disabled: busy || !navigate, onClick: () => action('new')}, '新建独立会话'),
                    h('button', {type: 'button', onClick: () => dialog.current?.close()}, '关闭'))),
            error ? h('span', {role: 'alert'}, error) : null);
    }

    function Badges(props) {
        const info = useInfo(props.sessionId);
        if (!info?.volume) return null;
        return h('span', {className: `dsr-row-badges${props.compact ? ' dsr-row-compact' : ''}`, title: `卷 ${info.volume}/${info.cap}${info.readonly ? ' · 归档只读' : ''}`},
            info.readonly ? h('span', null, '只读') : null, h('span', null, `${info.volume}/${info.cap}`));
    }

    function Card({payload, source}) {
        const [expanded, setExpanded] = useState(false);
        const [jsonOpen, setJsonOpen] = useState(false);
        const [message, setMessage] = useState('');
        if (!payload) return null;
        const todos = Array.isArray(payload.todos) ? payload.todos : [];
        const summary = payload.summary ?? {};
        const active = payload.current_step?.active_items ?? [];
        const text = Object.entries(summary).map(([k, v]) => `${k}\n${v}`).join('\n');
        const chunks = [
            ['上轮工作摘要', summary['上轮工作摘要'] ?? summary['任务目标'] ?? '本轮未提供'],
            ['当前工作', active.length ? active.map(n => `第 ${n} 步进行中：${todos[n - 1]?.content ?? ''}`).join('\n') : '尚未开始'],
            ['关键约束（原文）', (payload.constraints ?? []).join('\n') || '本轮未提供'],
            ['文件与代码', (payload.changed_files ?? []).map(f => `${f.path}${f.deleted ? '（已删除）' : ''}`).join('\n') || '本轮未提供'],
            ['未竟后台任务', (payload.open_jobs ?? []).map(j => `${j.id} · ${j.command ?? ''} · ${j.status}${j.recoverable === false ? '（需重跑）' : ''}`).join('\n') || '无后台任务'],
            ['待办快照', todos.length ? todos.map((t, i) => `${i + 1}. ${t.content} · ${{completed: '已完成', in_progress: '进行中', pending: '待办', failed: '中断'}[t.status] ?? t.status}`).join('\n') : '无结构化待办'],
        ];
        return h('section', {className: 'dsr-card', 'aria-label': '接续摘要'},
            h('div', {className: 'dsr-card-head'}, h('strong', null, '接续摘要'), h(Source, {source}),
                payload.cluster?.vol_no ? h('span', {className: 'dsr-chip'}, `卷 ${payload.cluster.vol_no}/9`) : null,
                payload.health ? h('span', {className: 'dsr-chip'}, `摘要重试 ${payload.health.summary_retry}/2`) : null),
            h('div', {className: expanded ? 'dsr-card-content' : 'dsr-card-preview'},
                expanded ? chunks.map(([name, value]) => h('div', {className: 'dsr-section', key: name},
                    h('h4', null, name), h('div', {className: 'dsr-prewrap'}, value))) : text),
            h('button', {type: 'button', className: 'dsr-link dsr-expand', 'aria-expanded': expanded,
                onClick: () => setExpanded(!expanded)}, expanded ? '收起摘要' : '展开全部'),
            h('div', {className: 'dsr-json-controls'},
                h('button', {type: 'button', 'aria-expanded': jsonOpen, onClick: () => setJsonOpen(!jsonOpen)}, jsonOpen ? '收起快照 JSON' : '展开快照 JSON'),
                h('button', {type: 'button', onClick: async () => {
                    try { await navigator.clipboard.writeText(JSON.stringify(payload, null, 2)); setMessage('快照已复制'); }
                    catch { setJsonOpen(true); setMessage('复制失败，可选择下方 JSON 手动复制。'); }
                }}, '复制快照')),
            jsonOpen ? h('pre', {className: 'dsr-json', tabIndex: 0, 'aria-label': '完整交接快照 JSON'}, JSON.stringify(payload, null, 2)) : null,
            message ? h('div', {role: 'status'}, message) : null);
    }

    function Dock(props) {
        const info = useInfo(props.sessionId);
        const previous = useRef(null);
        useEffect(() => {
            const next = info?.completedSessionId;
            // 只自动跳转浏览器亲历的“活动→封卷”；回看历史旧卷时不能被再次弹回新卷。
            if (next && previous.current?.sessionId === props.sessionId && previous.current.sealed === false && info.sealed && navigate) navigate(next);
            if (info) previous.current = info;
        }, [info, props.sessionId]);
        if (!info) return null;
        return h('div', {className: 'dsr-dock'},
            info.error ? h('div', {role: 'alert'}, info.error) : null,
            h(ReadonlyControl, {key: props.sessionId, info}),
            info.capped ? h('div', {role: 'status', className: 'dsr-warning'}, '同簇已达 9 卷上限（9/9），请通过会话操作新建独立会话。') : null,
            info.retryLimitReached ? h('div', {role: 'status', className: 'dsr-warning'}, '摘要生成失败，已停止自动重试。可在修正内容后手动换会话。') : null,
            info.degraded ? h('div', {role: 'alert'}, '分卷索引保存失败，重启前请检查数据目录权限。') : null,
            !renderInline && info.handoff ? h(Card, {key: props.sessionId, payload: info.handoff, source: info.source}) : null);
    }

    function parseHandoff(text) {
        if (!text.startsWith('【分卷交接】')) return null;
        try {
            const payload = JSON.parse(/```json\s*([\s\S]*?)```/.exec(text)?.[1]);
            return payload.rollover === 'v1' ? payload : null;
        } catch { return null; }
    }

    /** 释放时仅撤销自己的禁用；保留模型选择等其他插件后来设置的阻塞原因。 */
    function blockComposer(blocks, id, reason) {
        const store = blocks.storeFor(id);
        let previous = store.getSnapshot();
        const own = {reason};
        let writing = false;
        const enforce = () => {
            if (writing || store.getSnapshot() === own) return;
            previous = store.getSnapshot();
            writing = true;
            try { blocks.set(id, own); } finally { writing = false; }
        };
        const off = store.subscribe(enforce);
        enforce();
        return () => { off(); if (store.getSnapshot() === own) blocks.set(id, previous); };
    }

    function apply(ctx) {
        if (!ctx?.inject) return;
        const style = document.createElement('style');
        style.textContent = CSS;
        style.setAttribute('data-dsh-plugin', 'dsh-session-rollover-ui');
        document.head.appendChild(style);
        ctx.effect?.(() => () => { style.remove(); for (const item of entries.values()) item.stop?.(); entries.clear(); });
        ctx.inject(['uiWorkspace'], scope => {
            navigate = id => scope.uiWorkspace.openSession(id);
            scope.effect?.(() => () => { navigate = null; });
        });
        ctx.inject(['slots'], scope => {
            const slots = scope.slots;
            const mount = (name, Component, options = {}) => scope.effect(() => slots.inject(name, () => slots.register({name,
                id: 'dsh-session-rollover', order: 35, ...options}, Component)));
            mount('conversation.session.header.actions', Header);
            mount('conversation.input.dock', Dock);
            mount('sidebar.session.row.trailing', Badges);
            // 已安装的较旧宿主只开放 leading；新宿主优先 trailing，避免重复徽标。
            mount('sidebar.session.row.leading', props => slots.snapshot?.('sidebar.session.row.trailing')?.length
                ? null : h(Badges, {...props, compact: true}));
            // 使用宿主公开 composer block 服务；覆盖输入组件会破坏其子槽授权。
            scope.inject(['conversation'], inputScope => {
                function ComposerGuard(props) {
                    const info = useInfo(props.sessionId);
                    const reason = !info ? '正在读取会话状态…' : info.readonly
                        ? '归档会话：不可输入，可通过上方开关恢复写入。' : info.error;
                    useEffect(() => props.sessionId && reason
                        ? blockComposer(inputScope.conversation.blocks, props.sessionId, reason) : undefined,
                    [props.sessionId, reason]);
                    return null;
                }
                inputScope.effect(() => slots.inject('conversation.input.dock', () => slots.register({
                    name: 'conversation.input.dock', id: 'dsr-readonly-guard', order: 34}, ComposerGuard)));
            });
            scope.inject(['uiConversation'], textScope => {
                if (!textScope.uiConversation.userText?.register) return;
                textScope.effect(() => textScope.uiConversation.userText.register({id: 'dsr-handoff', order: -100,
                    match(text, from) {
                        if (from !== 0) return;
                        const payload = parseHandoff(text);
                        return payload ? {id: 'dsr-handoff', start: 0, end: text.length, data: payload} : undefined;
                    }}));
                mount('conversation.user.text.node', props => h(Card, {payload: props.node.data,
                    source: props.node.data.from_session_id && !props.node.data.cluster?.independent ? {sessionId: props.node.data.from_session_id, title: props.node.data.from_title ?? '上一卷'} : null}), {key: 'dsr-handoff'});
                renderInline = true;
                textScope.effect?.(() => () => { renderInline = false; });
            });
        });
    }

    const CSS = `
.dsr-header,.dsr-dock,.dsr-card,.dsr-row-badges{--dsr-bg:var(--dsw-alias-bg-base, #fff);--dsr-fg:var(--dsw-alias-label-primary, #111827);--dsr-muted:#61666b;--dsr-line:rgba(0,0,0,.12);--dsr-accent:#3d56d6;--dsr-weak:rgba(77,107,254,.09);color:var(--dsr-fg);font:13px/20px -apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei',sans-serif;box-sizing:border-box}
body[data-ds-dark-theme] :is(.dsr-header,.dsr-dock,.dsr-card,.dsr-row-badges),html[data-theme=dark] :is(.dsr-header,.dsr-dock,.dsr-card,.dsr-row-badges),html.dark :is(.dsr-header,.dsr-dock,.dsr-card,.dsr-row-badges){--dsr-bg:#171a1f;--dsr-fg:#f9fafb;--dsr-muted:#cfd3d6;--dsr-line:rgba(255,255,255,.16);--dsr-accent:#95a8ff;--dsr-weak:rgba(107,133,255,.13)}
@media(prefers-color-scheme:dark){html:not([data-theme=light]):not([data-ds-theme-source=light]) :is(.dsr-header,.dsr-dock,.dsr-card,.dsr-row-badges){--dsr-bg:#171a1f;--dsr-fg:#f9fafb;--dsr-muted:#cfd3d6;--dsr-line:rgba(255,255,255,.16);--dsr-accent:#95a8ff}}
.dsr-header{display:flex;gap:6px;align-items:center;flex-wrap:wrap;min-width:0}.dsr-chip{display:inline-flex;align-items:center;border:1px solid var(--dsr-line);border-radius:99px;padding:1px 7px;font-size:11.5px;white-space:nowrap;color:var(--dsr-muted)}
.dsr-source{font-size:12px;color:var(--dsr-muted)}.dsr-link{color:var(--dsr-accent)!important;background:none!important}.dsr-header button,.dsr-dock button,.dsr-card button,.dsr-actions summary{font:inherit;cursor:pointer;min-height:28px;min-width:28px;border:1px solid var(--dsr-line);background:var(--dsr-bg);color:inherit;border-radius:6px;padding:3px 8px}.dsr-link{border:0!important}.dsr-header button:disabled,.dsr-dock button:disabled{opacity:.6;cursor:default}
.dsr-dock{width:100%;min-width:0;display:flex;flex-direction:column;gap:8px}.dsr-archive{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 10px;border:1px solid var(--dsr-line);border-radius:8px;background:var(--dsr-weak)}.dsr-archive button{margin-left:auto}.dsr-warning{padding:8px 10px;border:1px solid var(--dsr-line);border-radius:8px}
.dsr-card{display:block;flex:0 0 auto;min-width:0;max-width:100%;border:1px solid var(--dsr-line);border-radius:10px;background:var(--dsr-bg);overflow-wrap:anywhere;white-space:normal;margin:8px 0}.dsr-card-head{display:flex;align-items:center;flex-wrap:wrap;gap:6px;background:var(--dsr-weak);border-radius:10px 10px 0 0;padding:10px 12px}.dsr-card-preview{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;margin:10px 12px;white-space:pre-wrap}.dsr-card-content{display:block}.dsr-section{padding:8px 12px;border-top:1px solid var(--dsr-line)}.dsr-section h4{font-size:12px;line-height:20px;color:var(--dsr-muted);margin:0 0 4px;font-weight:500}.dsr-prewrap{white-space:pre-wrap}.dsr-expand{margin:0 4px 6px}.dsr-json-controls{display:flex;gap:8px;flex-wrap:wrap;padding:8px 12px;border-top:1px solid var(--dsr-line)}.dsr-json{font:12px/18px Consolas,monospace;max-height:240px;overflow:auto;background:var(--dsr-weak);padding:10px;margin:0 12px 12px;white-space:pre-wrap;overflow-wrap:anywhere}.dsr-row-badges{display:inline-flex;gap:3px;font-size:10px;white-space:nowrap}.dsr-row-badges span{background:var(--dsr-weak);padding:0 4px;border-radius:4px}
.dsr-actions{border:1px solid var(--dsr-line);border-radius:10px;background:var(--dsr-bg);color:var(--dsr-fg);max-width:calc(100vw - 32px)}.dsr-actions::backdrop{background:rgba(0,0,0,.25)}.dsr-actions-body{display:flex;gap:6px;flex-wrap:wrap;padding:6px 0}.dsr-header :focus-visible,.dsr-dock :focus-visible,.dsr-card :focus-visible{outline:2px solid var(--dsr-accent);outline-offset:2px}.dsr-card [role=status]{padding:4px 12px;color:var(--dsr-muted)}
.dsr-row-compact{flex-direction:column;align-items:center;justify-content:center;gap:0;width:20px;max-width:20px;font-size:9px;line-height:11px}.dsr-row-compact span{padding:0 1px}
@media(prefers-reduced-motion:reduce){.dsr-card *{animation:none!important;transition:none!important}}
`;
    return {apply, Header, Dock, Card, Badges, useInfo, parseHandoff, publish, blockComposer, CSS};
}
