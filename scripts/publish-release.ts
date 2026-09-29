import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { PLATFORM_SLUG } from '../shared/brand.ts'
import { BINARY_TARGETS } from './build-binary.ts'
import { releaseVersion } from './build-release.ts'
import { artifactName, type ReleaseManifest } from './build-release-artifacts.ts'
import { RELEASE_BUN_VERSION } from './release-config.ts'

type CommandResult = { exitCode: number; stdout: string }
export type PublishPorts = {
  git(argv: string[]): Promise<CommandResult>
  gh(argv: string[]): Promise<CommandResult>
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

const productionPorts: PublishPorts = {
  git: (argv) => command(['git', ...argv]),
  gh: (argv) => command(['gh', ...argv]),
}

function verifySha256Sums(outputDirectory: string, expectedNames: string[]): void {
  const sumsPath = join(outputDirectory, 'SHA256SUMS')
  if (!existsSync(sumsPath)) throw new Error(`missing ${sumsPath}`)
  const entries = new Map<string, string>()
  for (const line of readFileSync(sumsPath, 'utf8').trimEnd().split('\n')) {
    const match = /^([0-9a-f]{64}) {2}([^/]+)$/.exec(line)
    if (!match) throw new Error(`invalid SHA256SUMS line: ${JSON.stringify(line)}`)
    entries.set(match[2], match[1])
  }
  for (const name of expectedNames) {
    const expected = entries.get(name)
    if (!expected) throw new Error(`SHA256SUMS has no entry for ${name}`)
    const path = join(outputDirectory, name)
    if (!existsSync(path)) throw new Error(`missing release artifact ${path}`)
    const actual = createHash('sha256').update(readFileSync(path)).digest('hex')
    if (actual !== expected)
      throw new Error(`SHA-256 mismatch for ${name}: expected ${expected}, received ${actual}`)
  }
  if (entries.size !== expectedNames.length)
    throw new Error('SHA256SUMS contains unexpected entries')
}

function readReleaseManifest(outputDirectory: string): ReleaseManifest {
  const path = join(outputDirectory, 'release-manifest.json')
  if (!existsSync(path)) throw new Error(`missing ${path}`)
  let value: unknown
  try {
    value = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    throw new Error(`invalid release manifest ${path}`)
  }
  if (
    !value ||
    typeof value !== 'object' ||
    typeof (value as ReleaseManifest).version !== 'string' ||
    !/^[0-9a-f]{40}$/.test((value as ReleaseManifest).commit) ||
    typeof (value as ReleaseManifest).bunVersion !== 'string' ||
    !Array.isArray((value as ReleaseManifest).artifacts) ||
    !(value as ReleaseManifest).artifacts.every((name) => typeof name === 'string')
  ) {
    throw new Error(`invalid release manifest ${path}`)
  }
  return value as ReleaseManifest
}

function remoteTagCommit(tag: string, output: string): string {
  const directRef = `refs/tags/${tag}`
  const peeledRef = `${directRef}^{}`
  let direct: string | undefined
  let peeled: string | undefined
  for (const line of output.split('\n')) {
    const match = /^([0-9a-f]{40})\s+(refs\/tags\/[^\s]+)$/.exec(line)
    if (!match) continue
    if (match[2] === directRef) direct = match[1]
    if (match[2] === peeledRef) peeled = match[1]
  }
  const commit = peeled ?? direct
  if (!commit) throw new Error(`could not resolve tag ${tag} on origin`)
  return commit
}

export async function publishRelease(
  tag: string,
  outputDirectory: string,
  confirmed: boolean,
  ports: PublishPorts = productionPorts,
): Promise<void> {
  const version = releaseVersion(tag)
  const output = resolve(outputDirectory)
  const names = BINARY_TARGETS.map((target) => artifactName(version, target))
  const upload = [...names, 'SHA256SUMS', 'release-manifest.json']
  if (!confirmed) {
    throw new Error(`confirmation required; would upload for ${tag}: ${upload.join(', ')}`)
  }
  const dirty = await ports.git(['status', '--porcelain'])
  if (dirty.exitCode !== 0) throw new Error('could not establish whether the working tree is clean')
  if (dirty.stdout) throw new Error('refusing to publish from a dirty working tree')
  const headResult = await ports.git(['rev-parse', 'HEAD'])
  if (headResult.exitCode !== 0 || !/^[0-9a-f]{40}$/.test(headResult.stdout)) {
    throw new Error('could not resolve HEAD')
  }
  const remoteTag = await ports.git([
    'ls-remote',
    '--exit-code',
    '--tags',
    'origin',
    `refs/tags/${tag}`,
    `refs/tags/${tag}^{}`,
  ])
  if (remoteTag.exitCode !== 0) throw new Error(`tag ${tag} does not exist on origin`)
  const tagCommit = remoteTagCommit(tag, remoteTag.stdout)
  if (headResult.stdout !== tagCommit) {
    throw new Error(`HEAD ${headResult.stdout} does not match tag ${tag} commit ${tagCommit}`)
  }
  const manifest = readReleaseManifest(output)
  if (manifest.commit !== headResult.stdout) {
    throw new Error(
      `release manifest commit ${manifest.commit} does not match HEAD ${headResult.stdout}`,
    )
  }
  if (manifest.version !== version) {
    throw new Error(`release manifest version ${manifest.version} does not match tag ${tag}`)
  }
  if (manifest.bunVersion !== RELEASE_BUN_VERSION) {
    throw new Error(
      `release manifest Bun ${manifest.bunVersion} does not match pinned Bun ${RELEASE_BUN_VERSION}`,
    )
  }
  if (JSON.stringify(manifest.artifacts) !== JSON.stringify(names)) {
    throw new Error('release manifest artifact names do not match the release tag')
  }
  const repository = `modstudio/${PLATFORM_SLUG}`
  const release = await ports.gh(['release', 'view', tag, '--repo', repository])
  if (release.exitCode === 0) throw new Error(`GitHub release ${tag} already exists`)
  verifySha256Sums(output, names)
  const created = await ports.gh([
    'release',
    'create',
    tag,
    '--repo',
    repository,
    '--title',
    tag,
    ...upload.map((name) => join(output, name)),
  ])
  if (created.exitCode !== 0) throw new Error(`gh release create failed for ${tag}`)
}

if (import.meta.main) {
  const [tag, outputDirectory, confirmation] = process.argv.slice(2)
  if (!tag || !outputDirectory || process.argv.length < 4 || process.argv.length > 5) {
    throw new Error('working form: bun run release:publish -- v<version> <out-dir> --confirm')
  }
  await publishRelease(tag, outputDirectory, confirmation === '--confirm')
}
