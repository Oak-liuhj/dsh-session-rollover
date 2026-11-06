// 会话簇索引与标题对账：只操作内存，不访问宿主或磁盘。
import {parseVolume} from './naming.mjs';

export const FIELDS = ['cluster_id', 'parent_session_id', 'vol_no', 'name_suffix', 'rollover_state', 'readonly_by_rollover', 'summary_retry'];

/** 纯内存索引；serialize 输出由 storage 层负责持久化。 */
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
