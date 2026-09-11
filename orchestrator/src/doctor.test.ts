import { beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { addRun, db, dir, upsertProject } from '../test/fixture.ts'
import { doctorCommand } from './doctor.ts'
import { cliVersion, versionBelow } from './agents.ts'
import { classifiedDockerResources } from './docker-resources.ts'

async function doctor() {
  const lines: string[] = []; let exit = 0
  await doctorCommand({ has: () => false }, { log: (...parts) => lines.push(parts.join(' ')), exitCode: (code) => { exit = code }, candidates: () => [], pick: () => ({ agent: 'none' }), jobs: () => [], acpRuntimeGaps: () => null })
  return { text: lines.join('\n'), exit }
}

beforeEach(() => { process.env.ORCH_LOCAL_BASE_URL = '' })

describe('doctor presentation', () => {
  test('doctor retains resources whose repository root is unresolvable', async () => {
    const id = addRun({ agent: 'codex', job: 'implement', repo: 'adanim' }); db().query('UPDATE run SET worktree=? WHERE id=?').run(`/tmp/missing/orch-${id}`, id)
    const classified = classifiedDockerResources([{ kind: 'container', name: `orch-${id}-postgres-1`, runId: id }, { kind: 'volume', name: `orch-${id}_adanim-pgdata`, runId: id }], [{ id, repo: 'adanim', worktree: `/tmp/missing/orch-${id}`, status: 'ok', retentionReason: 'unresolvable repository root' }])
    expect(classified).toHaveLength(2); expect(classified.every((row) => row.condition === 'retained-worktree-resources')).toBe(true); expect(classified.every((row) => row.reason === 'unresolvable repository root')).toBe(true)
  })

  test('doctor prints every CLI version and warns below its recorded minimum', async () => {
    upsertProject({ name: 'bottega', path: '/registered/platform' }); const bin = join(dir, 'doctor-bin'); mkdirSync(bin, { recursive: true }); const versions = { codex: 'codex-cli 0.150.0', grok: 'grok 1.0.13 (build)', agy: '1.1.24', qwen: '0.7.1' }
    for (const [name, version] of Object.entries(versions)) { writeFileSync(join(bin, name), `#!/bin/sh\necho '${version}'\n`); chmodSync(join(bin, name), 0o755) }
    for (const [name, version] of Object.entries(versions)) expect(cliVersion(join(bin, name)).display).toBe(version)
    expect(versionBelow('0.150.0', '0.153.4')).toBe(true); expect(versionBelow('1.0.13', '1.0.13')).toBe(false)
  })

  test('doctor prints latest calibration axes and reminds at age and score thresholds', async () => {
    const id = addRun({ agent: 'codex', job: 'file-question' }); db().query("INSERT INTO score (run_id,delivery,quality,scored_at,scored_by) VALUES (?,'full','right',?,'claude')").run(id, '2026-01-01T00:00:00.000Z'); db().query("INSERT INTO calibration (run_id,delivery,quality,fidelity,at,session_id) VALUES (?,'full','right',NULL,?,'calibration-session')").run(id, '2026-01-02T00:00:00.000Z')
    const result = await doctor(); expect(result.text).toContain('delivery n=1'); expect(result.text).toContain('quality  n=1'); expect(result.text).toContain('recalibrate:')
  })
})
