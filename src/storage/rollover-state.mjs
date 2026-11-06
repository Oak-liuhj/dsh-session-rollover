// 分卷旁路状态：待清理清单、交接快照、只读标记；文件名与旧版一致。
import {mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';

export const PENDING_FILE = 'pending-cleanup.json';
export const READONLY_FILE = 'readonly-by-rollover.json'; // 旧版聚合标记：只读兼容
/** 需求 B9：开关状态存 <dataDir>/readonly-<sessionId>.json（与簇索引同目录同优先级，不写会话元数据）。 */
export const readonlyFileOf = (dir, sessionId) => join(dir, `readonly-${sessionId}.json`);

function readJson(path, fallback) {
    try {
        return JSON.parse(readFileSync(path, 'utf8'));
    } catch {
        return fallback;
    }
}

function writeJsonAtomic(path, value) {
    mkdirSync(dirname(path), {recursive: true});
    const tmp = path + '.tmp';
    writeFileSync(tmp, JSON.stringify(value, null, 2));
    renameSync(tmp, path); // 与簇索引同一原子手法：临时文件 + rename
}

/** 插件旁路状态：待清理卷清单、交接快照、旧卷只读标记；沿用既有文件名以兼容升级。 */
export function createRolloverState(dir) {
    const pendingPath = join(dir, PENDING_FILE);
    const readonlyPath = join(dir, READONLY_FILE);
    return {
        dir,
        pendingPath,
        readonlyPath,
        readonlyRecord(sessionId) { return readJson(readonlyFileOf(dir, sessionId), null); },
        preflight() {
            // 在创建宿主会话之前发现不可写目录，避免留下空会话。
            writeJsonAtomic(join(dir, 'storage-health.json'), {checkedAt: new Date().toISOString()});
        },
        setReadonly(sessionId, readonly, payload = {}) {
            const previous = readJson(readonlyFileOf(dir, sessionId), {});
            const rec = {...previous, ...payload, readonly: !!readonly};
            writeJsonAtomic(readonlyFileOf(dir, sessionId), rec);
            return rec;
        },
        retryGet(sessionId) { return readJson(join(dir, `retry-${sessionId}.json`), {attempts: 0}); },
        retrySave(sessionId, attempts) { writeJsonAtomic(join(dir, `retry-${sessionId}.json`), {attempts}); },
        pendingList: () => Object.values(readJson(pendingPath, {})),
        pendingAdd(rec) {
            const all = readJson(pendingPath, {});
            all[rec.sessionId] = rec;
            writeJsonAtomic(pendingPath, all);
            return rec;
        },
        pendingRemove(sessionId) {
            const all = readJson(pendingPath, {});
            delete all[sessionId];
            writeJsonAtomic(pendingPath, all);
        },
        handoffGet(sessionId) { return readJson(join(dir, `handoff-${sessionId}.json`), null); },
        handoffSave(sessionId, payload) { writeJsonAtomic(join(dir, `handoff-${sessionId}.json`), payload); },
        markReadonly(sessionId, payload) {
            const rec = {readonly: true, ...payload};
            writeJsonAtomic(readonlyFileOf(dir, sessionId), rec);
            return rec;
        },
        /**
         * 手动开关：把 readonly-<sessionId>.json 里的 readonly 改成 false 即放行（保留历史全景）。
         * 兼容旧版聚合文件 readonly-by-rollover.json。
         */
        isReadonly(sessionId) {
            const per = readJson(readonlyFileOf(dir, sessionId), null);
            if (per) return per.readonly !== false;
            return !!readJson(readonlyPath, {})[sessionId];
        },
    };
}
