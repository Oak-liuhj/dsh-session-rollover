// dsh-session-rollover · 浏览器半边（B6 一次性提示）。
// 通道：server 半把「该提示什么」落盘，这里同源 GET /api-dsh-session-rollover/pending 取走渲染。
// 不碰宿主 Toast 实现、不建 React hooks 面（D-36：bindInjectSources 会剥掉 hooks 字段），纯 DOM。
// 形态/时长按 UI 定稿：底部居中、距输入框上沿 12px、max-width 420px、
// 12.5px/18px、常规 5s、rollback-failed 8s、补显延迟 300ms、去重 (会话,原因)。
(function () {
    if (typeof window === 'undefined' || !window.__ModuleLoader__) return;
    window.__ModuleLoader__.load({
        // 必须与 dsh.client 条目的 id 逐字一致（包名全称）；task-panel 是非 scope 包所以看起来同名。
        id: '@deepseek-ai/dsh-session-rollover',
        factory: function (require) {
            var module = {exports: {}};
            var NS = 'dsh-session-rollover';
            var API = '/api-dsh-session-rollover/pending';
            var POLL_MS = 1000;
            var REPLAY_DELAY_MS = 300;
            var FADE_MS = 120;
            var MAX_SHOWN = 500;

            function debug(e) {
                try {
                    if (window.console && console.debug) console.debug('[' + NS + '] toast skipped:', e);
                } catch (_) { /* 静默 */
                }
            }

            function durationFor(reason) {
                return reason === 'rollback-failed' ? 8000 : 5000;
            }

            var CSS = [
                '.dsr-toast-layer{position:fixed;left:50%;transform:translateX(-50%);bottom:96px;z-index:2147483000;display:flex;flex-direction:column;align-items:center;gap:8px;max-width:min(420px,calc(100vw - 32px));pointer-events:none;}',
                '.dsr-toast{box-sizing:border-box;max-width:420px;padding:10px 14px;border-radius:8px;background:#FFFFFF;border:1px solid rgba(0,0,0,.08);box-shadow:0 6px 24px rgba(0,0,0,.12);color:#4B5563;font-size:12.5px;line-height:18px;text-align:left;white-space:pre-wrap;overflow-wrap:anywhere;opacity:0;transform:translateY(4px);transition:opacity 120ms ease,transform 120ms ease;}',
                '.dsr-toast.is-in{opacity:1;transform:translateY(0);}',
                '.dsr-toast.is-out{opacity:0;transform:translateY(4px);}',
                'html[data-theme="dark"] .dsr-toast,html.dark .dsr-toast{background:#1F2430;color:#D1D5DB;border-color:rgba(255,255,255,.10);box-shadow:0 6px 24px rgba(0,0,0,.5);}',
                '@media (prefers-color-scheme: dark){.dsr-toast{background:#1F2430;color:#D1D5DB;border-color:rgba(255,255,255,.10);box-shadow:0 6px 24px rgba(0,0,0,.5);}}',
                '@media (prefers-reduced-motion: reduce){.dsr-toast{transition:opacity 120ms ease;transform:none;}.dsr-toast.is-in,.dsr-toast.is-out{transform:none;}}',
            ].join('\n');

            function timersOf(env) {
                var win = env.win || window;
                return env.timers || {
                    setTimeout: function (fn, ms) {
                        return win.setTimeout(fn, ms);
                    },
                    clearTimeout: function (id) {
                        return win.clearTimeout(id);
                    },
                };
            }

            /** 轻量 toaster：单例容器、每条一个 role=status 节点、到时自动摘除。 */
            function createToaster(env) {
                env = env || {};
                var doc = env.doc || document;
                var win = env.win || window;
                var timers = timersOf(env);
                var layer = null;
                var items = [];
                var cssInjected = false;

                function injectCss() {
                    if (cssInjected || !doc.head) return;
                    try {
                        var style = doc.createElement('style');
                        style.setAttribute('data-dsh-plugin', NS);
                        style.textContent = CSS;
                        doc.head.appendChild(style);
                        cssInjected = true;
                    } catch (e) {
                        debug(e);
                    }
                }

                function ensureLayer() {
                    if (layer && layer.parentNode) return layer;
                    layer = doc.createElement('div');
                    layer.className = 'dsr-toast-layer';
                    doc.body.appendChild(layer);
                    return layer;
                }

                function place() {
                    try {
                        var ed = doc.querySelector('div[contenteditable="true"]');
                        var rect = ed && ed.getBoundingClientRect ? ed.getBoundingClientRect() : null;
                        if (rect && rect.top > 0) {
                            layer.style.bottom = Math.max(12, Math.round(win.innerHeight - rect.top + 12)) + 'px';
                        }
                    } catch (e) {
                        debug(e);
                    }
                }

                function remove(rec) {
                    for (var i = 0; i < rec.timers.length; i += 1) {
                        try {
                            timers.clearTimeout(rec.timers[i]);
                        } catch (_) { /* 已触发 */
                        }
                    }
                    try {
                        if (rec.el.parentNode) rec.el.parentNode.removeChild(rec.el);
                    } catch (_) { /* 已摘除 */
                    }
                    var at = items.indexOf(rec);
                    if (at >= 0) items.splice(at, 1);
                    if (layer && !layer.childNodes.length && layer.parentNode) {
                        try {
                            layer.parentNode.removeChild(layer);
                        } catch (_) { /* 已摘除 */
                        }
                        layer = null;
                    }
                }

                function show(notice) {
                    injectCss();
                    ensureLayer();
                    place();
                    var el = doc.createElement('div');
                    el.className = 'dsr-toast';
                    el.setAttribute('role', 'status');
                    el.setAttribute('aria-live', 'polite');
                    el.setAttribute('aria-atomic', 'true');
                    el.textContent = String((notice && notice.text) || '');
                    layer.appendChild(el);
                    var rec = {el: el, timers: []};
                    items.push(rec);
                    var duration = durationFor(notice && notice.reason);
                    rec.timers.push(timers.setTimeout(function () {
                        try {
                            el.className = 'dsr-toast is-in';
                        } catch (_) { /* 已摘除 */
                        }
                    }, 0));
                    rec.timers.push(timers.setTimeout(function () {
                        try {
                            el.className = 'dsr-toast is-out';
                        } catch (_) { /* 已摘除 */
                        }
                    }, Math.max(0, duration - FADE_MS)));
                    rec.timers.push(timers.setTimeout(function () {
                        remove(rec);
                    }, duration));
                    return el;
                }

                function destroy() {
                    items.slice().forEach(remove);
                    if (layer && layer.parentNode) {
                        try {
                            layer.parentNode.removeChild(layer);
                        } catch (_) { /* 已摘除 */
                        }
                    }
                    layer = null;
                }

                return {
                    show: show, destroy: destroy, count: function () {
                        return items.length;
                    }, _items: items
                };
            }

            /** 当前会话：宿主 localStorage 的 dsh.sessions.current（{sessionId}），URL ?session= 兜底。 */
            function currentSessionId(env) {
                var win = (env && env.win) || window;
                try {
                    var raw = win.localStorage && win.localStorage.getItem('dsh.sessions.current');
                    if (raw) {
                        var parsed = JSON.parse(raw);
                        if (parsed && typeof parsed === 'object') {
                            if (parsed.sessionId) return String(parsed.sessionId);
                            if (parsed.id) return String(parsed.id);
                        } else if (typeof parsed === 'string' && parsed) return parsed;
                    }
                } catch (e) {
                    debug(e);
                }
                try {
                    var m = /(?:^|[?&])session=([^&]+)/.exec((win.location && win.location.search) || '');
                    if (m) return decodeURIComponent(m[1]);
                } catch (e) {
                    debug(e);
                }
                return '';
            }

            /** 轮询取件。会话切换后先等 300ms（补显不与首屏抢帧）；页面隐藏不取，回来立即取。 */
            function start(env, toaster) {
                env = env || {};
                var doc = env.doc || document;
                var win = env.win || window;
                var timers = timersOf(env);
                var stopped = false;
                var timer = null;
                var session = '';
                var shown = {};
                var shownCount = 0;

                function schedule(ms) {
                    if (stopped) return;
                    timer = timers.setTimeout(tick, ms);
                }

                function fetchPending(sid) {
                    var doFetch = env.fetch || (win && win.fetch);
                    if (typeof doFetch !== 'function') return;
                    var p;
                    try {
                        p = doFetch(API + '?session=' + encodeURIComponent(sid), {
                            cache: 'no-store',
                            credentials: 'same-origin'
                        });
                    } catch (e) {
                        debug(e);
                        return;
                    }
                    Promise.resolve(p).then(function (res) {
                        if (!res || !res.ok) return null;
                        return res.json();
                    }).then(function (body) {
                        if (stopped || !body || !Array.isArray(body.notices)) return;
                        body.notices.forEach(function (n) {
                            if (!n || !n.id || shown[n.id]) return;
                            shown[n.id] = 1;
                            shownCount += 1;
                            if (shownCount > MAX_SHOWN) {
                                shown = {};
                                shown[n.id] = 1;
                                shownCount = 1;
                            }
                            try {
                                toaster.show(n);
                            } catch (e) {
                                debug(e);
                            }
                        });
                    }).catch(function (e) {
                        debug(e);
                    });
                }

                function tick() {
                    timer = null;
                    if (stopped) return;
                    try {
                        if (doc.visibilityState === 'hidden') {
                            schedule(POLL_MS);
                            return;
                        }
                        var sid = currentSessionId(env);
                        if (!sid) {
                            schedule(POLL_MS);
                            return;
                        }
                        if (sid !== session) {
                            session = sid;
                            schedule(REPLAY_DELAY_MS);
                            return;
                        }
                        fetchPending(sid);
                    } catch (e) {
                        debug(e);
                    }
                    schedule(POLL_MS);
                }

                function onVisibility() {
                    if (!stopped && doc.visibilityState !== 'hidden') {
                        try {
                            tick();
                        } catch (e) {
                            debug(e);
                        }
                    }
                }

                function stop() {
                    stopped = true;
                    if (timer != null) {
                        try {
                            timers.clearTimeout(timer);
                        } catch (_) { /* 已触发 */
                        }
                        timer = null;
                    }
                    try {
                        doc.removeEventListener && doc.removeEventListener('visibilitychange', onVisibility);
                    } catch (_) { /* 无监听面 */
                    }
                }

                try {
                    doc.addEventListener && doc.addEventListener('visibilitychange', onVisibility);
                } catch (e) {
                    debug(e);
                }
                tick();
                return stop;
            }

            function apply(ctx) {
                try {
                    var env = {doc: document, win: window};
                    var toaster = createToaster(env);
                    var stop = start(env, toaster);
                    var dispose = function () {
                        try {
                            stop();
                        } catch (_) { /* 已停 */
                        }
                        try {
                            toaster.destroy();
                        } catch (_) { /* 已清 */
                        }
                    };
                    if (ctx && typeof ctx.effect === 'function') ctx.effect(function () {
                        return dispose;
                    }, NS + ': toast');
                    else if (typeof window.addEventListener === 'function') window.addEventListener('pagehide', dispose);
                } catch (e) {
                    debug(e);
                }
            }

            module.exports = {
                name: NS,
                inject: [],
                apply: apply,
                __test: {
                    durationFor: durationFor, createToaster: createToaster, currentSessionId: currentSessionId,
                    start: start, API: API, REPLAY_DELAY_MS: REPLAY_DELAY_MS, POLL_MS: POLL_MS,
                },
            };
            return module.exports;
        },
    });
})();