import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { startBounded } from '../shared/bounded-process.ts'
import { MCP_SERVER_NAME, PLATFORM_SLUG, WORKER_MCP_SERVER_NAME } from '../shared/brand.ts'
import { parseBinaryTarget } from './build-binary.ts'
import { buildReleaseArtifact, writeChecksumSet } from './build-release-artifacts.ts'
import { releaseVersion, stripInheritedOverrides } from './release-support.ts'

type InstallProofPaths = {
  home: string
  state: string
  bin: string
  stub: string
  mirror: string
}

type StepResult = {
  name: string
  exitCode: number
  output: string
  stderr: string
}

const GROK_INSTALLER_URL = 'https://x.ai/cli/install.sh'

export type HarnessInstallerInvocationCounts = {
  brewCodex: number
  curlGrok: number
}

function invocationLines(log: string): string[] {
  return log
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

export function harnessInstallerInvocationCounts(
  brewLog: string,
  curlLog: string,
): HarnessInstallerInvocationCounts {
  return {
    brewCodex: invocationLines(brewLog).filter((line) => line === 'install --cask codex').length,
    curlGrok: invocationLines(curlLog).filter((line) => line === `-fsSL ${GROK_INSTALLER_URL}`)
      .length,
  }
}

export function releaseDownloadsReachedCurl(
  curlLog: string,
  releaseUrl: string,
  archiveName: string,
): boolean {
  const lines = invocationLines(curlLog)
  return [`${releaseUrl}/SHA256SUMS`, `${releaseUrl}/${archiveName}`].every((url) =>
    lines.some((line) => line.startsWith(`-fsSL ${url} -o `)),
  )
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

export function renderedHookCommand(settings: unknown, script: string): string | null {
  const hooks = object(object(settings)?.hooks)
  const groups = hooks ? Object.values(hooks).flatMap(array) : []
  return (
    groups
      .flatMap((group) => array(object(group)?.hooks))
      .map((handler) => object(handler)?.command)
      .find(
        (command): command is string =>
          typeof command === 'string' && command.includes(`/orchestrator/hooks/${script}`),
      ) ?? null
  )
}

export function releaseInstallEnvironment(
  inherited: Record<string, string | undefined>,
  paths: InstallProofPaths,
): Record<string, string | undefined> {
  const env = { ...inherited }
  stripInheritedOverrides(env)
  env.HOME = paths.home
  env.BOTTEGA_STATE_HOME = paths.state
  env.BOTTEGA_INSTALL_DIR = paths.bin
  env.BOTTEGA_KEYSTORE = 'file'
  env.BOTTEGA_DOWNLOAD_BASE_URL = `file://${paths.mirror}`
  env.CODEX_HOME = join(paths.home, '.codex')
  env.PATH = `${paths.stub}:${join(paths.home, '.grok', 'bin')}:${paths.bin}:/usr/bin:/bin:/usr/sbin:/sbin`
  return env
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

function launchctlStub(stateFile: string, logFile: string): string {
  const state = shellQuote(stateFile)
  const log = shellQuote(logFile)
  return `#!/bin/sh
state=${state}
log=${log}
touch "$state"
printf '%s\\n' "$*" >> "$log"
verb=\${1:-}
shift || true
case "$verb" in
  print)
    case "\${1:-}" in
      gui/*/*)
        label=\${1##*/}
        if grep -Fqx "$label" "$state"; then
          printf '%s\\n' 'state = running'
          exit 0
        fi
        exit 113
        ;;
    esac
    ;;
  bootstrap)
    plist=\${2:-}
    label=\${plist##*/}
    label=\${label%.plist}
    grep -Fqx "$label" "$state" || printf '%s\\n' "$label" >> "$state"
    ;;
  bootout)
    if [ "$#" -eq 1 ]; then
      label=\${1##*/}
    else
      plist=\${2:-}
      label=\${plist##*/}
      label=\${label%.plist}
    fi
    grep -Fvx "$label" "$state" > "$state.tmp" || true
    mv "$state.tmp" "$state"
    ;;
esac
exit 0
`
}

function brewStub(codexPath: string, logFile: string): string {
  const codex = shellQuote(codexPath)
  const log = shellQuote(logFile)
  return `#!/bin/sh
printf '%s\\n' "$*" >> ${log}
if [ "$#" -eq 3 ] && [ "$1" = 'install' ] && [ "$2" = '--cask' ] && [ "$3" = 'codex' ]; then
  cat > ${codex} <<'BOTTEGA_CODEX_STUB'
#!/bin/sh
state="$HOME/.${PLATFORM_SLUG}-proof-codex-mcp"
mkdir -p "$state"
if [ "\${1:-}" = '--version' ]; then
  printf '%s\n' 'codex-cli 0.0.0'
  exit 0
fi
if [ "\${1:-}" = 'login' ] && [ "\${2:-}" = 'status' ]; then
  exit 0
fi
if [ "\${1:-}" = 'mcp' ] && [ "\${2:-}" = 'get' ] && [ "\${4:-}" = '--json' ]; then
  file="$state/$3.json"
  if [ ! -f "$file" ]; then
    printf "Error: No MCP server named '%s' found.\n" "$3" >&2
    exit 1
  fi
  cat "$file"
  exit 0
fi
if [ "\${1:-}" = 'mcp' ] && [ "\${2:-}" = 'add' ] && [ "\${4:-}" = '--' ] && [ "$#" -eq 7 ]; then
  printf '{"transport":{"type":"stdio","command":"%s","args":["%s","%s"]}}\n' "$5" "$6" "$7" > "$state/$3.json"
  exit 0
fi
if [ "\${1:-}" = 'mcp' ] && [ "\${2:-}" = 'remove' ] && [ "$#" -eq 3 ]; then
  rm -f "$state/$3.json"
  exit 0
fi
printf 'unsupported codex stub call: %s\n' "$*" >&2
exit 64
BOTTEGA_CODEX_STUB
  chmod 755 ${codex}
  exit 0
fi
printf 'unsupported brew call: %s\n' "$*" >&2
exit 64
`
}

function curlStub(logFile: string): string {
  const log = shellQuote(logFile)
  return `#!/bin/sh
printf '%s\\n' "$*" >> ${log}
if [ "$#" -eq 2 ] && [ "$1" = '-fsSL' ] && [ "$2" = '${GROK_INSTALLER_URL}' ]; then
  cat <<'BOTTEGA_GROK_INSTALLER'
#!/bin/sh
set -eu
mkdir -p "$HOME/.grok/bin"
cat > "$HOME/.grok/bin/grok" <<'BOTTEGA_GROK_STUB'
#!/bin/sh
state="$HOME/.${PLATFORM_SLUG}-proof-grok-mcp"
mkdir -p "$state"
if [ "\${1:-}" = '--version' ]; then
  printf '%s\n' 'grok 0.0.0'
  exit 0
fi
if [ "\${1:-}" = 'mcp' ] && [ "\${2:-}" = 'list' ] && [ "\${3:-}" = '--json' ]; then
  printf '['
  separator=
  for name in ${MCP_SERVER_NAME} ${WORKER_MCP_SERVER_NAME}; do
    file="$state/$name.json"
    if [ -f "$file" ]; then
      printf '%s' "$separator"
      cat "$file"
      separator=,
    fi
  done
  printf ']\n'
  exit 0
fi
if [ "\${1:-}" = 'mcp' ] && [ "\${2:-}" = 'add' ] && [ "\${3:-}" = '--scope' ] && [ "\${4:-}" = 'user' ] && [ "\${6:-}" = '--' ] && [ "$#" -eq 9 ]; then
  printf '{"name":"%s","command":"%s","args":["%s","%s"]}\n' "$5" "$7" "$8" "$9" > "$state/$5.json"
  exit 0
fi
if [ "\${1:-}" = 'mcp' ] && [ "\${2:-}" = 'remove' ] && [ "\${3:-}" = '--scope' ] && [ "\${4:-}" = 'user' ] && [ "$#" -eq 5 ]; then
  rm -f "$state/$5.json"
  exit 0
fi
printf 'unsupported grok stub call: %s\n' "$*" >&2
exit 64
BOTTEGA_GROK_STUB
chmod 755 "$HOME/.grok/bin/grok"
BOTTEGA_GROK_INSTALLER
  exit 0
fi
exec /usr/bin/curl "$@"
`
}

async function runStep(
  name: string,
  argv: string[],
  cwd: string,
  env: Record<string, string | undefined>,
  stdin?: string,
): Promise<StepResult> {
  const result = await startBounded(argv, { budget: 'self-cli', cwd, env, stdin })
  return {
    name,
    exitCode: result.exitCode,
    output: [result.stdout, result.stderr].filter(Boolean).join('\n'),
    stderr: result.stderr,
  }
}

function readProofLog(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

function recordProofAssertion(failures: string[], condition: boolean, message: string): void {
  if (!condition) failures.push(message)
}

function assertFirstSetupInstallerCalls(
  failures: string[],
  counts: HarnessInstallerInvocationCounts,
): void {
  recordProofAssertion(
    failures,
    counts.brewCodex === 1,
    `first setup apply expected one brew install --cask codex call, saw ${counts.brewCodex}`,
  )
  recordProofAssertion(
    failures,
    counts.curlGrok === 1,
    `first setup apply expected one ${GROK_INSTALLER_URL} request, saw ${counts.curlGrok}`,
  )
}

function assertSecondSetupSkipsInstallerCalls(
  failures: string[],
  first: HarnessInstallerInvocationCounts,
  second: HarnessInstallerInvocationCounts,
): void {
  recordProofAssertion(
    failures,
    second.brewCodex === first.brewCodex,
    'second setup apply re-ran brew even though codex was already installed',
  )
  recordProofAssertion(
    failures,
    second.curlGrok === first.curlGrok,
    'second setup apply re-requested the grok installer even though grok was already installed',
  )
}

async function runExtractedHookProof(
  version: string,
  paths: InstallProofPaths,
  executable: string,
  env: Record<string, string | undefined>,
  failures: string[],
  rendered: boolean,
): Promise<StepResult> {
  const runtimeRoot = join(paths.state, 'runtime', version, 'assets')
  recordProofAssertion(
    failures,
    existsSync(runtimeRoot),
    `setup apply did not extract the runtime tree at ${runtimeRoot}`,
  )
  const settingsPath = join(paths.home, '.claude', 'settings.json')
  if (rendered && !existsSync(settingsPath)) {
    return {
      name: 'extracted hook',
      exitCode: 1,
      output: `settings apply did not render ${settingsPath}`,
      stderr: '',
    }
  }
  const hook = join(runtimeRoot, 'orchestrator', 'hooks', 'test-substance-guard.py')
  const command = rendered
    ? renderedHookCommand(
        JSON.parse(readFileSync(settingsPath, 'utf8')) as unknown,
        'test-substance-guard.py',
      )
    : `BOTTEGA_BIN=${shellQuote(executable)} python3 ${shellQuote(hook)}`
  if (command === null) {
    return {
      name: 'extracted hook',
      exitCode: 1,
      output: `setup apply did not render test-substance-guard.py in ${settingsPath}`,
      stderr: '',
    }
  }
  const result = await runStep(
    'extracted hook',
    ['sh', '-c', command],
    paths.home,
    env,
    JSON.stringify({
      tool_name: 'Write',
      cwd: paths.home,
      tool_input: {
        file_path: join(paths.home, 'example.test.ts'),
        content: "test('release hook', () => expect(1).toBe(1))\n",
      },
    }),
  )
  recordProofAssertion(
    failures,
    !result.stderr.includes('could not start') && !result.stderr.includes('timed out'),
    `extracted hook judge did not start or timed out: ${result.stderr.trim()}`,
  )
  return result
}

async function prepareReleaseProof(
  version: string,
  root: string,
  paths: InstallProofPaths,
): Promise<{ archive: string; releaseDirectory: string }> {
  const releaseDirectory = join(paths.mirror, 'download', `v${version}`)
  mkdirSync(releaseDirectory, { recursive: true })
  const target = parseBinaryTarget(`darwin-${process.arch}`)
  const archive = await buildReleaseArtifact(`v${version}`, releaseDirectory, target)
  writeChecksumSet(releaseDirectory, [archive])
  for (const directory of [paths.home, paths.state, paths.bin, paths.stub]) {
    mkdirSync(directory, { recursive: true })
  }
  const stubs = [
    {
      path: join(paths.stub, 'launchctl'),
      text: launchctlStub(join(root, 'launchctl-state'), join(root, 'launchctl.log')),
    },
    {
      path: join(paths.stub, 'brew'),
      text: brewStub(join(paths.stub, 'codex'), join(root, 'brew.log')),
    },
    { path: join(paths.stub, 'curl'), text: curlStub(join(root, 'curl.log')) },
  ]
  for (const stub of stubs) {
    writeFileSync(stub.path, stub.text)
    chmodSync(stub.path, 0o755)
  }
  return { archive, releaseDirectory }
}

async function seedProofSettings(
  paths: InstallProofPaths,
  executable: string,
  env: Record<string, string | undefined>,
): Promise<{ results: StepResult[]; seeded: boolean }> {
  mkdirSync(join(paths.home, '.claude'), { recursive: true })
  writeFileSync(join(paths.home, '.claude', 'settings.json'), '{}\n')
  const settingsImport = await runStep(
    'settings import',
    [executable, 'machine', 'settings', 'import', '--user'],
    paths.home,
    env,
  )
  const canonSet = await runStep(
    'canon set',
    [
      executable,
      'doc',
      'set',
      'AGENTS.md',
      '--scope',
      'canon',
      '--user',
      '--title',
      'Release proof canon',
      '--reason',
      'seed release install proof',
    ],
    paths.home,
    env,
    'Release proof canon.\n',
  )
  const results = [settingsImport, canonSet]
  const seeded = results.every((result) => result.exitCode === 0)
  if (seeded) {
    results.push(
      await runStep(
        'settings apply',
        [executable, 'machine', 'settings', 'apply'],
        paths.home,
        env,
      ),
    )
  }
  return { results, seeded }
}

function reportProof(results: StepResult[], assertionFailures: string[]): number {
  for (const result of results) {
    console.log(`${result.name} exit ${result.exitCode}`)
    if ((result.exitCode !== 0 || result.name === 'extracted hook') && result.output) {
      console.log(result.output)
    }
  }
  for (const failure of assertionFailures) console.error(`proof assertion failed: ${failure}`)
  return results.some((result) => result.exitCode !== 0) || assertionFailures.length ? 1 : 0
}

async function proveReleaseInstall(version: string, keep: boolean): Promise<number> {
  if (process.platform !== 'darwin') {
    console.error('release install proof requires darwin')
    return 1
  }

  const root = mkdtempSync(join(tmpdir(), `${PLATFORM_SLUG}-release-install-`))
  const paths: InstallProofPaths = {
    home: join(root, 'home'),
    state: join(root, 'state'),
    bin: join(root, 'bin'),
    stub: join(root, 'stub'),
    mirror: join(root, 'mirror'),
  }
  try {
    const { archive, releaseDirectory } = await prepareReleaseProof(version, root, paths)
    const env = releaseInstallEnvironment(process.env, paths)
    const repositoryRoot = resolve(import.meta.dir, '..')
    const executable = join(paths.bin, PLATFORM_SLUG)
    const setupArgv = [executable, 'machine', 'setup', 'apply', '--yes', '--level', 'full']
    const curlLog = join(root, 'curl.log')
    const brewLog = join(root, 'brew.log')
    const assertionFailures: string[] = []
    const results: StepResult[] = []
    results.push(
      await runStep(
        'install',
        ['sh', join(repositoryRoot, 'install.sh'), `v${version}`],
        paths.home,
        env,
      ),
    )
    recordProofAssertion(
      assertionFailures,
      releaseDownloadsReachedCurl(
        readProofLog(curlLog),
        `file://${releaseDirectory}`,
        basename(archive),
      ),
      'install.sh release downloads did not both pass through the real curl path',
    )

    results.push(await runStep('setup apply', setupArgv, paths.home, env))
    const seededSettings = await seedProofSettings(paths, executable, env)
    results.push(...seededSettings.results)
    results.push(
      await runExtractedHookProof(
        version,
        paths,
        executable,
        env,
        assertionFailures,
        seededSettings.seeded,
      ),
    )
    const firstInstallerCounts = harnessInstallerInvocationCounts(
      readProofLog(brewLog),
      readProofLog(curlLog),
    )
    assertFirstSetupInstallerCalls(assertionFailures, firstInstallerCounts)

    results.push(await runStep('doctor', [executable, 'machine', 'doctor'], paths.home, env))
    results.push(await runStep('setup apply (second)', setupArgv, paths.home, env))
    const secondInstallerCounts = harnessInstallerInvocationCounts(
      readProofLog(brewLog),
      readProofLog(curlLog),
    )
    assertSecondSetupSkipsInstallerCalls(
      assertionFailures,
      firstInstallerCounts,
      secondInstallerCounts,
    )
    results.push(
      await runStep('doctor (second)', [executable, 'machine', 'doctor'], paths.home, env),
    )
    return reportProof(results, assertionFailures)
  } finally {
    if (keep) console.log(`kept release install proof at ${root}`)
    else rmSync(root, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const usage = 'usage: bun scripts/smoke-release-install.ts <version> [--keep]'
  if (args.length < 1 || args.length > 2 || (args.length === 2 && args[1] !== '--keep')) {
    console.error(usage)
    process.exitCode = 1
  } else {
    const version = releaseVersion(args[0]!)
    process.exitCode = await proveReleaseInstall(version, args.includes('--keep'))
  }
}
