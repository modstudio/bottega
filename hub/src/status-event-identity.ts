export type StatusEventIdentity = {
  taskKey: string
  toStatus: string
  at: string | Date
}

function eventInstantMs(value: string | Date): number {
  return value instanceof Date ? value.getTime() : Date.parse(value)
}

/** Same tracker transition: same task, same new status, same instant. */
export function isSameStatusEvent(left: StatusEventIdentity, right: StatusEventIdentity): boolean {
  return (
    left.taskKey === right.taskKey &&
    left.toStatus === right.toStatus &&
    eventInstantMs(left.at) === eventInstantMs(right.at)
  )
}
