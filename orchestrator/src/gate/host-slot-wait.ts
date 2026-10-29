// concern: broker host-capacity wait reporting

import { nowIso, tryWriteContention } from '../database/db.ts'
import { appendRunEvent } from '../events.ts'
import { formatGateWait, type GateWaitState, type RecordedHostLoad } from '../gate-load.ts'

export function recordGateLogEvent(runId: string, timestamp: string, logPath: string): void {
  appendRunEvent(runId, { ts: timestamp, type: 'gate_log', logPath })
}

/** One presentation and contention record for every broker host-capacity wait. */
export function hostSlotWaitCallbacks(input: {
  runId: string
  writeProgress: (message: string) => void
}) {
  let reportedConditions = ''
  return {
    onWait(state: GateWaitState) {
      const message = formatGateWait(state)
      input.writeProgress(message)
      const conditions = state.heldOn.join('+')
      if (conditions === reportedConditions) return
      reportedConditions = conditions
      appendRunEvent(input.runId, { ts: nowIso(), type: 'text', text: message })
    },
    onWaitFinished(state: GateWaitState) {
      const hostLoad: RecordedHostLoad = {
        loadavg: state.load.loadavg,
        cpuBusy: state.load.cpuBusy,
        ncpu: state.load.ncpu,
        recentAdmissions: state.load.recentAdmissions,
        freeMem: state.load.freeMem,
        pressure: state.load.pressure,
        swapGrowthBytesPerSec: state.load.swapGrowthBytesPerSec,
        cpuBusySource: state.load.cpuBusy === null ? 'loadavg' : 'sampled',
      }
      tryWriteContention({
        resourceKind: 'cpu',
        resourceKey: 'host-capacity',
        eventKind: 'wait',
        durationMs: state.delayedMs,
        cause: state.heldOn.join('+'),
        runId: input.runId,
        hostLoad,
      })
    },
  }
}
