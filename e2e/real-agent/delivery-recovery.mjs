import { createHash } from 'node:crypto';

/** The caller must select and validate the intended final comment explicitly. */
export async function recoverDeliveredComment({ call, task, comment }) {
  if (task.status !== 'failed' || !String(task.error).includes('Missing Authentication header')) throw new Error('Task is not eligible for confirmed delivery recovery');
  if (comment.source_task_id !== task.id || comment.author_type !== 'agent' || comment.author_id !== task.agent_id || !comment.content?.trim()) throw new Error('Final comment does not belong to this task');
  const comment_sha256 = createHash('sha256').update(comment.content).digest('hex');
  return call(`/api/tasks/${task.id}/recover-delivery`, { comment_id: comment.id, comment_sha256 });
}
