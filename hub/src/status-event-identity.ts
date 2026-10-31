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

function eventInstantMs(value: string | Date): number {
  return value instanceof Date ? value.getTime() : Date.parse(value)
}

/** Same tracker transition: same task UUID, same new status, same instant. An unknown task matches nothing. */
export function isSameStatusEvent(left: StatusEventIdentity, right: StatusEventIdentity): boolean {
  return (
    left.taskId !== null &&
    left.taskId === right.taskId &&
    left.toStatus === right.toStatus &&
    eventInstantMs(left.at) === eventInstantMs(right.at)
  )
}
