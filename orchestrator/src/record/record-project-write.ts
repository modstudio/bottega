// concern: record-project-write
/** Decides how a hosted project upsert applies a rename. Must not know SQL or HTTP. */

export type HostedProjectNameRow = {
  id: string
  name: string
  retiredAt: string | null
  checkoutPath: string | null
}

export type HostedProjectWritePlan =
  | { kind: 'upsert'; name: string }
  | { kind: 'rename'; id: string; from: string; to: string }
  | { kind: 'refuse'; message: string }

export function hostedProjectCollisionMessage(from: string, to: string): string {
  return `cannot rename hosted project "${from}" to "${to}": hosted project "${to}" already exists`
}

export function decideHostedProjectWrite(input: {
  currentName: string
  nextName: string
  path: string
  current: HostedProjectNameRow | null
  next: HostedProjectNameRow | null
}): HostedProjectWritePlan {
  if (input.next && input.next.id !== input.current?.id) {
    if (!input.current && input.next.checkoutPath === input.path) {
      return { kind: 'upsert', name: input.nextName }
    }
    return {
      kind: 'refuse',
      message: hostedProjectCollisionMessage(input.currentName, input.nextName),
    }
  }
  if (input.currentName === input.nextName || !input.current) {
    return { kind: 'upsert', name: input.nextName }
  }
  return { kind: 'rename', id: input.current.id, from: input.currentName, to: input.nextName }
}
