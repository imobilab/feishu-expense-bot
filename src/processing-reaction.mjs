export const PROCESSING_EMOJI = "Typing";

export function reactionDeleteArgs(messageId, reactionId) {
  return [
    "im", "reactions", "delete",
    "--params", JSON.stringify({ message_id: messageId, reaction_id: reactionId }),
    "--as", "bot",
  ];
}

export async function withProcessingReaction({
  messageId,
  runJson,
  work,
  onAdded = async () => {},
  onRemoved = async () => {},
  onError = () => {},
}) {
  let reactionId;
  try {
    const response = await runJson([
      "im", "reactions", "create",
      "--params", JSON.stringify({ message_id: messageId }),
      "--data", JSON.stringify({ reaction_type: { emoji_type: PROCESSING_EMOJI } }),
      "--as", "bot",
    ]);
    reactionId = response?.reaction_id;
    if (!reactionId) throw new Error("飞书未返回表情回复 ID");
    await onAdded(messageId, reactionId);
  } catch (error) {
    onError("add", error);
  }

  try {
    return await work();
  } finally {
    if (reactionId) {
      try {
        await runJson(reactionDeleteArgs(messageId, reactionId));
        await onRemoved(messageId, reactionId);
      } catch (error) {
        onError("remove", error);
      }
    }
  }
}
