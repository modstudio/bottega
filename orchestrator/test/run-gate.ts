import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveGateTimingDirectory } from '../../shared/gate-timing-directory.ts'
import { mainCheckoutOf } from '../../shared/git.ts'
import { withGateSlot } from '../src/gate-load.ts'
import { publishTimingSummary } from './gate-timing-summary.ts'
import { type GateTimings, mergeTimings } from './record-gate-timings.ts'

const orchRoot = fileURLToPath(new URL('..', import.meta.url))
const timingStamp = new Date().toISOString().replace(/[:.]/g, '-')
const checkout = resolve(orchRoot, '..')
const timingDir = resolveGateTimingDirectory(
  checkout,
  mainCheckoutOf(checkout) !== checkout,
  process.env,
  tmpdir(),
)
const timingPath = join(timingDir, `${timingStamp}.json`)
mkdirSync(timingDir, { recursive: true })

async function pump(stream: ReadableStream<Uint8Array>, error: boolean): Promise<void> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let pending = ''
  for (;;) {
    const chunk = await reader.read()
    if (chunk.done) break
    pending += decoder.decode(chunk.value, { stream: true })
    const lines = pending.split('\n')
    pending = lines.pop()!
    for (const line of lines) (error ? console.error : console.log)(line)
  }
  pending += decoder.decode()
  if (pending) (error ? console.error : console.log)(pending)
}

async function runTests(): Promise<GateTimings> {
  const junitPath = join(timingDir, `${timingStamp}.unit.junit.xml`)
  const sidecarBase = join(timingDir, `${timingStamp}.unit.json`)
  const command = ['bun', 'test', 'src', '--reporter=junit', `--reporter-outfile=${junitPath}`]
  const started = Date.now()
  const child = Bun.spawn(command, {
    cwd: orchRoot,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ORCH_GATE_TIMINGS: sidecarBase },
  })
  await Promise.all([pump(child.stdout, false), pump(child.stderr, true)])
  const exitCode = await child.exited
  const sidecarPath = `${sidecarBase}.spawn.json`
  const timing = mergeTimings(
    JSON.parse(readFileSync(sidecarPath, 'utf8')),
    readFileSync(junitPath, 'utf8'),
    { stamp: timingStamp, command, elapsedMs: Date.now() - started, exitCode },
  )
  unlinkSync(junitPath)
  unlinkSync(sidecarPath)
  return timing
}

const timing = await withGateSlot(runTests)
writeFileSync(timingPath, `${JSON.stringify(timing, null, 2)}\n`)
console.log(`wrote ${timingPath}`)
console.log('orchestrator test wall time top ten:')
for (const file of [...timing.files].sort((a, b) => b.wallMs - a.wallMs).slice(0, 10)) {
  console.log(`${file.file} ${Math.round(file.wallMs)}ms`)
}
const timingPassed = publishTimingSummary(timing.files, timing.elapsedMs)
process.exit(timing.exitCode !== 0 || !timingPassed ? 1 : 0)
