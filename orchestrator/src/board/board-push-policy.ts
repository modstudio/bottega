// concern: board-push-policy
/** Pure acknowledgement push decisions and the deliberately minimal reader text. */

export type PendingAcknowledgement = {
  id: string
  author: string
  title: string
  body: string
  deadline: string
  deliveredAt: string | null
}

export const shouldRemind = (
  deliveredAt: string | null,
  now: number,
  remindSeconds: number,
): boolean => deliveredAt === null || now - Date.parse(deliveredAt) >= remindSeconds * 1_000

export function pendingForDelivery(
  notices: PendingAcknowledgement[],
  now: number,
  remindSeconds: number,
): PendingAcknowledgement[] {
  return notices.filter((notice) => shouldRemind(notice.deliveredAt, now, remindSeconds))
}

export function renderPendingAcknowledgement(notice: PendingAcknowledgement): string {
  return [
    `Posted by: ${notice.author}`,
    `Title: ${notice.title}`,
    `Body: ${notice.body}`,
    `Deadline: ${notice.deadline}`,
    `orch board ack ${notice.id}`,
  ].join('\n')
}
