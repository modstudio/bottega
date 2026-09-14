import { describe,expect,test } from 'bun:test'
import { mkdirSync,realpathSync } from 'node:fs'
import { join } from 'node:path'
import { upsertProject } from '../../src/projects.ts'
import { dir } from '../fixtures/store.ts'

import { trackedTestResidue } from '../residue.ts'
const trackResidue = trackedTestResidue()

const hubCli = new URL('../../../hub/src/cli.ts', import.meta.url).pathname
function migrateHub(path: string): void {
  const result = Bun.spawnSync([process.execPath, hubCli, 'migrate'], {
    env: { ...process.env, HUB_DB: path }, stdout: 'pipe', stderr: 'pipe',
  })
  expect(result.exitCode, result.stderr.toString()).toBe(0)
}


describe('note hook process boundary', () => {
  test('the Stop hook lists only actionable notes through hub', () => {
    trackResidue(join(dir, 'note-hook-project')); mkdirSync(join(dir, 'note-hook-project'), { recursive: true })
    const cwd = realpathSync(join(dir, 'note-hook-project'))
    upsertProject({ name: 'note-hook-project', path: cwd, stack: 'typescript', canon: true,
      settings: { keyPrefixes: ['NHP'], trunk: 'main' } })
    const hubDb = trackResidue(join(dir, 'note-hook-hub.db'))
    trackResidue(`${hubDb}-shm`); trackResidue(`${hubDb}-wal`)
    migrateHub(hubDb)
    const session = 'actionable-note-hook-session'
    const env = { ...process.env, HUB_DB: hubDb, ORCH_DB: process.env.ORCH_DB!,
      HUB_ORCH: new URL('../../../bin/orch', import.meta.url).pathname,
      CLAUDE_CODE_SESSION_ID: session }
    const orchCli = new URL('../../src/orch.ts', import.meta.url).pathname
    for (const text of ['Promoted hook note', 'Dropped hook note', 'Actionable hook note']) {
      const filed = Bun.spawnSync([process.execPath, orchCli, 'note', text, '--new'], {
        cwd, env, stdout: 'pipe', stderr: 'pipe',
      })
      expect(filed.exitCode, filed.stderr.toString()).toBe(0)
    }
    const listed = Bun.spawnSync([process.execPath, hubCli, 'note', 'list', '--project', 'note-hook-project', '--json'], {
      cwd, env, stdout: 'pipe', stderr: 'pipe',
    })
    const notes = JSON.parse(listed.stdout.toString()) as { id: number; text: string }[]
    const id = (text: string) => notes.find((note) => note.text === text)!.id
    for (const args of [
      ['note', 'promote', String(id('Promoted hook note'))],
      ['note', 'drop', String(id('Dropped hook note')), '--reason', 'resolved'],
    ]) {
      const changed = Bun.spawnSync([process.execPath, hubCli, ...args], { cwd, env, stdout: 'pipe', stderr: 'pipe' })
      expect(changed.exitCode, changed.stderr.toString()).toBe(0)
    }

    const hook = Bun.spawnSync(['python3', new URL('../../hooks/score-reminder.py', import.meta.url).pathname], {
      env, stdin: new TextEncoder().encode(JSON.stringify({ session_id: session })), stdout: 'pipe', stderr: 'pipe',
    })
    expect(hook.exitCode, hook.stderr.toString()).toBe(0)
    const reason = JSON.parse(hook.stdout.toString()).reason as string
    expect(reason).toContain('Actionable hook note')
    expect(reason).not.toContain('Promoted hook note')
    expect(reason).not.toContain('Dropped hook note')

    const kept = Bun.spawnSync([process.execPath, hubCli, 'note', 'keep', String(id('Actionable hook note'))], {
      cwd, env, stdout: 'pipe', stderr: 'pipe',
    })
    expect(kept.exitCode, kept.stderr.toString()).toBe(0)
    const afterKeep = Bun.spawnSync(['python3', new URL('../../hooks/score-reminder.py', import.meta.url).pathname], {
      env, stdin: new TextEncoder().encode(JSON.stringify({ session_id: `payload-${session}` })), stdout: 'pipe', stderr: 'pipe',
    })
    expect(afterKeep.exitCode, afterKeep.stderr.toString()).toBe(0)
    expect(afterKeep.stdout.toString()).toBe('')
  })

})
