import { StatRow, StatTile } from '@bottega/hub-ui/stat'
import { coreMeasures, type MeasuresSummaryValue } from './measures-summary.tsx'
import { taskMeasuresStyles } from './task-measures.styles.ts'

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
    return <p className={taskMeasuresStyles().noTime()}>No time was recorded for this task.</p>
  }
  return (
    <div className={taskMeasuresStyles().root()}>
      <StatRow compact>
        {coreMeasures(measures).map((measure) => (
          <StatTile
            key={measure.key}
            label={measure.shortLabel}
            figure={measure.figure}
            about={
              <>
                {measure.fullLabel}. {measure.detail}
              </>
            }
          />
        ))}
      </StatRow>
    </div>
  )
}
