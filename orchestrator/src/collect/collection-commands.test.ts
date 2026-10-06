import { expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { addRun, dir } from '../../test/fixtures/store.ts'
import { trackedTestResidue } from '../../test/residue.ts'
import { db } from '../database/db.ts'
import { resultCommand } from './collection-commands.ts'

const trackResidue = trackedTestResidue()

test('result renders a lifecycle row without a dispatch-job lookup or thin-output warning', () => {
  const id = addRun({ agent: '(architect)', job: 'hook-tree', status: 'ok', latency: 360_000 })
  const output = trackResidue(join(dir, `hook-tree-result-${id}.txt`))
  writeFileSync(output, 'hook lifecycle complete')
  db().query('UPDATE run SET output_path=? WHERE id=?').run(output, id)
  const lines: string[] = []

  resultCommand(db(), ['result', String(id)], () => '', {
    log: (...values) => lines.push(values.join(' ')),
    error: (...values) => lines.push(values.join(' ')),
    exit: (code) => {
      throw new Error(`unexpected exit ${code}`)
    },
  })

  expect(lines.join('\n')).toContain('hook lifecycle complete')
  expect(lines.join('\n')).not.toContain('thin:')
})

test('result tells the caller how to open a released writing tree', () => {
  const id = addRun({ agent: 'codex', job: 'implement' })
  db().query('UPDATE run SET minted_branch=?, worktree=NULL WHERE id=?').run('DEV-1084-work', id)
  const lines: string[] = []

  resultCommand(db(), ['result', String(id)], () => '', {
    log: (...values) => lines.push(values.join(' ')),
    error: (...values) => lines.push(values.join(' ')),
    exit: (code) => {
      throw new Error(`unexpected exit ${code}`)
    },
  })

  expect(lines.join('\n')).toContain(`branch:    DEV-1084-work\n  open tree:  orch tree open ${id}`)
})
