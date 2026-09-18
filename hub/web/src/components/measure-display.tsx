import type { ReactNode } from 'react'
import type { MeasuresResponse } from '@/trpc/client'
import { StatRow, StatTile } from '@/ui/stat/stat'

const hour = (ms: number) =>
  `${(ms / 3_600_000).toLocaleString(undefined, { maximumFractionDigits: 1 })} hours`
const money = (usd: number) => usd.toLocaleString(undefined, { style: 'currency', currency: 'USD' })

function Unknown({ children, mostly }: { children: ReactNode; mostly: boolean }) {
  return (
    <span>
      {children}
      {mostly ? ' — attribution is mostly unknown' : ''}
    </span>
  )
}

export function SessionDetail({ measure }: { measure: MeasuresResponse['sessionTime'] }) {
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

export function AgentUnknown({ measure }: { measure: MeasuresResponse['agentHours'] }) {
  if (!measure.unknownShare) return null
  return (
    <Unknown mostly={measure.unknownShare.sumMs > measure.sumMs / 2}>
      {hour(measure.unknownShare.sumMs)} has an unknown person
    </Unknown>
  )
}

export function CostUnknown({ measure }: { measure: MeasuresResponse['cost'] }) {
  if (!measure.unknownShare) return null
  const mostly = measure.vendorCostUsd
    ? measure.unknownShare.vendorCostUsd > measure.vendorCostUsd / 2
    : measure.unknownShare.vendorTokens > measure.vendorTokens / 2
  return (
    <Unknown mostly={mostly}>
      {money(measure.unknownShare.vendorCostUsd)} and{' '}
      {measure.unknownShare.vendorTokens.toLocaleString()} tokens have an unknown person
    </Unknown>
  )
}

export function MeasuresSummary({
  measures,
  showShipped = true,
}: {
  measures: MeasuresResponse
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
      {showShipped && 'shipped' in measures ? (
        <StatTile
          label="How many tasks landed"
          figure={measures.shipped.count.toLocaleString()}
          hint="Landed in this window."
        />
      ) : null}
      {'cycleTime' in measures && measures.cycleTime ? (
        <StatTile
          label="How long landed work took"
          figure={hour(measures.cycleTime.medianMs)}
          hint={`Median cycle time; n=${measures.cycleTime.n}.`}
        />
      ) : null}
    </StatRow>
  )
}

export const measureFormat = { hour, money }
