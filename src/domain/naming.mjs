// dsh-session-rollover · -N 命名与簇规则（接口契约 §3.2 第3步；纯逻辑）
// 规则：原标题+`-1`；已带 `-k` 则 k+1 不嵌套；重名序号递增到第一空位；同簇 -1..-9 封顶（B11）；用户手动改名不覆盖（B8）
export const VOLUME_CAP = 9;
const SUFFIX = /^(.+)-(\d{1})$/; // 仅个位数视为卷号；"Q3-26" 这类两位数尾巴不当卷号，防误咬

export function parseVolume(title) {
    const m = SUFFIX.exec(title ?? '');
    if (!m) return {base: title, k: 0};
    return {base: m[1], k: Number(m[2])};
}

/**
 * @param currentTitle 现名
 * @param existingTitles 同簇/全局已占用标题（Set 或数组）
 * @param opts.userRenamed 本会话被用户手动改过名 → 不覆盖（B8）
 * @returns {{ok:boolean, next?:string, k?:number, base?:string, reason?:string}}
 */
export function nextVolumeTitle(currentTitle, existingTitles = [], opts = {}) {
    if (opts.userRenamed) return {ok: false, reason: 'user-renamed'};
    const {base, k: cur} = parseVolume(currentTitle);
    let k = cur === 0 ? 1 : cur + 1;
    if (k > VOLUME_CAP) return {ok: false, reason: 'cluster-cap'};
    const taken = new Set(existingTitles);
    while (k <= VOLUME_CAP && taken.has(`${base}-${k}`)) k++; // 重名递增到第一空位并写日志（B7）
    if (k > VOLUME_CAP) return {ok: false, reason: 'cluster-cap'}; // B11：停自动、提示手动
    return {ok: true, base, k, next: `${base}-${k}`};
}

/**
 * 分卷事务的「一对名字」：旧卷改 `base-c`（c=第一空位）、新卷接 `base-nextK`。
 * 已是卷（k>0）的旧会话不再改名（S6：连跑三次 -1/-2 标题不得被改写），只给新卷找 k+1 的第一空位。
 * @returns {{ok:true, base:string, oldK:number, oldTarget:string|null, newK:number, newTarget:string, bumped:boolean} | {ok:false, reason:string}}
 */
export function planVolumeTitles(currentTitle, existingTitles = [], opts = {}) {
    if (opts.userRenamed) return {ok: false, reason: 'user-renamed'}; // B8：用户手动改名不覆盖
    // 重名可使显示后缀超过 9；仅使用索引记录确认该后缀，避免把 Q3-26 等普通标题误拆。
    const known = /^-\d+$/.test(opts.nameSuffix ?? '') && currentTitle.endsWith(opts.nameSuffix);
    const {base, k: oldK} = known
        ? {base: currentTitle.slice(0, -opts.nameSuffix.length), k: Number(opts.nameSuffix.slice(1))}
        : parseVolume(currentTitle);
    const taken = new Set(existingTitles);
    const nameLimit = opts.volumeNo != null ? 100000 : VOLUME_CAP;
    if (opts.volumeNo >= VOLUME_CAP) return {ok: false, reason: 'cluster-cap'};
    taken.delete(currentTitle); // 自己的现名不算被占用
    let oldTarget = null;
    let bumped = false;
    let cursor;
    if (opts.preserveTitle) {
        cursor = 1;
    } else if (oldK === 0) {
        let c = 1;
        while (c <= nameLimit && taken.has(`${base}-${c}`)) {
            c++;
            bumped = true;
        } // B7：重名递增到第一空位并记日志
        if (c > nameLimit) return {ok: false, reason: 'cluster-cap'}; // B11
        oldTarget = `${base}-${c}`;
        taken.add(oldTarget);
        cursor = c + 1;
    } else {
        cursor = oldK + 1;
    }
    while (cursor <= nameLimit && taken.has(`${base}-${cursor}`)) {
        cursor++;
        bumped = true;
    }
    if (cursor > nameLimit) return {ok: false, reason: 'cluster-cap'};
    return {ok: true, base, oldK, oldTarget, newK: cursor, newTarget: `${base}-${cursor}`, bumped};
}

/** 簇内已有卷数（-1..k），供「-9 封顶」前置判断；手动换会话不计入簇上限由调用方走 force */
export function clusterVolumeCount(currentTitle, existingTitles) {
    const {base} = parseVolume(currentTitle);
    const taken = new Set(existingTitles);
    let n = 0;
    for (let k = 1; k <= VOLUME_CAP; k++) if (taken.has(`${base}-${k}`)) n++;
    return n;
}
