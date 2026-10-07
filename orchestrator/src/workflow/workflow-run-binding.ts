// concern: workflows
/** Pure run-binding for workflow floor evidence. Must not know stores, processes, or clocks. */

type RunBindingIdentity = {
  project: string
  workflowKey: string
  branch: string | null
  session: string | null
  createdAt: string
}

type BoundRun = {
  project: string | null
  launchKey: string | null
  branch: string | null
  sessionId: string | null
  createdAt: string
}

const KEYLESS_REMEDY =
  "dispatch the run from the cursor's owning session after composing the workflow, or pass --key once a task exists"

/** The session-or-adopter rule used by exec evidence and keyless run binding. */
export function sessionOrAdopterMatch(input: {
  cursorSession: string | null
  actorSession: string | null
  adoptionReasons: Array<string | null>
}): { sessionMatches: boolean; sessionAdoptedCursor: boolean } {
  const adoption =
    input.cursorSession !== null && input.actorSession !== null
      ? `adopted from gone owner ${input.cursorSession} by ${input.actorSession}`
      : null
  return {
    sessionMatches: input.cursorSession !== null && input.actorSession === input.cursorSession,
    sessionAdoptedCursor: Boolean(
      adoption &&
        input.adoptionReasons.some(
          (reason) => reason === adoption || reason?.startsWith(`${adoption}; `),
        ),
    ),
  }
}

function keylessCursor(identity: RunBindingIdentity): boolean {
  return !identity.workflowKey && identity.branch === null
}

function projectRefusal(flag: string, run: BoundRun, identity: RunBindingIdentity): string {
  return `${flag} project is ${run.project ?? 'unset'}, not this cursor's ${identity.project}`
}

function keyedRefusal(flag: string, run: BoundRun, identity: RunBindingIdentity): string {
  return (
    `${flag} launch_key is ${run.launchKey ?? 'unset'}, not this cursor's ${identity.workflowKey || 'task'}, ` +
    `and branch is ${run.branch ?? 'unset'}, not this cursor's ${identity.branch ?? 'branch'}`
  )
}

function keylessSessionRefusal(flag: string, run: BoundRun, identity: RunBindingIdentity): string {
  return (
    `${flag} session is ${run.sessionId ?? 'unset'}, not this cursor's owning session ${identity.session ?? 'unset'}; ` +
    KEYLESS_REMEDY
  )
}

function keylessPredatesRefusal(flag: string): string {
  return `${flag} predates this cursor; ${KEYLESS_REMEDY}`
}

/** Decide whether a run is bound to a cursor. Null means bound; a string is the refusal. */
export function decideRunBinding(input: {
  flag: string
  run: BoundRun
  identity: RunBindingIdentity
  sessionMatches: boolean
  sessionAdoptedCursor: boolean
}): string | null {
  if (input.run.project !== input.identity.project)
    return projectRefusal(input.flag, input.run, input.identity)
  const keyOk =
    Boolean(input.identity.workflowKey) && input.run.launchKey === input.identity.workflowKey
  const branchOk = Boolean(input.identity.branch) && input.run.branch === input.identity.branch
  if (keyOk || branchOk) return null
  if (!keylessCursor(input.identity)) return keyedRefusal(input.flag, input.run, input.identity)
  if (!input.sessionMatches && !input.sessionAdoptedCursor)
    return keylessSessionRefusal(input.flag, input.run, input.identity)
  if (input.run.createdAt < input.identity.createdAt) return keylessPredatesRefusal(input.flag)
  return null
}
