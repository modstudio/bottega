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

export type MeasuresSummaryValue = {
  hoursRunning: { unionMs: number }
  agentHours: AgentHoursMeasure
  sessionTime: SessionTimeMeasure
  cost: CostMeasure
  shipped?: { count: number }
  cycleTime?: { medianMs: number; n: number }
}

type CoreMeasure = {
  key: 'hours-running' | 'agent-hours' | 'session-time' | 'cost'
  fullLabel: string
  shortLabel: string
  figure: string
  detail: ReactNode
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

export function coreMeasures(measures: MeasuresSummaryValue): CoreMeasure[] {
  return [
    {
      key: 'hours-running',
      fullLabel: 'How long any recorded work was in motion',
      shortLabel: 'in motion',
      figure: hour(measures.hoursRunning.unionMs),
      detail: 'Work was running; this figure is not additive.',
    },
    {
      key: 'agent-hours',
      fullLabel: 'How much agent work was started',
      shortLabel: 'agent work',
      figure: hour(measures.agentHours.sumMs),
      detail: <AgentUnknown measure={measures.agentHours} />,
    },
    {
      key: 'session-time',
      fullLabel: 'How long people were in session',
      shortLabel: 'in session',
      figure: hour(measures.sessionTime.unionThenSumMs),
      detail: <SessionDetail measure={measures.sessionTime} />,
    },
    {
      key: 'cost',
      fullLabel: 'What the started agent work cost',
      shortLabel: 'agent cost',
      figure: money(measures.cost.vendorCostUsd),
      detail: <CostUnknown measure={measures.cost} />,
    },
  ]
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
      {coreMeasures(measures).map((measure, index) => (
        <StatTile
          key={measure.key}
          label={measure.fullLabel}
          figure={measure.figure}
          hint={measure.detail}
          wrapHint={index > 0}
        />
      ))}
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

export const measureFormat = { hour, money }
