// concern: workflows
/** Replays process and network floor facts without holding the store write lock. */

type CheckoutResolution = {
  project: string | null
  branch: string | null
  headIsTipOrAncestor: boolean
  landingCommit?: string | null
  landingIsHeadOrAncestor?: boolean
  headIsTrunkTipOrAncestor?: boolean
}

type PullRequestMergeView = { state: string; mergedAt: string | null }

type HubTaskRead = {
  key: string
  status: string | null
  statusCategory: string | null
  commentIds: Array<string | number>
  commentsVerifiable?: boolean
}

export type FloorEvidencePorts = {
  readTask?: (key: string, options: { fresh: true }) => HubTaskRead
  runHasArtifacts?: (runId: number) => boolean
  resolveCheckout?: (
    cwd: string,
    headCommit: string | null,
    expectedBranch: string | null,
  ) => CheckoutResolution
  viewPullRequest?: (project: string, number: number) => PullRequestMergeView
  resolveTreeCommit?: (worktree: string) => string | null
}

export const MAX_FLOOR_EVIDENCE_REPLAY_ROUNDS = 16

type ExternalPort = Exclude<keyof FloorEvidencePorts, 'runHasArtifacts'>
type RecordedCall = { ok: true; value: unknown } | { ok: false; error: unknown }
type MissingCall = {
  port: ExternalPort
  args: unknown[]
  run(): unknown
}

const REPLAY = Symbol('floor-evidence-replay')
type ReplayContext = {
  real: FloorEvidencePorts
  memo: Map<string, RecordedCall>
}
type ReplayingPorts = FloorEvidencePorts & { [REPLAY]?: ReplayContext }

class FloorEvidencePortMiss extends Error {
  readonly call: MissingCall

  constructor(call: MissingCall) {
    super(`missing floor evidence for ${String(call.port)}`)
    this.call = call
  }
}

export function rethrowFloorEvidencePortMiss(error: unknown): void {
  if (error instanceof FloorEvidencePortMiss) throw error
}

function callKey(port: ExternalPort, args: unknown[]): string {
  return JSON.stringify([port, args])
}

function replayCall(
  context: ReplayContext,
  port: ExternalPort,
  fallback: ((...args: never[]) => unknown) | undefined,
  args: unknown[],
): unknown {
  const key = callKey(port, args)
  const recorded = context.memo.get(key)
  if (recorded) {
    if (recorded.ok) return recorded.value
    throw recorded.error
  }
  const real = context.real[port] ?? fallback
  if (!real) throw new Error(`floor evidence port ${String(port)} has no implementation`)
  throw new FloorEvidencePortMiss({
    port,
    args,
    run: () => Reflect.apply(real, undefined, args),
  })
}

function replayingPorts(real: FloorEvidencePorts, memo: Map<string, RecordedCall>): ReplayingPorts {
  const context: ReplayContext = { real, memo }
  const wrapped: ReplayingPorts = { ...real, [REPLAY]: context }
  for (const port of [
    'readTask',
    'resolveCheckout',
    'viewPullRequest',
    'resolveTreeCommit',
  ] as const) {
    if (real[port]) {
      Object.assign(wrapped, {
        [port]: (...args: unknown[]) => replayCall(context, port, undefined, args),
      })
    }
  }
  return wrapped
}

export function invokeFloorEvidencePort<Name extends ExternalPort>(
  ports: FloorEvidencePorts,
  port: Name,
  fallback: NonNullable<FloorEvidencePorts[Name]>,
  ...args: Parameters<NonNullable<FloorEvidencePorts[Name]>>
): ReturnType<NonNullable<FloorEvidencePorts[Name]>> {
  const context = (ports as ReplayingPorts)[REPLAY]
  if (context)
    return replayCall(context, port, fallback as (...args: never[]) => unknown, args) as ReturnType<
      NonNullable<FloorEvidencePorts[Name]>
    >
  const implementation = (ports[port] ?? fallback) as NonNullable<FloorEvidencePorts[Name]>
  return Reflect.apply(implementation, undefined, args) as ReturnType<
    NonNullable<FloorEvidencePorts[Name]>
  >
}

export function withReplayedFloorEvidence<T>(
  ports: FloorEvidencePorts,
  transaction: (ports: FloorEvidencePorts) => T,
): T {
  const memo = new Map<string, RecordedCall>()
  for (let round = 1; round <= MAX_FLOOR_EVIDENCE_REPLAY_ROUNDS; round += 1) {
    try {
      return transaction(replayingPorts(ports, memo))
    } catch (error) {
      if (!(error instanceof FloorEvidencePortMiss)) throw error
      if (round === MAX_FLOOR_EVIDENCE_REPLAY_ROUNDS) {
        throw new Error(
          `floor evidence replay exhausted after ${MAX_FLOOR_EVIDENCE_REPLAY_ROUNDS} rounds; ` +
            `still missing ${String(error.call.port)}(${error.call.args.map(String).join(', ')})`,
        )
      }
      try {
        memo.set(callKey(error.call.port, error.call.args), { ok: true, value: error.call.run() })
      } catch (portError) {
        memo.set(callKey(error.call.port, error.call.args), { ok: false, error: portError })
      }
    }
  }
  throw new Error('floor evidence replay stopped without a result')
}
