import { StatRow, StatTile } from '@bottega/hub-ui/stat'

const number = new Intl.NumberFormat('en-US')

export type WorkStatsResponse = {
  engaged: string
  activeAgents: string[]
  tasksShipped: number
}

/** The window's headline figures. */
export function WorkStats({ response }: { response: WorkStatsResponse }) {
  return (
    <StatRow>
      <StatTile figure={response.engaged} label="Engaged" live={response.activeAgents.length > 0} />
      <StatTile
        figure={response.activeAgents.length}
        label="Agents working"
        hint={response.activeAgents.join(', ') || 'No agent on a task'}
      />
      <StatTile
        figure={number.format(response.tasksShipped)}
        label="Tasks shipped"
        hint="Last 14 days"
      />
    </StatRow>
  )
}
