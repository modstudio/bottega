import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { chmod } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PLATFORM_NAME, PLATFORM_SLUG } from '../shared/brand.ts'
import { DIST_MANIFEST, type DistributionManifest } from '../shared/install-root.ts'
import { resolveStateRoot } from '../shared/state-directory.ts'

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))

export const DECLARED_PAYLOAD_PATHS = [
  'orchestrator/src/cli/orch.ts',
  'hub/src/cli.ts',
  'orchestrator/src/run/exec.ts',
  'retrieval/src/search-cli.ts',
  'orchestrator/migrations',
  'hub/migrations',
  'orchestrator/hooks',
  'hub/web/dist',
  'ops/install.sh',
  'ops/bin',
  'ops/launchd',
  'hub/bin',
  'hub/launchd',
  'shared/install-root.ts',
  'shared/state-directory.ts',
  'shared/config-directory.ts',
  'shared/machine-config.ts',
  'shared/env-source.ts',
  'shared/attribution-markers.json',
  DIST_MANIFEST,
  'bin/orch',
  'bin/hub',
  'bin/retrieval-search',
] as const

export function releaseVersion(tag: string): string {
  if (!/^v[0-9A-Za-z][0-9A-Za-z.-]*$/.test(tag)) {
    throw new Error(`release tag must match v*: received ${JSON.stringify(tag)}`)
  }
  return tag.slice(1)
}

export function distributionManifest(
  version: string,
  built: string,
  commit: string,
): DistributionManifest {
  return { name: PLATFORM_NAME, version, built, commit }
}

export async function run(
  argv: string[],
  cwd = repositoryRoot,
  stdinPath?: string,
): Promise<string> {
  const child = Bun.spawn(argv, {
    cwd,
    stdout: 'pipe',
    stderr: 'inherit',
    ...(stdinPath ? { stdin: Bun.file(stdinPath) } : {}),
  })
  const output = await new Response(child.stdout).text()
  const exitCode = await child.exited
  if (exitCode !== 0) throw new Error(`${argv.join(' ')} exited ${exitCode}`)
  return output.trim()
}

async function bundle(source: string, destination: string): Promise<void> {
  mkdirSync(join(destination, '..'), { recursive: true })
  await run(['bun', 'build', '--target=bun', '--outfile', destination, source])
}

function copyDirectory(source: string, destination: string): void {
  mkdirSync(join(destination, '..'), { recursive: true })
  cpSync(source, destination, { recursive: true, preserveTimestamps: true })
}

function copyFile(source: string, destination: string): void {
  mkdirSync(join(destination, '..'), { recursive: true })
  cpSync(source, destination, { preserveTimestamps: true })
}

function shim(entrypoint: string): string {
  return `#!/bin/sh
script=$0
while [ -L "$script" ]; do
  link=$(readlink "$script")
  case "$link" in
    /*) script=$link ;;
    *) script=$(dirname "$script")/$link ;;
  esac
done
root=$(CDPATH= cd "$(dirname "$script")/.." && pwd)
exec bun --no-env-file "$root/${entrypoint}" "$@"
`
}

export async function buildRelease(tag: string): Promise<string> {
  const version = releaseVersion(tag)
  const outputDirectory = join(resolveStateRoot(process.env), 'build')
  const payloadName = `${PLATFORM_SLUG}-${version}`
  const payloadRoot = join(outputDirectory, payloadName)
  const archive = join(outputDirectory, `${payloadName}.tar.gz`)

  mkdirSync(outputDirectory, { recursive: true })
  rmSync(payloadRoot, { recursive: true, force: true })
  rmSync(archive, { force: true })

  await run(['bun', 'run', 'build'], join(repositoryRoot, 'hub/web'))
  await bundle('orchestrator/src/cli/orch.ts', join(payloadRoot, 'orchestrator/src/cli/orch.ts'))
  await bundle('hub/src/cli.ts', join(payloadRoot, 'hub/src/cli.ts'))
  await bundle('orchestrator/src/run/exec.ts', join(payloadRoot, 'orchestrator/src/run/exec.ts'))
  await bundle('retrieval/src/search-cli.ts', join(payloadRoot, 'retrieval/src/search-cli.ts'))

  copyDirectory('orchestrator/migrations', join(payloadRoot, 'orchestrator/migrations'))
  copyDirectory('hub/migrations', join(payloadRoot, 'hub/migrations'))
  copyDirectory('orchestrator/hooks', join(payloadRoot, 'orchestrator/hooks'))
  copyDirectory('hub/web/dist', join(payloadRoot, 'hub/web/dist'))
  copyDirectory('ops/bin', join(payloadRoot, 'ops/bin'))
  copyDirectory('ops/launchd', join(payloadRoot, 'ops/launchd'))
  copyFile('ops/install.sh', join(payloadRoot, 'ops/install.sh'))
  copyDirectory('hub/bin', join(payloadRoot, 'hub/bin'))
  copyDirectory('hub/launchd', join(payloadRoot, 'hub/launchd'))

  for (const source of [
    'shared/install-root.ts',
    'shared/state-directory.ts',
    'shared/config-directory.ts',
    'shared/machine-config.ts',
    'shared/env-source.ts',
  ]) {
    await bundle(source, join(payloadRoot, source))
  }
  copyFile('shared/attribution-markers.json', join(payloadRoot, 'shared/attribution-markers.json'))

  const commit = await run(['git', 'rev-parse', 'HEAD'])
  const built = await run(['git', 'show', '-s', '--format=%cI', 'HEAD'])
  writeFileSync(
    join(payloadRoot, DIST_MANIFEST),
    `${JSON.stringify(distributionManifest(version, built, commit), null, 2)}\n`,
  )

  for (const [name, entrypoint] of [
    ['orch', 'orchestrator/src/cli/orch.ts'],
    ['hub', 'hub/src/cli.ts'],
    ['retrieval-search', 'retrieval/src/search-cli.ts'],
  ] as const) {
    const path = join(payloadRoot, 'bin', name)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, shim(entrypoint))
    await chmod(path, 0o755)
  }

  await run(['tar', '-czf', archive, basename(payloadRoot)], outputDirectory)
  rmSync(payloadRoot, { recursive: true, force: true })
  return archive
}

if (import.meta.main) {
  const tag = process.argv[2]
  if (!tag || process.argv.length !== 3) {
    throw new Error('working form: bun run release:build -- v<version>')
  }
  console.log(await buildRelease(tag))
}
