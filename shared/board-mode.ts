// concern: board-mode-decision
/** Decides where one board operation belongs from plain install and operation facts. */

export type BoardLocality = 'machine-audience' | 'suggestion' | 'own-architect' | 'shared'

export type BoardModeDecision = { mode: 'local' | 'hosted' } | { mode: 'refused'; reason: string }
type HostedConfigured = boolean | (() => boolean)

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const LOCAL_ID = /^[1-9]\d*$/

export type BoardIdShape = 'local' | 'hosted' | 'invalid'

/** Classifies an id without consulting install mode or configuration. */
export function classifyBoardId(id: string): BoardIdShape {
  const localId = Number(id)
  if (LOCAL_ID.test(id) && Number.isSafeInteger(localId)) return 'local'
  if (UUID.test(id)) return 'hosted'
  return 'invalid'
}

const missingHostedConfiguration =
  'this install has adopted the hosted board but ORCH_RECORD_API_URL is not configured; configure the hosted record API and sign in with orch record sign-in'

function isHostedConfigured(value: HostedConfigured): boolean {
  return typeof value === 'function' ? value() : value
}

export function decideBoardMode(facts: {
  adopted: boolean
  hostedConfigured: HostedConfigured
  locality: BoardLocality
}): BoardModeDecision {
  if (facts.locality !== 'shared') return { mode: 'local' }
  if (!facts.adopted) return { mode: 'local' }
  if (isHostedConfigured(facts.hostedConfigured)) return { mode: 'hosted' }
  return {
    mode: 'refused',
    reason: missingHostedConfiguration,
  }
}

/** Existing ids name their store independently of the install's creation mode. */
export function decideBoardIdMode(facts: {
  id: string
  noun?: string
  adopted: boolean
  hostedConfigured: HostedConfigured
}): BoardModeDecision {
  const noun = facts.noun ?? 'board id'
  const shape = classifyBoardId(facts.id)
  if (shape === 'local') return { mode: 'local' }
  if (shape === 'invalid')
    return {
      mode: 'refused',
      reason: `${noun} must be either a positive integer string for a local SQLite board row or a UUID for a hosted board row`,
    }
  if (!facts.adopted)
    return {
      mode: 'refused',
      reason: `${noun} is a UUID for a hosted board row, but this install has not adopted the hosted board; retry from an install that has adopted the hosted board`,
    }
  if (!isHostedConfigured(facts.hostedConfigured))
    return { mode: 'refused', reason: missingHostedConfiguration }
  return { mode: 'hosted' }
}
