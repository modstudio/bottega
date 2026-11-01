import { expect, test } from 'bun:test'
import { forceRlsLiftViolations } from './record-migration-force-rls-lifts.ts'

const forced = new Set(['selection', 'profile', 'revision'])

test('refuses a FORCE-RLS read when the migration lifts no table', () => {
  const violations = forceRlsLiftViolations('INSERT INTO selection SELECT * FROM profile;', forced)
  expect(violations).toEqual([{ table: 'profile' }])
})

test('refuses a partial lift that joins an unlifted FORCE-RLS table', () => {
  const violations = forceRlsLiftViolations(
    `ALTER TABLE selection NO FORCE ROW LEVEL SECURITY;
     DO $$ BEGIN
       UPDATE selection SET version_id = profile.current_id FROM profile;
     END $$;`,
    forced,
  )
  expect(violations).toEqual([{ table: 'profile' }])
})

test('accepts a full lift', () => {
  const violations = forceRlsLiftViolations(
    `ALTER TABLE selection NO FORCE ROW LEVEL SECURITY;
     ALTER TABLE profile NO FORCE ROW LEVEL SECURITY;
     DO $$ BEGIN
       UPDATE selection SET version_id = profile.current_id FROM profile;
     END $$;`,
    forced,
  )
  expect(violations).toEqual([])
})

test('ignores a function body because it runs at call time', () => {
  const violations = forceRlsLiftViolations(
    `ALTER TABLE selection NO FORCE ROW LEVEL SECURITY;
     CREATE FUNCTION resolve_selection() RETURNS void LANGUAGE plpgsql AS $$
     BEGIN
       UPDATE selection SET version_id = profile.current_id FROM profile;
     END $$;`,
    forced,
  )
  expect(violations).toEqual([])
})

test('refuses quoted SQL that a DO block may EXECUTE at migrate time', () => {
  const violations = forceRlsLiftViolations(
    `DO $$
     BEGIN EXECUTE $q$UPDATE profile SET version = 2$q$; END
     $$;`,
    forced,
  )
  expect(violations).toEqual([{ table: 'profile' }])
})

test('accepts a named table exemption', () => {
  const violations = forceRlsLiftViolations(
    `ALTER TABLE selection NO FORCE ROW LEVEL SECURITY;
     UPDATE selection SET version_id = profile.current_id FROM profile;`,
    forced,
    new Set(['profile']),
  )
  expect(violations).toEqual([])
})
