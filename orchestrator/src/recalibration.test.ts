import { afterEach, describe, expect, test } from 'bun:test'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { addRun, dir } from '../test/fixtures/store.ts'
import { db } from './db.ts'
import { recalibrate } from './recalibration.ts'

const priorCalibrationSession = process.env.CLAUDE_CODE_SESSION_ID
const outputs: string[] = []
afterEach(() => {
  if (priorCalibrationSession === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
  else process.env.CLAUDE_CODE_SESSION_ID = priorCalibrationSession
  for (const output of outputs.splice(0)) rmSync(output, { force: true })
})

describe('recalibrating the scorer', () => {
  const runRecalibrate = async (input: string, ...args: string[]) => {
    process.env.CLAUDE_CODE_SESSION_ID = 'calibration-session'
    const stdin = new PassThrough()
    stdin.end(input)
    let out = ''
    const output = new Writable({
      write(chunk, _encoding, done) {
        out += chunk.toString()
        done()
      },
    })
    const logs: string[] = []
    const values = new Map<string, string>()
    for (let i = 0; i < args.length; i++)
      if (args[i]!.startsWith('--')) values.set(args[i]!.slice(2), args[i + 1] ?? '')
    await recalibrate(
      { has: (name) => args.includes(`--${name}`), flag: (name) => values.get(name) },
      {
        log: (...items) => logs.push(items.join(' ')),
        write: (value) => {
          out += value
        },
        input: stdin,
        output,
      },
    )
    return { code: 0, out: [...logs, out].join('\n'), err: '' }
  }
  const oldScore = (
    runId: number,
    delivery: string,
    quality: string | null,
    fidelity: string | null,
    scorer = 'claude',
    scoredAt = '2026-01-01T00:00:00.000Z',
  ) =>
    db()
      .query(
        `INSERT INTO score (run_id, delivery, quality, fidelity, scored_at, scored_by)
     VALUES (?,?,?,?,?,?)`,
      )
      .run(runId, delivery, quality, fidelity, scoredAt, scorer)

  test('blind verdicts are stored apart and kappa is printed per comparable axis', async () => {
    const originals = [
      ['none', null, null],
      ['partial', 'wrong', 'drifted'],
      ['full', 'right', 'faithful'],
    ] as const
    for (const [i, original] of originals.entries()) {
      const id = addRun({ agent: 'codex', job: 'implement' })
      const output = join(dir, `calibration-${i}.txt`)
      outputs.push(output)
      writeFileSync(output, `answer ${i}`)
      db().query('UPDATE run SET output_path=? WHERE id=?').run(output, id)
      oldScore(id, original[0], original[1], original[2])
    }

    const r = await runRecalibrate(
      'full right faithful\nfull right faithful\nfull right faithful\n',
      '--n',
      '3',
    )
    expect(r.code).toBe(0)
    expect(r.err).toBe('')
    expect(r.out).toContain('axes: delivery quality fidelity')
    expect(r.out).toContain('delivery: n=3 kappa=0.000 ac1=0.111 reading=ambiguous rubric')
    expect(r.out).toContain('quality: n=2 kappa=0.000 ac1=0.385 reading=ambiguous rubric')
    expect(r.out).toContain('fidelity: n=2 kappa=0.000 ac1=0.385 reading=ambiguous rubric')
    expect(
      db()
        .query(`SELECT delivery, quality, fidelity, session_id FROM calibration ORDER BY id`)
        .all(),
    ).toEqual(
      Array.from({ length: 3 }, () => ({
        delivery: 'full',
        quality: 'right',
        fidelity: 'faithful',
        session_id: 'calibration-session',
      })),
    )
    expect(db().query('SELECT delivery, quality, fidelity FROM score ORDER BY id').all()).toEqual(
      originals.map(([delivery, quality, fidelity]) => ({ delivery, quality, fidelity })),
    )
  })

  test('age and scorer identity filter the sample, while force skips only identity', async () => {
    const foreign = addRun({ agent: 'codex', job: 'file-question' })
    const foreignOut = join(dir, 'calibration-foreign.txt')
    outputs.push(foreignOut)
    writeFileSync(foreignOut, 'foreign output')
    db().query('UPDATE run SET output_path=? WHERE id=?').run(foreignOut, foreign)
    oldScore(foreign, 'full', 'right', null, 'someone-else')

    const recent = addRun({ agent: 'codex', job: 'file-question' })
    const recentOut = join(dir, 'calibration-recent.txt')
    outputs.push(recentOut)
    writeFileSync(recentOut, 'recent output')
    db().query('UPDATE run SET output_path=? WHERE id=?').run(recentOut, recent)
    oldScore(recent, 'full', 'right', null, 'claude', new Date().toISOString())

    const missing = addRun({ agent: 'codex', job: 'file-question' })
    db().query('UPDATE run SET output_path=? WHERE id=?').run('/definitely/missing/DEV-86', missing)
    oldScore(missing, 'full', 'right', null)

    const filtered = await runRecalibrate('')
    expect(filtered.code).toBe(0)
    expect(filtered.out).toContain('no scored runs older than 7 days with output still on disk')
    const forced = await runRecalibrate('full right\n', '--force', '--n', '1')
    expect(forced.code).toBe(0)
    expect(forced.out).toContain('foreign output')
    expect(forced.out).not.toContain('recent output')
    expect((db().query('SELECT COUNT(*) AS n FROM calibration').get() as { n: number }).n).toBe(1)
  })
})
