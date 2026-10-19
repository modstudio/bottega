import { collectedTime, relativeTime } from '@bottega/hub-util/format'

export function responseSubtitle(response: {
  collectedAt: string | null
  activeAgents: string[]
  servingSince: string
}) {
  const agent = `${response.activeAgents.length} agent${response.activeAgents.length === 1 ? '' : 's'} working`
  return {
    text: `${collectedTime(response.collectedAt)} \u00b7 ${agent}`,
    title: `Serving code from ${relativeTime(response.servingSince)}. ${response.activeAgents.length ? response.activeAgents.join(', ') : 'No agent on a task'}`,
  }
}
