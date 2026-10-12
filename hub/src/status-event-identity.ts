export type StatusEventTaskIdentity = {
  id: string | null
  key: string
}

export type StatusEventIdentity = {
  task: StatusEventTaskIdentity
  toStatus: string
  at: string | Date
}

export function statusEventIdentity(
  taskId: string | null,
  taskKey: string,
  toStatus: string,
  at: string | Date,
): StatusEventIdentity {
  return { task: { id: taskId, key: taskKey }, toStatus, at }
}

function eventInstantMs(value: string | Date): number {
  return value instanceof Date ? value.getTime() : Date.parse(value)
}

function sameTask(left: StatusEventTaskIdentity, right: StatusEventTaskIdentity): boolean {
  if (left.id && right.id) return left.id === right.id
  return left.key === right.key
}

/** Same tracker transition: same task, same new status, same instant. */
export function isSameStatusEvent(left: StatusEventIdentity, right: StatusEventIdentity): boolean {
  return (
    sameTask(left.task, right.task) &&
    left.toStatus === right.toStatus &&
    eventInstantMs(left.at) === eventInstantMs(right.at)
  )
}
