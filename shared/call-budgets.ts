export type CallBudgetName =
  | 'git-plumbing'
  | 'git-network'
  | 'process-table'
  | 'self-cli'
  | 'hosted-api'
  | 'release-download'
  | 'agent-cli'
  | 'docker'
  | 'gh'

export type CallBudget = {
  deadlineMs: number
  totalMs?: number
  outputBytes: number
  graceMs: number
}

const MIB = 1024 * 1024

export const CALL_BUDGETS: Readonly<Record<CallBudgetName, CallBudget>> = Object.freeze({
  'git-plumbing': { deadlineMs: 30_000, outputBytes: 16 * MIB, graceMs: 2_000 },
  'git-network': { deadlineMs: 120_000, outputBytes: 16 * MIB, graceMs: 5_000 },
  'process-table': { deadlineMs: 10_000, outputBytes: 4 * MIB, graceMs: 1_000 },
  'self-cli': { deadlineMs: 60_000, outputBytes: 16 * MIB, graceMs: 5_000 },
  'hosted-api': {
    deadlineMs: 30_000,
    totalMs: 60_000,
    outputBytes: 16 * MIB,
    graceMs: 0,
  },
  'release-download': {
    deadlineMs: 300_000,
    totalMs: 300_000,
    outputBytes: 512 * MIB,
    graceMs: 0,
  },
  'agent-cli': { deadlineMs: 60_000, outputBytes: 16 * MIB, graceMs: 5_000 },
  docker: { deadlineMs: 120_000, outputBytes: 16 * MIB, graceMs: 5_000 },
  gh: { deadlineMs: 60_000, outputBytes: 16 * MIB, graceMs: 5_000 },
})

export type CallBound = 'deadline' | 'output'

export class BoundExceededError extends Error {
  readonly command: string
  readonly budget: CallBudgetName
  readonly bound: CallBound
  readonly value: number

  constructor(command: string, budget: CallBudgetName, bound: CallBound, value: number) {
    const unit = bound === 'deadline' ? 'ms' : 'bytes'
    super(
      `${command} exceeded its ${budget} ${bound} bound of ${value} ${unit}; declare a larger named budget in shared/call-budgets.ts if the call legitimately needs more`,
    )
    this.name = 'BoundExceededError'
    this.command = command
    this.budget = budget
    this.bound = bound
    this.value = value
  }
}
