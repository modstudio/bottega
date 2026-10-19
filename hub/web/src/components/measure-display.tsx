import { StatRow, StatTile } from '@bottega/hub-ui/stat'
import { compactTokens } from '@bottega/hub-util/format'
import type { ReactNode } from 'react'

const hour = (ms: number) =>
  `${(ms / 3_600_000).toLocaleString(undefined, { maximumFractionDigits: 1 })} hours`
const money = (usd: number) => usd.toLocaleString(undefined, { style: 'currency', currency: 'USD' })

type SessionTimeMeasure = {
  unionThenSumMs: number
  uncountedSilenceMs: number
  silenceAllowanceSentence: string
  unknownUser?: { unionThenSumMs: number; uncountedSilenceMs: number }
}

type AgentHoursMeasure = {
  sumMs: number
  unknownShare?: { sumMs: number }
}

type CostMeasure = {
  vendorCostUsd: number
  vendorTokens: number
  unknownShare?: { vendorCostUsd: number; vendorTokens: number }
}

type MeasuresSummaryValue = {
  hoursRunning: { unionMs: number }
  agentHours: AgentHoursMeasure
  sessionTime: SessionTimeMeasure
  cost: CostMeasure
  shipped?: { count: number }
  cycleTime?: { medianMs: number; n: number }
}

function Unknown({ children, mostly }: { children: ReactNode; mostly: boolean }) {
  return (
    <span>
      {children}
      {mostly ? ' — attribution is mostly unknown' : ''}
    </span>
  )
}

export function SessionDetail({ measure }: { measure: SessionTimeMeasure }) {
  const unknown = measure.unknownUser
  const total = measure.unionThenSumMs + (unknown?.unionThenSumMs ?? 0)
  return (
    <span>
      {measure.silenceAllowanceSentence} {hour(measure.uncountedSilenceMs)} uncounted silence.
      {unknown ? (
        <>
          {' '}
          <Unknown mostly={unknown.unionThenSumMs > total / 2}>
            {hour(unknown.unionThenSumMs)} has an unknown person
          </Unknown>
          ; {hour(unknown.uncountedSilenceMs)} unknown-person silence was uncounted.
        </>
      ) : null}
    </span>
  )
}

export function AgentUnknown({ measure }: { measure: AgentHoursMeasure }) {
  if (!measure.unknownShare) return null
  return (
    <Unknown mostly={measure.unknownShare.sumMs > measure.sumMs / 2}>
      {hour(measure.unknownShare.sumMs)} has an unknown person
    </Unknown>
  )
}

export function CostUnknown({ measure }: { measure: CostMeasure }) {
  if (!measure.unknownShare) return null
  const mostly = measure.vendorCostUsd
    ? measure.unknownShare.vendorCostUsd > measure.vendorCostUsd / 2
    : measure.unknownShare.vendorTokens > measure.vendorTokens / 2
  return (
    <Unknown mostly={mostly}>
      {money(measure.unknownShare.vendorCostUsd)} and{' '}
      {compactTokens(measure.unknownShare.vendorTokens)} agent tokens have an unknown person
    </Unknown>
  )
}

export function MeasuresSummary({
  measures,
  showShipped = true,
}: {
  measures: MeasuresSummaryValue
  showShipped?: boolean
}) {
  return (
    <StatRow>
      <StatTile
        label="How long any recorded work was in motion"
        figure={hour(measures.hoursRunning.unionMs)}
        hint="Work was running; this figure is not additive."
      />
      <StatTile
        label="How much agent work was started"
        figure={hour(measures.agentHours.sumMs)}
        hint={<AgentUnknown measure={measures.agentHours} />}
        wrapHint
      />
      <StatTile
        label="How long people were in session"
        figure={hour(measures.sessionTime.unionThenSumMs)}
        hint={<SessionDetail measure={measures.sessionTime} />}
        wrapHint
      />
      <StatTile
        label="What the started agent work cost"
        figure={money(measures.cost.vendorCostUsd)}
        hint={<CostUnknown measure={measures.cost} />}
        wrapHint
      />
      {showShipped && measures.shipped ? (
        <StatTile
          label="Tasks done"
          figure={measures.shipped.count.toLocaleString()}
          hint="Tasks moved to done in this window."
        />
      ) : null}
      {measures.cycleTime ? (
        <StatTile
          label="Cycle time for tasks done"
          figure={hour(measures.cycleTime.medianMs)}
          hint={`Median cycle time; n=${measures.cycleTime.n}.`}
        />
      ) : null}
    </StatRow>
  )
}

/**
 * A task's measures as one compact line of figures under its key line; each figure's meaning and
 * bounds open from its (i). A task with no recorded time says so in place of zero figures.
 */
export function TaskMeasures({
  measures,
  hasRecordedTime,
}: {
  measures: MeasuresSummaryValue
  hasRecordedTime: boolean
}) {
  if (!hasRecordedTime) {
    return <p className="mt-3 text-sm text-text-muted">No time was recorded for this task.</p>
  }
  return (
    <div className="mt-4">
      <StatRow compact>
        <StatTile
          label="in motion"
          figure={hour(measures.hoursRunning.unionMs)}
          about="How long any recorded work was in motion. Work was running; this figure is not additive."
        />
        <StatTile
          label="agent work"
          figure={hour(measures.agentHours.sumMs)}
          about={
            <>
              How much agent work was started. <AgentUnknown measure={measures.agentHours} />
            </>
          }
        />
        <StatTile
          label="in session"
          figure={hour(measures.sessionTime.unionThenSumMs)}
          about={
            <>
              How long people were in session. <SessionDetail measure={measures.sessionTime} />
            </>
          }
        />
        <StatTile
          label="agent cost"
          figure={money(measures.cost.vendorCostUsd)}
          about={
            <>
              What the started agent work cost. <CostUnknown measure={measures.cost} />
            </>
          }
        />
      </StatRow>
    </div>
  )
}

export const measureFormat = { hour, money }
