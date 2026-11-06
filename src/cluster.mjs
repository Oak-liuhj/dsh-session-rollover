// dsh-session-rollover · 簇元数据旁路存储（表 B2 七字段；裁定：宿主无公开 metadata 写面 → 插件数据文件）
// 落点 = <dshHome>/plugin-data/dsh-session-rollover/（升级安全：pnpm 只动 profile 的 package.json/lock/node_modules；
// 官方先例 $DSH_HOME/.anonymous-user-id、cache/models——ds-bot state.json 在包目录会被 npm 升级重置，是反例不是先例）。
// 不进 work_dir（绑工作区、对模型可见、污染仓库）。索引=缓存非真相：标题 -N 与交接 cluster: 标记可对账重建。
import {mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {parseVolume} from './naming.mjs';

/** dshHome 解析：语义照 @deepseek-ai/dsh-home-paths README（配置 > $DSH_HOME > ~/.dsh；空白视为未设置）。零依赖等价实现。 */
export function resolveDataDir({configDir, env = process.env, home = homedir()} = {}) {
    if (configDir) return configDir;
    const dd = env.DSH_ROLLOVER_DATA_DIR;
    if (dd && dd.trim()) return dd.trim();
    const h = env.DSH_HOME;
    const root = (h && h.trim()) ? h.trim() : join(home, '.dsh');
    return join(root, 'plugin-data', 'dsh-session-rollover');
}

export const FIELDS = ['cluster_id', 'parent_session_id', 'vol_no', 'name_suffix', 'rollover_state', 'readonly_by_rollover', 'summary_retry'];

/** 纯内存索引（可注入 fs，测试不触盘） */
export function createClusterIndex(init = {}) {
    /** sessions: { [sessionId]: {cluster_id, parent_session_id, vol_no, name_suffix, rollover_state, readonly_by_rollover, summary_retry} } */
    const db = {sessions: {}, ...init};
    return {
        record({
                   sessionId,
                   clusterId,
                   parentSessionId,
                   volNo,
                   nameSuffix,
                   rolloverState = 'active',
                   readonlyByRollover = false,
                   summaryRetry = 0
               }) {
            if (!sessionId || !clusterId) throw new Error('cluster-index: sessionId & clusterId required');
            const rec = {
                cluster_id: clusterId, parent_session_id: parentSessionId ?? null, vol_no: volNo,
                name_suffix: nameSuffix, rollover_state: rolloverState,
                readonly_by_rollover: !!readonlyByRollover, summary_retry: summaryRetry,
            };
            for (const k of FIELDS) if (!(k in rec)) throw new Error('missing field ' + k);
            db.sessions[sessionId] = rec; // 幂等：同 sessionId 覆盖
            return rec;
        },
        get: (sessionId) => db.sessions[sessionId] ?? null,
        cluster: (clusterId) => Object.entries(db.sessions).filter(([, r]) => r.cluster_id === clusterId).map(([id, r]) => ({sessionId: id, ...r})),
        /** Q3 定稿：turn_counts 与簇索引同文件同原子提交（一个 JSON 一次 rename） */
        setTurnCounts(map = {}) {
            db.turn_counts = {...map};
            return db.turn_counts;
        },
        turnCounts: () => db.turn_counts ?? {},
        serialize: () => JSON.stringify(db, null, 2),
    };
}

/** 落盘：临时文件 + rename 原子替换；目录不可写 → 显式降级纯内存（接口契约），不抛 */
export function attachFilePersistence(index, dir, file = 'cluster-index.json') {
    const path = join(dir, file);
    return {
        path,
        degraded: false,
        lastError: null,
        load() {
            try {
                const raw = JSON.parse(readFileSync(path, 'utf8'));
                return createClusterIndex(raw);
            } catch {
                return index;
            } // 无文件/坏文件 → 空索引起步，交给 rebuild 对账
        },
        persist() {
            try {
                mkdirSync(dir, {recursive: true});
                const tmp = path + '.tmp';
                writeFileSync(tmp, index.serialize());
                renameSync(tmp, path);
                this.degraded = false;
                this.lastError = null;
                return path;
            } catch (e) {
                this.degraded = true;
                this.lastError = String(e && e.message || e);
                return null;
            }
        },
    };
}

/** 对账重建（索引=缓存的兑现）：从标题 -N 后缀 + 交接消息 cluster: 标记重建七字段记录。
 *  entries: [{sessionId,title}]；markers: {sessionId: {clusterId,parentSessionId}}（交接正文⑦项解析所得，可缺） */
export function rebuildFromTitles(entries, markers = {}) {
    const idx = createClusterIndex();
    const groups = {}; // baseTitle -> {clusterId, members:[{sessionId,vol}]}
    for (const {sessionId, title} of entries) {
        const p = parseVolume(title); // 恒返回 {base, k}，无后缀 k=0
        (groups[p.base] ??= {members: []}).members.push({sessionId, vol: p.k});
    }
    for (const [base, g] of Object.entries(groups)) {
        const marked = g.members.map((m) => markers[m.sessionId]).find(Boolean);
        const clusterId = marked?.clusterId ?? `recon:${base}`;
        const parent = marked?.parentSessionId ?? null;
        for (const m of g.members) {
            idx.record({
                sessionId: m.sessionId, clusterId, parentSessionId: parent,
                volNo: m.vol, nameSuffix: m.vol ? `-${m.vol}` : '',
                rolloverState: 'reconstructed',
            });
        }
    }
    return idx;
}
