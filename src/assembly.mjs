// 兼容旧装配入口；实现已按事务、消息排版、磁盘状态分别归类。
export {performRollover} from './application/rollover.mjs';
export {eventsToMessages, renderHandoffMessage} from './application/handoff-message.mjs';
export {PENDING_FILE, READONLY_FILE, readonlyFileOf, createRolloverState} from './storage/rollover-state.mjs';
