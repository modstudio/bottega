import { beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { addRun, db, dir, setDoc, upsertProject } from '../test/fixture.ts'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { doctorCommand } from './doctor.ts'
import { cliVersion, versionBelow } from './agents.ts'
import { classifiedDockerResources } from './docker-resources.ts'
import { trackedTestResidue } from '../test/residue.ts'
const trackResidue = trackedTestResidue()

async function doctor() {
  const lines: string[] = []; let exit = 0
  await doctorCommand({ has: () => false }, { log: (...parts) => lines.push(parts.join(' ')), exitCode: (code) => { exit = code }, candidates: () => [], pick: () => ({ agent: 'none' }), jobs: () => [], acpRuntimeGaps: () => null })
  return { text: lines.join('\n'), exit }
}

beforeEach(() => { process.env.ORCH_LOCAL_BASE_URL = '' })

describe('doctor presentation', () => {
  test('doctor reports a checkout off its landing branch as a register question, not a failure', async () => {
    const repo = trackResidue(join(dir, 'doctor-off-trunk'))
    mkdirSync(repo, { recursive: true })
    const git = (...args: string[]) => Bun.spawnSync(['git', ...args], { cwd: repo, stdout: 'pipe', stderr: 'pipe' })
    expect(git('init', '-b', 'main').exitCode).toBe(0)
    expect(git('config', 'user.email', 'orch-test@example.invalid').exitCode).toBe(0)
    expect(git('config', 'user.name', 'Orch Test').exitCode).toBe(0)
    writeFileSync(join(repo, 'tracked.txt'), 'fixture\n')
    expect(git('add', '.').exitCode).toBe(0)
    expect(git('commit', '-m', 'fixture').exitCode).toBe(0)
    expect(git('checkout', '-b', 'topic').exitCode).toBe(0)
    upsertProject({ name: 'off-trunk', path: repo, settings: { trunk: 'main' } })
    const result = await doctor()
    expect(result.exit).toBe(0)
    expect(result.text).toContain('register questions (not run failures):')
    expect(result.text).toContain('off-trunk: checkout HEAD is topic, not landing branch main')
  })

  test('doctor retains resources whose repository root is unresolvable', async () => {
    const id = addRun({ agent: 'codex', job: 'implement', repo: 'adanim' }); db().query('UPDATE run SET worktree=? WHERE id=?').run(`/tmp/missing/orch-${id}`, id)
    const classified = classifiedDockerResources([{ kind: 'container', name: `orch-${id}-postgres-1`, runId: id }, { kind: 'volume', name: `orch-${id}_adanim-pgdata`, runId: id }], [{ id, repo: 'adanim', worktree: `/tmp/missing/orch-${id}`, status: 'ok', retentionReason: 'unresolvable repository root' }])
    expect(classified).toHaveLength(2); expect(classified.every((row) => row.condition === 'retained-worktree-resources')).toBe(true); expect(classified.every((row) => row.reason === 'unresolvable repository root')).toBe(true)
  })

  test('doctor prints every CLI version and warns below its recorded minimum', async () => {
    upsertProject({ name: PLATFORM_SLUG, path: '/registered/platform' }); const bin = trackResidue(join(dir, 'doctor-bin')); mkdirSync(bin, { recursive: true }); const versions = { codex: 'codex-cli 0.150.0', grok: 'grok 1.0.13 (build)', agy: '1.1.24', qwen: '0.7.1' }
    for (const [name, version] of Object.entries(versions)) { writeFileSync(join(bin, name), `#!/bin/sh\necho '${version}'\n`); chmodSync(join(bin, name), 0o755) }
    for (const [name, version] of Object.entries(versions)) expect(cliVersion(join(bin, name)).display).toBe(version)
    expect(versionBelow('0.150.0', '0.153.4')).toBe(true); expect(versionBelow('1.0.13', '1.0.13')).toBe(false)
  })

  test('doctor prints latest calibration axes and reminds at age and score thresholds', async () => {
    const id = addRun({ agent: 'codex', job: 'file-question' }); db().query("INSERT INTO score (run_id,delivery,quality,scored_at,scored_by) VALUES (?,'full','right',?,'claude')").run(id, '2026-01-01T00:00:00.000Z'); db().query("INSERT INTO calibration (run_id,delivery,quality,fidelity,at,session_id) VALUES (?,'full','right',NULL,?,'calibration-session')").run(id, '2026-01-02T00:00:00.000Z')
    const result = await doctor(); expect(result.text).toContain('delivery n=1'); expect(result.text).toContain('quality  n=1'); expect(result.text).toContain('recalibrate:')
  })

  test('doctor lists inject docs over the write threshold on a canon oversize line', async () => {
    setDoc({
      scope: 'global', subject: null, slug: 'oversize-inject', title: 'Oversize inject',
      body: 'z'.repeat(9 * 1024), delivery: 'inject', forceInject: 'keep for doctor listing',
    })
    const result = await doctor()
    expect(result.exit).toBe(0)
    expect(result.text).toContain('canon oversize')
    expect(result.text).toContain('global/_/oversize-inject')
    expect(result.text).toMatch(/headroom/)
  })
})
