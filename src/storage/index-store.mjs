// 索引文件存储与插件数据目录解析；升级时沿用既有文件格式。
import {mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {createClusterIndex} from '../domain/cluster-index.mjs';

/** dshHome 解析：语义照 @deepseek-ai/dsh-home-paths README（配置 > $DSH_HOME > ~/.dsh；空白视为未设置）。零依赖等价实现。 */
export function resolveDataDir({configDir, env = process.env, home = homedir()} = {}) {
    if (configDir) return configDir;
    const dd = env.DSH_ROLLOVER_DATA_DIR;
    if (dd && dd.trim()) return dd.trim();
    const h = env.DSH_HOME;
    const root = (h && h.trim()) ? h.trim() : join(home, '.dsh');
    return join(root, 'plugin-data', 'dsh-session-rollover');
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
