// 兼容旧索引入口；纯内存规则与磁盘存储分层维护。
export {FIELDS, createClusterIndex, rebuildFromTitles} from './domain/cluster-index.mjs';
export {resolveDataDir, attachFilePersistence} from './storage/index-store.mjs';
