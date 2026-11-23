import { expect, test } from 'bun:test'
import { newRecordId, RECORD_ACTOR_ROLE, RECORD_OWNER_ROLE } from '../../shared/record/schema.ts'
import { asSpace, psql, succeeds } from './fixtures/postgres-rls.ts'

export function registerSpaceAgentRlsProof(spaceA: string, spaceB: string): void {
  test('space agent rows are tenant-confined and FORCE confines the table owner', () => {
    const idA = newRecordId()
    const idB = newRecordId()
    succeeds(
      'postgres',
      'postgres',
      `INSERT INTO space_agent
       (id,space_id,name,harness,backend,model,transport,route_metered,trains_on_inputs,operated_by,billing)
       VALUES
       ('${idA}','${spaceA}','space-a-agent','codex','vendor','proof','acp',false,false,'vendor','subscription'),
       ('${idB}','${spaceB}','space-b-agent','codex','vendor','proof','acp',false,false,'vendor','subscription');`,
    )

    const hidden = asSpace(
      RECORD_ACTOR_ROLE,
      'actor-password',
      spaceA,
      `SELECT name FROM space_agent WHERE id='${idB}';`,
    )
    expect(hidden.code, hidden.stderr).toBe(0)
    expect(hidden.stdout).toBe('')

    const crossed = asSpace(
      RECORD_ACTOR_ROLE,
      'actor-password',
      spaceA,
      `INSERT INTO space_agent
       (id,space_id,name,harness,backend,model,transport,route_metered,trains_on_inputs,operated_by,billing)
       VALUES
       ('${newRecordId()}','${spaceB}','crossed-agent','codex','vendor','proof','acp',false,false,'vendor','subscription');`,
    )
    expect(crossed.code).not.toBe(0)

    const owner = asSpace(
      RECORD_OWNER_ROLE,
      'owner-password',
      spaceA,
      'SELECT name FROM space_agent ORDER BY name;',
    )
    expect(owner.code, owner.stderr).toBe(0)
    expect(owner.stdout).toBe('space-a-agent')

    succeeds('postgres', 'postgres', `DELETE FROM space_agent WHERE id IN ('${idA}','${idB}');`)
  })

  test('space agent FORCE RLS is present', () => {
    const result = psql(
      'postgres',
      'postgres',
      `SELECT relforcerowsecurity FROM pg_class WHERE relname='space_agent';`,
    )
    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout).toBe('t')
  })
}
