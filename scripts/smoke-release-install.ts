import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
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

function brewStub(codexPath: string): string {
  const codex = shellQuote(codexPath)
  return `#!/bin/sh
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

function curlStub(): string {
  return `#!/bin/sh
if [ "$#" -eq 2 ] && [ "$1" = '-fsSL' ] && [ "$2" = 'https://x.ai/cli/install.sh' ]; then
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
): Promise<StepResult> {
  const result = await startBounded(argv, { budget: 'self-cli', cwd, env })
  return {
    name,
    exitCode: result.exitCode,
    output: [result.stdout, result.stderr].filter(Boolean).join('\n'),
  }
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
      { path: join(paths.stub, 'brew'), text: brewStub(join(paths.stub, 'codex')) },
      { path: join(paths.stub, 'curl'), text: curlStub() },
    ]
    for (const stub of stubs) {
      writeFileSync(stub.path, stub.text)
      chmodSync(stub.path, 0o755)
    }

    const env = releaseInstallEnvironment(process.env, paths)
    const repositoryRoot = resolve(import.meta.dir, '..')
    const executable = join(paths.bin, PLATFORM_SLUG)
    const steps = [
      ['install', ['sh', join(repositoryRoot, 'install.sh'), `v${version}`]],
      ['setup apply', [executable, 'machine', 'setup', 'apply', '--yes', '--level', 'full']],
      ['doctor', [executable, 'machine', 'doctor']],
      [
        'setup apply (second)',
        [executable, 'machine', 'setup', 'apply', '--yes', '--level', 'full'],
      ],
      ['doctor (second)', [executable, 'machine', 'doctor']],
    ] as const
    const results: StepResult[] = []
    for (const [name, argv] of steps) {
      results.push(await runStep(name, [...argv], paths.home, env))
    }
    for (const result of results) {
      console.log(`${result.name} exit ${result.exitCode}`)
      if (result.exitCode !== 0 && result.output) console.log(result.output)
    }
    return results.some((result) => result.exitCode !== 0) ? 1 : 0
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
