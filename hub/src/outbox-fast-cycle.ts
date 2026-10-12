export type PendingHostedOutbox = {
  pendingCount: number
  newestQueuedAt: string | null
}

type HostedOutboxProgress = {
  sent: number
  quarantined: number
  dropped: number
}

export type LastHostedOutboxDrain = {
  at: string
  madeProgress: boolean
}

export function shouldDrainHostedOutboxFast(
  pending: PendingHostedOutbox,
  lastDrain: LastHostedOutboxDrain | null,
): boolean {
  if (pending.pendingCount === 0) return false
  if (!lastDrain || lastDrain.madeProgress) return true
  return pending.newestQueuedAt !== null && pending.newestQueuedAt > lastDrain.at
}

function drainMadeProgress(report: HostedOutboxProgress): boolean {
  return report.sent + report.quarantined + report.dropped > 0
}

export class HostedOutboxDrainSchedule<Report extends HostedOutboxProgress> {
  private lastDrain: LastHostedOutboxDrain | null = null
  private readonly drain: () => Promise<Report>
  private readonly clock: () => string

  constructor(drain: () => Promise<Report>, clock: () => string) {
    this.drain = drain
    this.clock = clock
  }

  async fast(pending: PendingHostedOutbox): Promise<Report | null> {
    if (!shouldDrainHostedOutboxFast(pending, this.lastDrain)) return null
    return this.runDrain()
  }

  async slow(): Promise<Report> {
    return this.runDrain()
  }

  private async runDrain(): Promise<Report> {
    const at = this.clock()
    try {
      const report = await this.drain()
      this.lastDrain = { at, madeProgress: drainMadeProgress(report) }
      return report
    } catch (error) {
      this.lastDrain = { at, madeProgress: false }
      throw error
    }
  }
}
