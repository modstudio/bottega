type Command = { cwd: string; argv: string[] }
type Leg = { name: string; commands: Command[] }
type LegResult = { name: string; exitCode: number; tail: string[] }

const root = new URL('..', import.meta.url).pathname
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
  const child = Bun.spawn(argv, { cwd, stdout: 'inherit', stderr: 'inherit' })
  return child.exited
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
    const child = Bun.spawn(command.argv, { cwd: command.cwd, stdout: 'pipe', stderr: 'pipe' })
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
]) !== 0) process.exit(1)

const results = await Promise.all(legs.map((leg) => runLeg({
  name: leg.name,
  commands: leg.commands.slice(1),
})))
refuseFailed(results)

for (const script of ['check-boundaries.ts', 'check-brand.ts', 'check-canon.ts']) {
  const child = Bun.spawn(['bun', `${root}scripts/${script}`], {
    cwd: root, stdout: 'inherit', stderr: 'inherit',
  })
  if (await child.exited !== 0) process.exit(1)
}
