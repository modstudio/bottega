import { mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../shared/brand.ts'
import { BOTTEGA_ENTRY_PROTOCOL } from '../shared/self-spawn.ts'
import { buildHostBinary } from './build-binary.ts'

const scratch = mkdtempSync(join(tmpdir(), `${PLATFORM_SLUG}-smoke-`))

async function smoke(
  executable: string,
  args: string[],
  stateHome: string,
  expectedOutput?: string,
  expectedExit = 0,
): Promise<void> {
  const rendered = [executable, ...args].join(' ')
  const env = { ...process.env, BOTTEGA_STATE_HOME: stateHome }
  delete env.ORCH_DB
  delete env.ORCH_DB_WRITE
  delete env.HUB_DB
  const child = Bun.spawn([executable, ...args], {
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  console.log(`$ ${rendered}`)
  if (stdout.trim()) console.log(stdout.trim())
  if (stderr.trim()) console.error(stderr.trim())
  console.log(`exit ${exitCode}`)
  if (exitCode !== expectedExit) {
    throw new Error(`${rendered} exited ${exitCode}, expected ${expectedExit}`)
  }
  const output = `${stdout}\n${stderr}`
  if (expectedOutput && !output.includes(expectedOutput)) {
    throw new Error(`${rendered} output did not include ${JSON.stringify(expectedOutput)}`)
  }
}

try {
  const output = join(scratch, 'bin')
  const stateHome = join(scratch, 'state')
  const binary = await buildHostBinary('v0.1.0', output)
  const orch = join(output, 'orch')
  const hub = join(output, 'hub')
  symlinkSync(binary, orch)
  symlinkSync(binary, hub)
  await smoke(binary, ['--version'], stateHome)
  await smoke(binary, ['orch', '--version'], stateHome)
  await smoke(binary, ['hub', '--version'], stateHome)
  await smoke(hub, ['--help'], stateHome, `hub — every project's tasks in flight`)
  await smoke(binary, ['orch', 'migrate'], stateHome)
  await smoke(binary, ['hub', 'migrate'], stateHome)
  await smoke(orch, ['jobs'], stateHome, 'implement')
  await smoke(binary, ['orch', 'jobs'], stateHome)
  await smoke(binary, ['hub', 'collect', '--only', 'runs'], stateHome, 'collected in')
  await smoke(
    binary,
    ['orch', 'reclaim', 'fixture-questions', '--dry-run'],
    stateHome,
    'no orphan fixture questions found',
  )
  await smoke(
    binary,
    ['orch', 'doc', 'search', 'compiled-child-smoke'],
    stateHome,
    'embedding endpoint could not be established',
    1,
  )
  await smoke(
    binary,
    [...BOTTEGA_ENTRY_PROTOCOL['run-exec'].compiledArguments],
    stateHome,
    '/$bunfs/root/',
    1,
  )
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
