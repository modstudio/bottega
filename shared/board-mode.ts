// concern: board-mode-decision
/** Decides where one board operation belongs from plain install and operation facts. */

export type BoardLocality = 'machine-audience' | 'suggestion' | 'own-architect' | 'shared'

export type BoardModeDecision = { mode: 'local' | 'hosted' } | { mode: 'refused'; reason: string }

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
    reason:
      'this install has adopted the hosted board but ORCH_RECORD_API_URL is not configured; configure the hosted record API and sign in with orch record sign-in',
  }
}
