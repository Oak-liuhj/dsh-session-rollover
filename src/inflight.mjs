// 切点安全闸 S1：会话里仍在跑的工具调用 = 有 tool/call 但没有对应 tool/result。
// 事件形状（session.v4 实测，2026-11-05）：
//   tool/call   -> data.callId
//   tool/result -> data.toolCallId（并镜像在 data.message.toolCallId / data.message.source.callId）
// 只认 data.callId 会把已完成的调用全部算成 in-flight，第 10 轮触发时误判 unsafe-cut-point。

function typeOf(e) {
  return e?.type ?? e?.kind;
}

export function callIdOf(e) {
  return e?.data?.callId ?? e?.data?.toolCallId
    ?? e?.data?.message?.toolCallId ?? e?.data?.message?.source?.callId
    ?? e?.data?.message?.callId;
}

export function openToolCalls(events = []) {
  const open = new Map();
  for (const e of events) {
    const callId = callIdOf(e);
    if (typeOf(e) === 'tool/call') open.set(callId, { callId, name: e.data?.name });
    else if (typeOf(e) === 'tool/result' && callId) open.delete(callId);
  }
  return [...open.values()];
}