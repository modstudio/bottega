import { sameRecordInstant } from '../../shared/record-timestamp.ts'

export type StatusEventIdentity = {
  taskId: string | null
  toStatus: string
  at: string | Date
}

export function statusEventIdentity(
  taskId: string | null,
  toStatus: string,
  at: string | Date,
): StatusEventIdentity {
  return { taskId, toStatus, at }
}

/** Same tracker transition: same task UUID, same new status, same instant. An unknown task matches nothing. */
export function isSameStatusEvent(left: StatusEventIdentity, right: StatusEventIdentity): boolean {
  return (
    left.taskId !== null &&
    left.taskId === right.taskId &&
    left.toStatus === right.toStatus &&
    sameRecordInstant(left.at, right.at)
  )
}
