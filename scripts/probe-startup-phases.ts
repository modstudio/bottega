// Report-only startup phase timer for doc canon check.
// Usage: bun --no-env-file scripts/probe-startup-phases.ts <checkout-root> <working-directory> [--rounds <count>]

import { startBoundedSync } from '../shared/bounded-process.ts'
import { refusal, renderRefusal } from '../shared/refusal.ts'

type PhaseSample = Record<string, number>

const args = process.argv.slice(2)
const root = args[0]
const workingDirectory = args[1]
const roundsFlag = args.indexOf('--rounds')
const rounds = roundsFlag === -1 ? 1 : Number(args[roundsFlag + 1])
const summarizesRounds = roundsFlag !== -1

if (
  !root ||
  !workingDirectory ||
  !Number.isInteger(rounds) ||
  rounds < (summarizesRounds ? 2 : 1)
) {
  throw new Error(
    'usage: bun --no-env-file scripts/probe-startup-phases.ts <checkout-root> <working-directory> [--rounds <count>]',
  )
}

const roundScript = String.raw`
const [root, workingDirectory] = process.argv.slice(1)
const phases = {}
let last = 0
const rounded = (value) => Math.round(value * 10) / 10
const mark = (name) => {
  const now = performance.now()
  phases[name] = rounded(now - last)
  last = now
}
mark('bun-boot')
const adapter = await import(root + '/cli/task-read-adapter.ts')
await import(root + '/cli/dispatch.ts')
mark('front-door-import')
adapter.installCliTaskReader()
await import(root + '/orchestrator/src/cli/orch.ts')
mark('orch-import')
const location = await import(root + '/orchestrator/src/database/database-location.ts')
location.recoverMissingWorkingDirectory()
mark('database-location')
const registration = await import(root + '/orchestrator/src/runtime/runtime-registration.ts')
registration.registerStandardRuntime()
mark('runtime-registration')
const database = await import(root + '/orchestrator/src/database/db.ts')
database.ensureDatabase()
database.db()
mark('store-open')
const program = await import(root + '/orchestrator/src/cli/program.ts')
mark('program-import')
program.recordInvocationSession(['canon', 'check', '--cwd', workingDirectory])
mark('session-stamp')
let firstCall = 0
const write = process.stderr.write.bind(process.stderr)
process.stderr.write = ((chunk, ...rest) => {
  const text = typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk)
  const match = /record-trace-call .*client_ms=([\d.]+)/.exec(text)
  if (match) {
    const start = performance.now() - Number(match[1])
    if (firstCall === 0 || start < firstCall) firstCall = start
  }
  return write(chunk, ...rest)
})
const packStart = performance.now()
const canon = await import(root + '/orchestrator/src/canon/canon.ts')
await canon.compilePack({ job: 'understand', cwd: workingDirectory })
const packEnd = performance.now()
if (firstCall === 0) throw new Error('the pack made no traced record call; set BOTTEGA_RECORD_TRACE=calls')
phases['pack-pre-network'] = rounded(firstCall - packStart)
phases['pack-network-and-after'] = rounded(packEnd - firstCall)
phases.total = rounded(packEnd)
console.log(JSON.stringify(phases))
`

function quantile(sorted: readonly number[], fraction: number): number {
  const position = (sorted.length + 1) * fraction - 1
  if (position <= 0) return sorted[0]!
  if (position >= sorted.length - 1) return sorted.at(-1)!
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  const weight = position - lower
  return sorted[lower]! * (1 - weight) + sorted[upper]! * weight
}

function rounded(value: number): number {
  return Math.round(value * 10) / 10
}

const samples: PhaseSample[] = []
for (let round = 1; round <= rounds; round += 1) {
  const result = startBoundedSync(
    [process.execPath, '--no-env-file', '-e', roundScript, root, workingDirectory],
    {
      budget: 'hosted-api',
      env: { ...process.env, BOTTEGA_RECORD_TRACE: 'calls' },
    },
  )
  const line = result.stdout.split('\n').find((output) => output.startsWith('{'))
  if (result.exitCode !== 0 || !line) {
    const stderr = result.stderr.trim()
    throw new Error(
      renderRefusal(
        refusal(`startup phase round ${round} failed${stderr ? `: ${stderr}` : ''}`, {
          kind: 'edit',
          text: 'restore record access and rerun the startup phase probe',
        }),
      ),
    )
  }
  const sample = JSON.parse(line) as PhaseSample
  samples.push(sample)
  console.log(JSON.stringify(sample))
}

if (summarizesRounds) {
  const summary = Object.fromEntries(
    Object.keys(samples[0]!).map((phase) => {
      const values = samples.map((sample) => sample[phase]!).sort((left, right) => left - right)
      return [
        phase,
        {
          median: rounded(quantile(values, 0.5)),
          p25: rounded(quantile(values, 0.25)),
          p75: rounded(quantile(values, 0.75)),
        },
      ]
    }),
  )
  console.log(JSON.stringify({ summary, rounds }))
}
