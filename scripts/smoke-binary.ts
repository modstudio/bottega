import { Database } from 'bun:sqlite'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PLATFORM_SLUG } from '../shared/brand.ts'
import { BOTTEGA_ENTRY_PROTOCOL } from '../shared/self-spawn.ts'
import { buildHostBinary } from './build-binary.ts'
import { run } from './build-release.ts'

const scratch = mkdtempSync(join(tmpdir(), `${PLATFORM_SLUG}-smoke-`))
let recordApiUrl: string | undefined
let securityBin: string | undefined
let harnessBin: string | undefined
let mcpRecord: string | undefined
let mcpState: string | undefined

function smokeEnvironment(stateHome: string): Record<string, string | undefined> {
  const env = {
    ...process.env,
    BOTTEGA_STATE_HOME: stateHome,
    ...(securityBin
      ? {
          PATH: [harnessBin, securityBin, '/usr/bin', '/bin'].filter(Boolean).join(':'),
        }
      : {}),
    ...(mcpRecord ? { SMOKE_MCP_RECORD: mcpRecord } : {}),
    ...(mcpState ? { SMOKE_MCP_STATE: mcpState } : {}),
  }
  for (const key of Object.keys(env)) {
    if (key.startsWith('ORCH_') || key.startsWith('CLAUDE_') || key.startsWith('ANTHROPIC_')) {
      delete env[key]
    }
  }
  env.CLAUDE_CODE_SESSION_ID = 'DEV-997-binary-smoke'
  env.ORCH_EMBED_URL = 'http://127.0.0.1:1/v1/embeddings'
  env.ORCH_RERANK_URL = 'http://127.0.0.1:1/v1/rerank'
  if (recordApiUrl) env.ORCH_RECORD_API_URL = recordApiUrl
  delete env.HUB_HOSTED_URL
  delete env.HUB_DB
  return env
}

async function smoke(
  executable: string,
  args: string[],
  stateHome: string,
  expectedOutput?: string,
  expectedExit = 0,
  cwd?: string,
): Promise<string> {
  const rendered = [executable, ...args].join(' ')
  const child = Bun.spawn([executable, ...args], {
    cwd,
    env: smokeEnvironment(stateHome),
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
  return stdout
}

async function freePort(): Promise<number> {
  const reservation = createServer()
  await new Promise<void>((resolve, reject) => {
    reservation.once('error', reject)
    reservation.listen(0, '127.0.0.1', resolve)
  })
  const address = reservation.address()
  const port = typeof address === 'object' && address !== null ? address.port : undefined
  await new Promise<void>((resolve, reject) =>
    reservation.close((error) => (error ? reject(error) : resolve())),
  )
  if (port === undefined) throw new Error('could not reserve a smoke-test port')
  return port
}

async function smokeDashboard(executable: string, stateHome: string): Promise<void> {
  const port = await freePort()
  const args = ['hub', 'serve', '--port', String(port)]
  const rendered = [executable, ...args].join(' ')
  const child = Bun.spawn([executable, ...args], {
    env: smokeEnvironment(stateHome),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const stdout = new Response(child.stdout).text()
  const stderr = new Response(child.stderr).text()
  try {
    let response: Response | undefined
    let failure: unknown
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        response = await fetch(`http://127.0.0.1:${port}/`)
        break
      } catch (error) {
        failure = error
        await Bun.sleep(50)
      }
    }
    if (!response) throw new Error(`${rendered} did not accept requests: ${String(failure)}`)
    const html = await response.text()
    if (response.status !== 200 || !/<[^>]+id=["']root["']/.test(html)) {
      throw new Error(`${rendered} returned ${response.status} without the app root element`)
    }
    const assetPath = html.match(/<script[^>]+src=["']([^"']+-[^"'/]+\.js)["']/)?.[1]
    if (!assetPath) throw new Error(`${rendered} index did not name a hashed JavaScript asset`)
    const asset = await fetch(new URL(assetPath, `http://127.0.0.1:${port}/`))
    const contentType = asset.headers.get('content-type') ?? ''
    if (asset.status !== 200 || !contentType.includes('javascript')) {
      throw new Error(
        `${rendered} asset ${assetPath} returned ${asset.status} with ${JSON.stringify(contentType)}`,
      )
    }
    console.log(`$ ${rendered}`)
    console.log(`GET / ${response.status}; GET ${assetPath} ${asset.status} ${contentType}`)
    await smoke(executable, ['hub', 'serve-stop', '--port', String(port)], stateHome)
    const exitCode = await Promise.race([
      child.exited,
      Bun.sleep(5_000).then(() => {
        throw new Error(`${rendered} did not exit after serve-stop`)
      }),
    ])
    if (exitCode !== 0) throw new Error(`${rendered} exited ${exitCode}, expected 0`)
    console.log(`server exit ${exitCode}`)
  } finally {
    child.kill()
    const [serverStdout, serverStderr] = await Promise.all([stdout, stderr])
    if (serverStdout.trim()) console.log(serverStdout.trim())
    if (serverStderr.trim()) console.error(serverStderr.trim())
  }
}

let recordApi: ReturnType<typeof Bun.serve> | null = null
try {
  const output = join(scratch, 'bin')
  const stateHome = join(scratch, 'state')
  securityBin = join(scratch, 'security-bin')
  mkdirSync(securityBin)
  const security = join(securityBin, 'security')
  writeFileSync(security, '#!/bin/sh\nprintf smoke-record-token\n')
  chmodSync(security, 0o755)
  harnessBin = join(scratch, 'harness-bin')
  mcpState = join(scratch, 'mcp-state')
  mcpRecord = join(scratch, 'mcp-argv.log')
  mkdirSync(harnessBin)
  mkdirSync(mcpState)
  const fakeHarness = `#!/bin/sh
harness="\${0##*/}"
smoke_root=$(dirname "$(dirname "$0")")
record="\${SMOKE_MCP_RECORD:-$smoke_root/mcp-argv.log}"
state="\${SMOKE_MCP_STATE:-$smoke_root/mcp-state}"
printf '%s' "$harness" >> "$record"
for arg in "$@"; do printf '\\t%s' "$arg" >> "$record"; done
printf '\\n' >> "$record"
if [ "$1" = "mcp" ] && [ "$2" = "add" ]; then
  shift 2
  if [ "$1" = "--scope" ]; then shift 2; fi
  name="$1"
  shift
  if [ "$1" = "--" ]; then shift; fi
  command="$1"
  shift
  printf '%s\\n' "$command" > "$state/$harness-$name.command"
  printf '%s\\n' "$*" > "$state/$harness-$name.args"
  printf 'added %s\\n' "$name"
  exit 0
fi
if [ "$1" = "mcp" ] && [ "$2" = "get" ]; then
  name="$3"
  if [ ! -f "$state/$harness-$name.command" ]; then
    if [ "$harness" = "codex" ]; then
      printf "Error: No MCP server named '%s' found.\\n" "$name" >&2
    else
      printf 'No MCP server named "%s". Configured servers: probe\\n' "$name" >&2
    fi
    exit 1
  fi
  IFS= read -r command < "$state/$harness-$name.command"
  IFS= read -r args < "$state/$harness-$name.args"
  if [ "$harness" = "codex" ]; then
    printf '{"transport":{"type":"stdio","command":"%s","args":[' "$command"
    separator=''
    for arg in $args; do printf '%s"%s"' "$separator" "$arg"; separator=','; done
    printf ']}}\\n'
  else
    printf 'Command: %s\\nArgs: [' "$command"
    separator=''
    for arg in $args; do printf '%s"%s"' "$separator" "$arg"; separator=','; done
    printf ']\\n'
  fi
  exit 0
fi
if [ "$harness" = "codex" ] && [ "$1" = "exec" ]; then
  output=''
  previous=''
  for arg in "$@"; do
    if [ "$previous" = "-o" ]; then output="$arg"; fi
    previous="$arg"
  done
  printf 'guarded binary commit\n' > binary-smoke.txt
  git add binary-smoke.txt
  git commit -m 'DEV-1091 guarded binary smoke'
  hooks=$(git config --path core.hooksPath)
  printf '%s\n' "$PWD" > "$state/writing-worktree"
  printf '%s\n' "$hooks" > "$state/writing-hooks"
  git branch --show-current > "$state/writing-branch"
  reply='{"status":"done","summary":"The guarded commit completed.","files_changed":["binary-smoke.txt"],"questions":null,"deviations":null,"blockers":null,"tests":null}'
  if [ -n "$output" ]; then printf '%s\n' "$reply" > "$output"; fi
  printf '%s\n' '{"type":"thread.started","thread_id":"binary-smoke-thread"}'
  printf '{"type":"item.completed","item":{"type":"agent_message","text":%s}}\n' "$reply"
  printf '%s\n' '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}'
  exit 0
fi
exit 0
`
  for (const harness of ['claude', 'codex']) {
    const executable = join(harnessBin, harness)
    writeFileSync(executable, fakeHarness)
    chmodSync(executable, 0o755)
  }
  recordApi = Bun.serve({
    port: await freePort(),
    hostname: '127.0.0.1',
    fetch: async (request) => {
      if (request.method !== 'PUT' || new URL(request.url).pathname !== '/v1/projects') {
        return Response.json({ error: 'not found' }, { status: 404 })
      }
      const body = (await request.json()) as { name?: string }
      return Response.json({ name: body.name })
    },
  })
  recordApiUrl = `http://127.0.0.1:${recordApi.port}`
  const binary = await buildHostBinary('v0.1.0', output)
  console.log(`binary size ${statSync(binary).size} bytes`)
  const orch = join(output, 'orch')
  const hub = join(output, 'hub')
  symlinkSync(binary, orch)
  symlinkSync(binary, hub)
  await smoke(binary, ['--version'], stateHome)
  await smoke(binary, ['orch', '--version'], stateHome)
  await smoke(binary, ['hub', '--version'], stateHome)
  await smoke(binary, ['--help'], stateHome)
  await smoke(binary, ['orch', '--help'], stateHome)
  await smoke(binary, ['hub', '--help'], stateHome, `hub — every project's tasks in flight`)
  await smoke(
    binary,
    [...BOTTEGA_ENTRY_PROTOCOL['schema-check'].compiledArguments],
    stateHome,
    'strict schema ok',
  )
  if (existsSync(stateHome))
    throw new Error('help, version, and schema-check commands created the state directory')
  await smoke(orch, ['jobs'], stateHome, 'implement')
  await smoke(binary, ['orch', 'jobs'], stateHome)
  const agentList = await smoke(binary, ['orch', 'agent', 'list'], stateHome)
  for (const builtIn of ['codex', 'grok']) {
    if (!agentList.split('\n').some((line) => line.startsWith(`${builtIn} `))) {
      throw new Error(`orch agent list did not show built-in agent ${builtIn}`)
    }
  }
  await smoke(binary, ['hub', 'task', 'list'], stateHome)
  if (!existsSync(join(stateHome, 'orchestrator', 'orch.db'))) {
    throw new Error('orch jobs did not create the orchestrator store')
  }
  if (!existsSync(join(stateHome, 'hub', 'hub.db'))) {
    throw new Error('hub task list did not create the hub store')
  }
  await smoke(
    binary,
    ['hub', 'task', 'new', '--project', 'tasks', '--title', 'smoke'],
    stateHome,
    'TASK-1',
  )
  await smoke(binary, ['hub', 'task', 'list', '--project', 'tasks'], stateHome, 'TASK-1')
  const setupFacts = JSON.parse(
    await smoke(binary, ['orch', 'setup', 'facts', '--json'], stateHome),
  ) as { os?: unknown }
  if (!setupFacts.os) throw new Error('orch setup facts --json returned no os field')
  const setupRepository = join(scratch, 'setup-repository')
  mkdirSync(setupRepository)
  writeFileSync(join(setupRepository, 'README.md'), 'setup binary smoke\n')
  await run(['git', 'init', '--initial-branch=main'], setupRepository)
  await run(['git', 'config', 'user.email', 'smoke@example.invalid'], setupRepository)
  await run(['git', 'config', 'user.name', 'Binary Smoke'], setupRepository)
  await run(['git', 'add', 'README.md'], setupRepository)
  await run(['git', 'commit', '-m', 'DEV-1015 setup smoke fixture'], setupRepository)
  const setupPlan = JSON.parse(
    await smoke(binary, ['orch', 'setup', 'plan', '--in', setupRepository, '--json'], stateHome),
  ) as { diff?: { kind?: string }[] }
  if (setupPlan.diff?.filter((action) => action.kind === 'add').length !== 1) {
    throw new Error('orch setup plan did not return exactly one add proposal')
  }
  await smoke(binary, ['orch', 'setup', 'apply', '--in', setupRepository, '--yes'], stateHome)
  const mcpInvocations = readFileSync(mcpRecord, 'utf8').split('\n')
  const addInvocations = mcpInvocations.filter((line) => line.includes('\tmcp\tadd\t'))
  if (!addInvocations.some((line) => line.startsWith('claude\t') && line.includes('\torch\t'))) {
    throw new Error('orch setup apply did not register orch with Claude')
  }
  if (!addInvocations.some((line) => line.startsWith('codex\t') && line.includes('\torch\t'))) {
    throw new Error('orch setup apply did not register orch with Codex')
  }
  if (!addInvocations.some((line) => line.startsWith('codex\t') && line.includes('\torch-ask\t'))) {
    throw new Error('orch setup apply did not register orch-ask with Codex')
  }
  if (!addInvocations.every((line) => line.includes(`\t${realpathSync(binary)}\t`))) {
    throw new Error('orch setup apply did not register the compiled binary command')
  }
  const setupProjects = JSON.parse(
    await smoke(binary, ['orch', 'project', 'list', '--json'], stateHome),
  ) as { path?: string; settings?: { keyPrefixes?: string[] } }[]
  const setupProject = setupProjects.find(
    (project) => project.path === realpathSync(setupRepository),
  )
  if (!setupProject?.settings?.keyPrefixes?.length) {
    throw new Error('orch setup apply did not register a key prefix')
  }
  const secondSetupPlan = JSON.parse(
    await smoke(binary, ['orch', 'setup', 'plan', '--in', setupRepository, '--json'], stateHome),
  ) as { questions?: unknown[] }
  if (secondSetupPlan.questions?.length !== 0) {
    throw new Error('second orch setup plan returned questions for a configured project')
  }
  const secondSetup = JSON.parse(
    await smoke(
      binary,
      ['orch', 'setup', 'apply', '--in', setupRepository, '--yes', '--json'],
      stateHome,
    ),
  ) as { actions?: { status?: string }[] }
  if (
    !secondSetup.actions?.length ||
    secondSetup.actions.some((action) => action.status !== 'unchanged')
  ) {
    throw new Error('second orch setup apply did not report unchanged')
  }
  const orchestrator = new Database(join(stateHome, 'orchestrator', 'orch.db'), {
    readonly: true,
  })
  try {
    const seen = orchestrator
      .query('SELECT 1 FROM session_seen WHERE session_id = ?')
      .get('DEV-997-binary-smoke')
    if (!seen) throw new Error('orch jobs did not stamp the invoking session')
  } finally {
    orchestrator.close()
  }
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
  const probeRepository = join(scratch, 'probe-repository')
  mkdirSync(probeRepository)
  writeFileSync(join(probeRepository, 'README.md'), 'binary sandbox smoke\n')
  await run(['git', 'init', '--initial-branch=main'], probeRepository)
  await run(['git', 'config', 'user.email', 'smoke@example.invalid'], probeRepository)
  await run(['git', 'config', 'user.name', 'Binary Smoke'], probeRepository)
  await run(['git', 'add', 'README.md'], probeRepository)
  await run(['git', 'commit', '-m', 'DEV-997 binary smoke fixture'], probeRepository)
  const smokeStore = new Database(join(stateHome, 'orchestrator', 'orch.db'))
  try {
    smokeStore
      .query('INSERT INTO project (name, path, stack, canon, settings) VALUES (?, ?, ?, 0, ?)')
      .run('binary-smoke', realpathSync(probeRepository), 'fixture', '{}')
    const codexCaps = JSON.parse(
      (smokeStore.query('SELECT caps FROM agent WHERE name = ?').get('codex') as { caps: string })
        .caps,
    ) as Record<string, unknown>
    smokeStore
      .query('UPDATE agent SET caps = ?, probed_at = ?, probe_result = ? WHERE name = ?')
      .run(
        JSON.stringify({ ...codexCaps, replyFile: true }),
        new Date().toISOString(),
        '{"ok":true,"source":"compiled binary smoke fixture"}',
        'codex',
      )
  } finally {
    smokeStore.close()
  }
  await smoke(
    binary,
    ['orch', 'workflow', 'probe', '--', 'git', 'status', '--short'],
    stateHome,
    undefined,
    0,
    probeRepository,
  )
  await smoke(
    binary,
    [
      'orch',
      'do',
      'implement',
      '--agent',
      'codex',
      '--base',
      'main',
      '--follow',
      '--cwd',
      probeRepository,
      'Make the binary smoke fixture commit.',
    ],
    stateHome,
    undefined,
    0,
    probeRepository,
  )
  const writingWorktree = readFileSync(join(mcpState, 'writing-worktree'), 'utf8').trim()
  const writingHooks = resolve(readFileSync(join(mcpState, 'writing-hooks'), 'utf8').trim())
  if (writingHooks.startsWith(`${resolve(writingWorktree)}/`)) {
    throw new Error(`shared ref guard was installed inside writing worktree ${writingWorktree}`)
  }
  const writingBranch = readFileSync(join(mcpState, 'writing-branch'), 'utf8').trim()
  const guardedSubject = await run(
    ['git', 'log', '-1', '--format=%s', writingBranch],
    probeRepository,
  )
  if (guardedSubject !== 'DEV-1091 guarded binary smoke') {
    throw new Error(`guarded binary commit was not created: ${guardedSubject}`)
  }
  const extractedRuntime = join(stateHome, 'runtime', '0.1.0', 'sandbox-runtime')
  if (!existsSync(extractedRuntime)) {
    throw new Error(`sandbox workflow probe did not extract ${extractedRuntime}`)
  }
  console.log(`sandboxed workflow probe extracted ${extractedRuntime}`)
  await smokeDashboard(binary, stateHome)
} finally {
  recordApi?.stop(true)
  rmSync(scratch, { recursive: true, force: true })
}
