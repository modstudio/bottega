import { expect, test } from 'bun:test'
import { seedNeutralCodexQuotaReading } from '../../test/fixtures/store.ts'
import { AGENTS, refreshAgents } from '../agent/agent-registry.ts'
import { db } from '../database/db.ts'
import { pick } from './route.ts'
import { RoutingRefusalError } from './routing-refusal.ts'

test('canonical OpenRouter models exclude routing variants while another model remains', () => {
  seedNeutralCodexQuotaReading()
  const originals = db()
    .query("SELECT name,model,base_url FROM agent WHERE name IN ('codex','grok')")
    .all() as { name: string; model: string; base_url: string | null }[]
  try {
    db()
      .query(
        "UPDATE agent SET model='x/y:floor',base_url='https://openrouter.ai/api/v1' WHERE name='grok'",
      )
      .run()
    db()
      .query(
        "UPDATE agent SET model='x/z',base_url='https://openrouter.ai/api/v1' WHERE name='codex'",
      )
      .run()
    refreshAgents()
    const agents = Object.keys(AGENTS).filter((name) => name !== 'codex' && name !== 'grok')

    expect(pick('review-lens', undefined, 0, false, null, { agents, models: ['x/y'] }).agent).toBe(
      'codex',
    )

    let refusal: unknown
    try {
      pick('review-lens', undefined, 0, false, null, { agents, models: ['x/y', 'x/z'] })
    } catch (error) {
      refusal = error
    }
    expect(refusal).toBeInstanceOf(RoutingRefusalError)
    expect((refusal as Error).message).toContain('grok: model x/y:floor was excluded')
  } finally {
    for (const original of originals) {
      db()
        .query('UPDATE agent SET model=?,base_url=? WHERE name=?')
        .run(original.model, original.base_url, original.name)
    }
    refreshAgents()
  }
})
