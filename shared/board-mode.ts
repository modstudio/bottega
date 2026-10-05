// concern: board-mode-decision
/** Decides where one board operation belongs from plain install and operation facts. */

export type BoardLocality = 'machine-audience' | 'suggestion' | 'own-architect' | 'shared'

export type BoardModeDecision = { mode: 'local' | 'hosted' } | { mode: 'refused'; reason: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const LOCAL_ID = /^[1-9]\d*$/

const missingHostedConfiguration =
  'this install has adopted the hosted board but ORCH_RECORD_API_URL is not configured; configure the hosted record API and sign in with orch record sign-in'

export function decideBoardMode(facts: {
  adopted: boolean
  hostedConfigured: boolean
  locality: BoardLocality
}): BoardModeDecision {
  if (facts.locality !== 'shared') return { mode: 'local' }
  if (!facts.adopted) return { mode: 'local' }
  if (facts.hostedConfigured) return { mode: 'hosted' }
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
  hostedConfigured: boolean
}): BoardModeDecision {
  const noun = facts.noun ?? 'board id'
  const localId = Number(facts.id)
  if (LOCAL_ID.test(facts.id) && Number.isSafeInteger(localId)) return { mode: 'local' }
  if (!UUID.test(facts.id))
    return {
      mode: 'refused',
      reason: `${noun} must be either a positive integer string for a local SQLite board row or a UUID for a hosted board row`,
    }
  if (!facts.adopted)
    return {
      mode: 'refused',
      reason: `${noun} is a UUID for a hosted board row, but this install has not adopted the hosted board; retry from an install that has adopted the hosted board`,
    }
  if (!facts.hostedConfigured) return { mode: 'refused', reason: missingHostedConfiguration }
  return { mode: 'hosted' }
}
