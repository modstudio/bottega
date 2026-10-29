import { expect, test } from 'bun:test'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { addRun, dir } from '../../test/fixtures/store.ts'
import { db, sessionId } from '../database/db.ts'
import { pendingCommand } from './pending-commands.ts'

const reply = (status: 'done' | 'refused', summary: string) =>
  JSON.stringify({
    status,
    summary,
    files_changed: null,
    change_guide: null,
    questions: null,
    deviations: null,
    blockers: null,
    tests: null,
  })

test('pending marks a refusal from the latest turn and ignores done and absent replies', () => {
  const owner = sessionId()
  const refused = addRun({ agent: 'codex', job: 'implement', session: owner })
  const child = addRun({
    agent: 'codex',
    job: 'implement',
    session: owner,
    parent: refused,
    turn: 2,
  })
  const done = addRun({ agent: 'codex', job: 'implement', session: owner })
  addRun({ agent: 'codex', job: 'implement', session: owner })
  const refusedPath = join(dir, `pending-refused-${child}.txt`)
  const donePath = join(dir, `pending-done-${done}.txt`)
  writeFileSync(refusedPath, reply('refused', 'wrong premise at spec.ts:8\nmore'))
  writeFileSync(donePath, reply('done', 'finished'))
  db().query('UPDATE run SET output_path=? WHERE record_id=?').run(refusedPath, child)
  db().query('UPDATE run SET output_path=? WHERE record_id=?').run(donePath, done)

  try {
    const output: string[] = []
    pendingCommand(() => '', { log: (value) => output.push(value), setExitCode: () => {} })
    const shown = output.join('\n')
    expect(shown).toContain('refused: "wrong premise at spec.ts:8"')
    expect(shown).toContain('correct with evidence: full right faithful')
    expect(shown.match(/refused:/g)).toHaveLength(1)
  } finally {
    rmSync(refusedPath, { force: true })
    rmSync(donePath, { force: true })
  }
})

test('pending gives failed runs the remedy that releases their cleanup hold', () => {
  const owner = sessionId()
  const contract = addRun({
    agent: 'codex',
    job: 'implement',
    status: 'failed',
    kind: 'contract',
    session: owner,
  })
  const interrupted = addRun({
    agent: 'codex',
    job: 'implement',
    status: 'failed',
    kind: 'interrupted',
    session: owner,
  })
  const output: string[] = []

  pendingCommand(() => '', { log: (value) => output.push(value), setExitCode: () => {} })

  const shown = output.join('\n')
  expect(shown).toContain(
    `${PLATFORM_SLUG} score ${contract} none   # codex/implement  head  failed/contract`,
  )
  expect(shown).toContain(
    `${PLATFORM_SLUG} score ${interrupted} none --void --note "<why>"   # codex/implement  head  failed/interrupted`,
  )
})
