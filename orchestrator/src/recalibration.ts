// concern: recalibration
/**
 * Knows scored run samples, score vocabulary and arithmetic, and calibration
 * persistence. Must not know transports, worktrees, routing, the CLI, durable
 * execution, dispatch, or cleanup.
 */
import { createInterface } from 'node:readline/promises'
import type { Readable, Writable } from 'node:stream'
import { existsSync, readFileSync } from 'node:fs'
import { gwetAc1, quadraticWeightedKappa } from './agreement.ts'
import { db, nowIso, sessionId } from './db.ts'
import { JOBS } from './jobs.ts'
import { DELIVERY, FIDELITY, QUALITY, type Delivery, type Fidelity, type Quality } from './score.ts'

type RecalibrationFlags = { has(name: string): boolean; flag(name: string): string | undefined }
type RecalibrationPresentation = { log(...values: unknown[]): void; write(value: string): void; input: Readable; output: Writable }

export async function recalibrate(flags: RecalibrationFlags, presentation: RecalibrationPresentation): Promise<void> {
const rawN = flags.flag('n') ?? '12'
const n = Number(rawN)
if (!/^\d+$/.test(rawN) || !Number.isInteger(n) || n < 1) {
  throw new Error('--n must be a positive integer')
}
const scorer = flags.flag('scorer') ?? process.env.ORCH_SCORER ?? 'claude'
const rows = db().query(
  `SELECT r.id, r.job, r.output_path,
          s.delivery AS original_delivery, s.quality AS original_quality,
          s.fidelity AS original_fidelity
     FROM score s JOIN run r ON r.id = s.run_id
    WHERE datetime(s.scored_at) < datetime('now', '-7 days')
      AND (? = 1 OR s.scored_by = ?)
    ORDER BY random()`,
).all(flags.has('force') ? 1 : 0, scorer) as {
  id: number; job: string; output_path: string | null
  original_delivery: Delivery; original_quality: Quality | null
  original_fidelity: Fidelity | null
}[]
const sample = rows.filter((row) => row.output_path && existsSync(row.output_path)).slice(0, n)
if (!sample.length) {
  presentation.log('no scored runs older than 7 days with output still on disk')
  return
}

const rl = createInterface({ input: presentation.input, output: presentation.output })
const verdicts = rl[Symbol.asyncIterator]()
const results: {
  original: [Delivery, Quality | null, Fidelity | null]
  fresh: [Delivery, Quality | null, Fidelity | null]
}[] = []
const calibrationAt = nowIso()
try {
  for (const row of sample) {
    const output = readFileSync(row.output_path!, 'utf8')
    const excerpt = output.length <= 6000
      ? output
      : `${output.slice(0, 4000)}\n\n... output middle hidden ...\n\n${output.slice(-2000)}`
    const writes = Boolean(JOBS[row.job]?.needs.writesRepo)
    presentation.log(`\nrun ${row.id} / ${row.job}`)
    presentation.log(`axes: delivery quality${writes ? ' fidelity' : ''}`)
    presentation.log(excerpt)
    const hint = writes
      ? '<none | partial/full wrong/mixed/right drifted/partial/faithful>'
      : '<none | partial/full wrong/mixed/right>'
    presentation.write(`verdict ${hint}: `)
    const line = await verdicts.next()
    if (line.done) throw new Error('stdin ended before every sampled run was judged')
    const answer = line.value.trim().split(/\s+/)
    const delivery = answer[0] as Delivery | undefined
    const quality = answer[1] as Quality | undefined
    const fidelity = answer[2] as Fidelity | undefined
    if (!delivery || !DELIVERY.includes(delivery)) {
      throw new Error(`delivery must be one of: ${DELIVERY.join(' | ')}`)
    }
    if (delivery === 'none' && quality) {
      throw new Error("delivery 'none' takes no quality: there was nothing to judge")
    }
    if (delivery !== 'none' && (!quality || !QUALITY.includes(quality))) {
      throw new Error(`delivery '${delivery}' needs a quality: ${QUALITY.join(' | ')}`)
    }
    const needsFidelity = writes && delivery !== 'none'
    if (needsFidelity && (!fidelity || !FIDELITY.includes(fidelity))) {
      throw new Error(`this writing job needs fidelity: ${FIDELITY.join(' | ')}`)
    }
    if ((!needsFidelity && fidelity) || answer.length > (needsFidelity ? 3 : delivery === 'none' ? 1 : 2)) {
      throw new Error('too many verdict words for this run')
    }
    const fresh: [Delivery, Quality | null, Fidelity | null] = [
      delivery, quality ?? null, needsFidelity ? fidelity! : null,
    ]
    db().query(
      `INSERT INTO calibration (run_id, delivery, quality, fidelity, at, session_id)
       VALUES (?,?,?,?,?,?)`,
    ).run(row.id, ...fresh, calibrationAt, sessionId())
    results.push({
      original: [row.original_delivery, row.original_quality, row.original_fidelity], fresh,
    })
  }
} finally {
  rl.close()
}

const axes = [
  { name: 'delivery', levels: DELIVERY as readonly string[], at: 0 },
  { name: 'quality', levels: QUALITY as readonly string[], at: 1 },
  { name: 'fidelity', levels: FIDELITY as readonly string[], at: 2 },
]
const reading = (k: number) => k < 0.4 ? 'ambiguous rubric'
  : k <= 0.6 ? 'weak' : k <= 0.8 ? 'usable' : 'strong'
for (const axis of axes) {
  const pairs = results.map((r) => [r.original[axis.at], r.fresh[axis.at]] as const)
    .filter((p) => p[0] != null && p[1] != null) as [string, string][]
  if (!pairs.length) continue
  const kappa = quadraticWeightedKappa(pairs, axis.levels)
  if (kappa === null) {
    const ac1 = gwetAc1(pairs, axis.levels)
    presentation.log(`${axis.name}: n=${pairs.length} kappa=n/a ac1=${ac1 === null ? 'n/a' : ac1.toFixed(3)} reading=not measurable`)
  } else {
    const ac1 = gwetAc1(pairs, axis.levels)
    presentation.log(`${axis.name}: n=${pairs.length} kappa=${kappa.toFixed(3)} ac1=${ac1 === null ? 'n/a' : ac1.toFixed(3)} reading=${reading(kappa)}`)
  }
}
}
