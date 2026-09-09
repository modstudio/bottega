type Command = { cwd: string; argv: string[] }
type Leg = { name: string; commands: Command[] }
type LegResult = { name: string; exitCode: number; tail: string[] }

const root = new URL('..', import.meta.url).pathname
const checkStartedAt = performance.now()

// The current measured runtime is 329.49s; the ceiling leaves a 30.51s margin.
// The hosted-runner target is under 120_000ms. Lowering the budget is one edit.
export const SUITE_RUNTIME_BUDGET_MS = 360_000
const activeChildren = new Set<Bun.Subprocess>()
const runtimeDeadline = setTimeout(async () => {
  console.error(`suite runtime exceeded the ${(SUITE_RUNTIME_BUDGET_MS / 1000).toFixed(0)}s budget`)
  for (const child of activeChildren) child.kill('SIGTERM')
  await Bun.sleep(1_000)
  for (const child of activeChildren) child.kill('SIGKILL')
  process.exit(1)
}, SUITE_RUNTIME_BUDGET_MS)

function track(child: Bun.Subprocess) {
  activeChildren.add(child)
  void child.exited.finally(() => activeChildren.delete(child))
  return child
}

const legs: Leg[] = [
  {
    name: 'orchestrator',
    commands: [
      { cwd: `${root}orchestrator`, argv: ['bun', 'install', '--silent'] },
      { cwd: `${root}orchestrator`, argv: ['bun', 'run', 'typecheck'] },
      // The root gate uses the measured CLI shards while the package's ordinary
      // test command remains the unit/CLI split used outside the full gate.
      { cwd: `${root}orchestrator`, argv: ['bun', 'run', 'test:gate'] },
    ],
  },
  {
    name: 'hub',
    commands: [
      { cwd: `${root}hub`, argv: ['bun', 'install', '--silent'] },
      { cwd: `${root}hub`, argv: ['bun', 'run', 'typecheck'] },
      { cwd: `${root}hub`, argv: ['bun', 'run', 'test'] },
    ],
  },
  {
    name: 'hub/web',
    commands: [
      { cwd: `${root}hub/web`, argv: ['bun', 'install', '--silent'] },
      { cwd: `${root}hub/web`, argv: ['bun', 'run', 'typecheck'] },
      { cwd: `${root}hub/web`, argv: ['bun', 'run', 'test'] },
      { cwd: `${root}hub/web`, argv: ['bun', 'run', 'build'] },
    ],
  },
]

async function inherit(argv: string[], cwd = root) {
  const child = track(Bun.spawn(argv, { cwd, stdout: 'inherit', stderr: 'inherit' }))
  return child.exited
}

function qualityBaseArgument() {
  if (!process.env.CI) return '--staged'
  const landingBranch = process.env.GITHUB_BASE_REF || 'main'
  const result = Bun.spawnSync(['git', 'merge-base', `origin/${landingBranch}`, 'HEAD'], {
    cwd: root, stdout: 'pipe', stderr: 'pipe',
  })
  if (result.exitCode !== 0) {
    const detail = result.stderr.toString().trim()
    throw new Error(`quality ratchet could not resolve CI merge base with origin/${landingBranch}${detail ? `: ${detail}` : ''}`)
  }
  return `--base=${result.stdout.toString().trim()}`
}

async function pump(
  stream: ReadableStream<Uint8Array>, name: string, tail: string[], error: boolean,
) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let pending = ''
  for (;;) {
    const chunk = await reader.read()
    if (chunk.done) break
    pending += decoder.decode(chunk.value, { stream: true })
    const lines = pending.split('\n')
    pending = lines.pop()!
    for (const line of lines) {
      const prefixed = `[${name}] ${line}`
      ;(error ? console.error : console.log)(prefixed)
      tail.push(prefixed)
      if (tail.length > 40) tail.shift()
    }
  }
  pending += decoder.decode()
  if (pending) {
    const prefixed = `[${name}] ${pending}`
    ;(error ? console.error : console.log)(prefixed)
    tail.push(prefixed)
    if (tail.length > 40) tail.shift()
  }
}

async function runLeg(leg: Leg): Promise<LegResult> {
  const tail: string[] = []
  for (const command of leg.commands) {
    const child = track(Bun.spawn(command.argv, { cwd: command.cwd, stdout: 'pipe', stderr: 'pipe' }))
    const readers = [pump(child.stdout, leg.name, tail, false), pump(child.stderr, leg.name, tail, true)]
    const exitCode = await child.exited
    await Promise.all(readers)
    if (exitCode !== 0) return { name: leg.name, exitCode, tail }
  }
  return { name: leg.name, exitCode: 0, tail }
}

function refuseFailed(results: LegResult[]) {
  const failed = results.filter((result) => result.exitCode !== 0)
  if (!failed.length) return
  for (const result of failed) {
    console.error(`\n[${result.name}] failing leg tail (exit ${result.exitCode})`)
    for (const line of result.tail) console.error(line)
  }
  process.exit(1)
}

if (await inherit(['bun', 'install', '--silent']) !== 0) process.exit(1)

const installs = await Promise.all(legs.map((leg) => runLeg({
  name: leg.name,
  commands: [leg.commands[0]!],
})))
refuseFailed(installs)

if (await inherit([
  'bun', 'test', './.githooks/commit-msg.test.ts', './scripts/check-canon.test.ts',
  './scripts/quality/ratchet.test.ts',
]) !== 0) process.exit(1)

const results = await Promise.all(legs.map((leg) => runLeg({
  name: leg.name,
  commands: leg.commands.slice(1),
})))
refuseFailed(results)

for (const script of ['check-boundaries.ts', 'check-brand.ts', 'check-canon.ts', '../orchestrator/scripts/check-pack-budget.ts']) {
  const child = track(Bun.spawn(['bun', `${root}scripts/${script}`], {
    cwd: root, stdout: 'inherit', stderr: 'inherit',
  }))
  if (await child.exited !== 0) process.exit(1)
}

let qualityMode: string
try {
  qualityMode = qualityBaseArgument()
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
if (await inherit(['bun', `${root}scripts/quality/check-no-expect.ts`, qualityMode]) !== 0) {
  process.exit(1)
}

const elapsedMs = performance.now() - checkStartedAt
clearTimeout(runtimeDeadline)
console.log(`suite runtime: ${(elapsedMs / 1000).toFixed(2)}s / ${(SUITE_RUNTIME_BUDGET_MS / 1000).toFixed(0)}s budget`)
if (elapsedMs > SUITE_RUNTIME_BUDGET_MS) {
  console.error(`suite runtime budget exceeded by ${((elapsedMs - SUITE_RUNTIME_BUDGET_MS) / 1000).toFixed(2)}s`)
  process.exit(1)
}
