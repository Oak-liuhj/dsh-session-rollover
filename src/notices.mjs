// B6 一次性提示的镜像存储：去重键（会话,原因）＋「未发显」待投递队列。
// 与 B9 readonly 开关同目录（<DSH_HOME>/plugin-data/dsh-session-rollover）；
// 原子写（tmp + rename），坏文件不抛、降级成空存储（下一次写覆盖）。
// 设计：服务端只负责「该不该提示、提示什么」；渲染是 client 半的事（宿主 server 侧无 toast）。
import {mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

export const NOTICE_FILE = 'notices.json';
const MAX_PENDING_PER_SESSION = 20;
const MAX_DEDUPE = 500;

const emptyDoc = () => ({version: 1, dedupe: {}, pending: {}});

/**
 * @param {string} dir 插件数据目录（与 cluster-index.json / readonly-*.json 同处）
 * @param {{ file?: string, now?: () => number }} [opts]
 */
export function createNoticeStore(dir, opts = {}) {
    const path = opts.file ?? join(dir, NOTICE_FILE);
    const now = opts.now ?? (() => Date.now());
    const doc = emptyDoc();
    let seq = 0;
    let degraded = null;

    function load() {
        try {
            const parsed = JSON.parse(readFileSync(path, 'utf8'));
            if (parsed && typeof parsed === 'object') {
                if (parsed.dedupe && typeof parsed.dedupe === 'object') Object.assign(doc.dedupe, parsed.dedupe);
                if (parsed.pending && typeof parsed.pending === 'object') {
                    for (const [sid, list] of Object.entries(parsed.pending)) {
                        if (Array.isArray(list)) doc.pending[sid] = list.filter((n) => n && typeof n.text === 'string');
                    }
                }
            }
            degraded = null;
        } catch {
            // 首启 / 坏文件：空存储；不覆盖原文件，等下一次 persist 自愈
            degraded = 'unreadable';
        }
        return doc;
    }

    function persist() {
        try {
            mkdirSync(dir, {recursive: true});
            const tmp = `${path}.tmp`;
            writeFileSync(tmp, JSON.stringify(doc), 'utf8');
            renameSync(tmp, path);
            degraded = null;
            return path;
        } catch (e) {
            degraded = String(e?.message ?? e);
            return null;
        }
    }

    /** 去重键存在 → 不再入队（同会话同因只提示一次）。成功分卷后由 clearSession 清键。 */
    function queue(sessionId, reason, text) {
        if (!sessionId) return {queued: false, duplicate: false, reason: 'no-session'};
        const key = `${sessionId}|${reason}`;
        if (doc.dedupe[key]) return {queued: false, duplicate: true, id: doc.dedupe[key].id ?? null};
        const at = new Date(now()).toISOString();
        const entry = {id: `${now()}-${(++seq).toString(36)}`, reason, text: String(text ?? ''), at};
        doc.dedupe[key] = {id: entry.id, at};
        const list = (doc.pending[sessionId] ??= []);
        list.push(entry);
        if (list.length > MAX_PENDING_PER_SESSION) list.splice(0, list.length - MAX_PENDING_PER_SESSION);
        // 去重键防无限增长：超过上限按 at 丢最旧（丢了只是允许再提示一次，不会卡死）
        const keys = Object.keys(doc.dedupe);
        if (keys.length > MAX_DEDUPE) {
            keys.sort((a, b) => String(doc.dedupe[a].at).localeCompare(String(doc.dedupe[b].at)));
            for (const k of keys.slice(0, keys.length - MAX_DEDUPE)) delete doc.dedupe[k];
        }
        const written = persist();
        return {queued: true, duplicate: false, id: entry.id, path: written, degraded};
    }

    /** client 取走即删（取走一次＝投递一次；渲染失败由 client 静默，不影响分卷事务）。 */
    function takePending(sessionId) {
        if (!sessionId) return [];
        const list = doc.pending[sessionId] ?? [];
        if (!list.length) return [];
        delete doc.pending[sessionId];
        persist();
        return list.slice();
    }

    /** 分卷成功一次 → 清该会话去重键与残留待投递（否则键只增不减，成功后真失败反而不提示）。 */
    function clearSession(sessionId) {
        if (!sessionId) return {dedupe: 0, pending: 0};
        let dedupe = 0;
        for (const key of Object.keys(doc.dedupe)) {
            if (key.startsWith(`${sessionId}|`)) {
                delete doc.dedupe[key];
                dedupe += 1;
            }
        }
        const pending = doc.pending[sessionId]?.length ?? 0;
        delete doc.pending[sessionId];
        if (dedupe || pending) persist();
        return {dedupe, pending};
    }

    function snapshot() {
        return JSON.parse(JSON.stringify(doc));
    }

    load();

    return {
        path, load, persist, queue, takePending, clearSession, snapshot,
        get degraded() {
            return degraded;
        },
    };
}