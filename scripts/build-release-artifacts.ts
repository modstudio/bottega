import { createHash } from 'node:crypto'
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { PLATFORM_SLUG } from '../shared/brand.ts'
import { BINARY_TARGETS, buildBinary } from './build-binary.ts'
import { releaseVersion, run } from './build-release.ts'
import { RELEASE_BUN_VERSION, requireReleaseBun } from './release-config.ts'

const repositoryRoot = resolve(import.meta.dir, '..')

export type ReleaseManifest = {
  version: string
  commit: string
  bunVersion: string
  artifacts: string[]
}

type CommandResult = { exitCode: number; stdout: string }
export type ArtifactPorts = {
  git(argv: string[]): Promise<CommandResult>
}

async function command(argv: string[]): Promise<CommandResult> {
  const child = Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (stderr.trim()) console.error(stderr.trim())
  return { exitCode, stdout: stdout.trim() }
}

const productionPorts: ArtifactPorts = {
  git: (argv) => command(['git', ...argv]),
}

export function artifactName(version: string, target: string): string {
  return `${PLATFORM_SLUG}-${version}-${target}.tar.gz`
}

export function sha256Line(filename: string, bytes: Uint8Array): string {
  return `${createHash('sha256').update(bytes).digest('hex')}  ${filename}`
}

export async function buildReleaseArtifact(
  tag: string,
  outputDirectory: string,
  target: (typeof BINARY_TARGETS)[number],
): Promise<string> {
  const version = releaseVersion(tag)
  const output = resolve(outputDirectory)
  mkdirSync(output, { recursive: true })
  const stage = mkdtempSync(join(tmpdir(), `${PLATFORM_SLUG}-artifact-`))
  try {
    await buildBinary(tag, stage, target)
    copyFileSync(join(repositoryRoot, 'LICENSE'), join(stage, 'LICENSE'))
    const filename = artifactName(version, target)
    const archive = join(output, filename)
    rmSync(archive, { force: true })
    await run(['tar', '-czf', archive, PLATFORM_SLUG, 'LICENSE'], stage)
    console.log(`${filename} ${statSync(archive).size} bytes`)
    return archive
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
}

export function writeChecksumSet(outputDirectory: string, artifacts: string[]): string {
  const output = resolve(outputDirectory)
  const sums = artifacts.map((path) => sha256Line(basename(path), readFileSync(path)))
  const destination = join(output, 'SHA256SUMS')
  writeFileSync(destination, `${sums.join('\n')}\n`)
  return destination
}

export function writeReleaseManifest(outputDirectory: string, manifest: ReleaseManifest): string {
  const destination = join(resolve(outputDirectory), 'release-manifest.json')
  writeFileSync(destination, `${JSON.stringify(manifest, null, 2)}\n`)
  return destination
}

export async function buildReleaseArtifacts(
  tag: string,
  outputDirectory: string,
  ports: ArtifactPorts = productionPorts,
): Promise<string[]> {
  requireReleaseBun()
  const version = releaseVersion(tag)
  const dirty = await ports.git(['status', '--porcelain'])
  if (dirty.exitCode !== 0) throw new Error('could not establish whether the working tree is clean')
  if (dirty.stdout) throw new Error('refusing to build release artifacts from a dirty working tree')
  const head = await ports.git(['rev-parse', 'HEAD'])
  if (head.exitCode !== 0 || !/^[0-9a-f]{40}$/.test(head.stdout)) {
    throw new Error('could not resolve the release artifact commit')
  }
  const output = resolve(outputDirectory)
  mkdirSync(output, { recursive: true })
  const artifacts: string[] = []
  for (const target of BINARY_TARGETS) {
    artifacts.push(await buildReleaseArtifact(tag, output, target))
  }
  writeChecksumSet(output, artifacts)
  writeReleaseManifest(output, {
    version,
    commit: head.stdout,
    bunVersion: RELEASE_BUN_VERSION,
    artifacts: artifacts.map((path) => basename(path)),
  })
  return artifacts
}

if (import.meta.main) {
  const [tag, outputDirectory] = process.argv.slice(2)
  if (!tag || !outputDirectory || process.argv.length !== 4) {
    throw new Error('working form: bun run release:artifacts -- v<version> <out-dir>')
  }
  await buildReleaseArtifacts(tag, outputDirectory)
}
