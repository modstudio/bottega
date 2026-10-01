export type TaskKeyLookupResult =
  | { state: 'found' }
  | { state: 'not-found' }
  | { state: 'unreachable'; condition: string }

export type TaskKeyAdmission =
  | { action: 'proceed'; warning: string | null }
  | { action: 'refuse'; message: string }

export type TaskKeyLookup = (project: string, key: string) => Promise<TaskKeyLookupResult>

/** Decide dispatch admission from tracker evidence without reaching any tracker. */
function decideTaskKeyAdmission(input: {
  project: string
  key: string
  protocol: string
  lookup: TaskKeyLookupResult
}): TaskKeyAdmission {
  if (input.lookup.state === 'found') return { action: 'proceed', warning: null }
  if (input.lookup.state === 'not-found') {
    const create =
      input.protocol === 'hub'
        ? `create it with hub task new --project ${input.project}`
        : `create it in ${input.project}'s tracker`
    return {
      action: 'refuse',
      message:
        `task ${input.key} does not exist in project ${input.project}; ` +
        `${create}, or correct --key`,
    }
  }
  return {
    action: 'proceed',
    warning:
      `! task ${input.key} could not be verified in project ${input.project}: ` +
      `${input.lookup.condition}; dispatch will proceed because tracker availability does not gate dispatch`,
  }
}

/** Gather tracker evidence through an injected adapter, then apply the pure admission decision. */
export async function checkTaskKeyAdmission(
  input: { project: string; key: string; protocol: string },
  lookup: TaskKeyLookup,
): Promise<TaskKeyAdmission> {
  return decideTaskKeyAdmission({ ...input, lookup: await lookup(input.project, input.key) })
}
