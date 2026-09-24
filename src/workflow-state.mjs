export function normalizeState(raw = {}) {
  const pending = {};
  for (const workflow of Object.values(raw.pending || {})) {
    if (workflow?.id && workflow?.messageId) pending[workflow.id] = workflow;
  }

  const cards = {};
  for (const [cardMessageId, workflowId] of Object.entries(raw.cards || {})) {
    // Older versions stored sender IDs here. They cannot identify which of a
    // sender's attachments a card belongs to, so those cards must expire.
    if (pending[workflowId]) cards[cardMessageId] = workflowId;
  }

  return { processed: raw.processed || {}, pending, cards, processingReactions: raw.processingReactions || {} };
}

export function addWorkflow(state, workflow) {
  if (!workflow?.id) throw new Error("工作流缺少消息 ID");
  state.pending[workflow.id] = workflow;
}

export function linkCard(state, cardMessageId, workflow) {
  if (!cardMessageId || !state.pending[workflow.id]) throw new Error("无法关联卡片与工作流");
  state.cards[cardMessageId] = workflow.id;
}

export function workflowForCard(state, event) {
  const workflowId = state.cards[event.message_id];
  const workflow = workflowId && state.pending[workflowId];
  if (!workflow) return null;
  if (event.operator_id && workflow.senderId !== event.operator_id) return null;
  return workflow;
}
