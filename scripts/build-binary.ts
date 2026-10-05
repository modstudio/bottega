import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PLATFORM_SLUG } from '../shared/brand.ts'
import { REF_GUARD_RUNTIME_ASSET, registerEmbeddedAssets } from '../shared/embedded-assets.ts'
import { sandboxRuntimePayloadPaths } from '../shared/sandbox-runtime-assets.ts'
import { distributionManifest, releaseVersion, run } from './build-release.ts'
import { requireReleaseBun } from './release-config.ts'

const repositoryRoot = resolve(import.meta.dir, '..')

function generatedAssetModule(
  textPaths: string[],
  filePaths: string[],
  manifest: ReturnType<typeof distributionManifest>,
): string {
  const textImports = textPaths
    .map(
      (path, index) =>
        `import asset${index} from ${JSON.stringify(join(repositoryRoot, path))} with { type: 'text' }`,
    )
    .join('\n')
  const fileImports = filePaths
    .map(
      (path, index) =>
        `import file${index} from ${JSON.stringify(join(repositoryRoot, path))} with { type: 'file' }`,
    )
    .join('\n')
  const assetEntries = textPaths
    .map((path, index) => `${JSON.stringify(path)}: asset${index}`)
    .join(',\n')
  const fileEntries = filePaths
    .map((path, index) => `${JSON.stringify(path)}: file${index}`)
    .join(',\n')
  return `${textImports}
${fileImports}
import { ${registerEmbeddedAssets.name} } from ${JSON.stringify(join(repositoryRoot, 'shared/embedded-assets.ts'))}

${registerEmbeddedAssets.name}({ assets: {
${assetEntries}
}, files: {
${fileEntries}
}, manifest: ${JSON.stringify(manifest)} })
`
}

export async function embeddedAssetPaths(
  root: string,
  source = join(repositoryRoot, root),
): Promise<string[]> {
  const paths: string[] = []
  for await (const path of new Bun.Glob('**/*').scan({
    cwd: source,
    dot: true,
  })) {
    paths.push(join(root, path))
  }
  return paths.sort()
}

async function migrationAssetPaths(): Promise<string[]> {
  const paths: string[] = []
  for (const root of ['orchestrator/migrations', 'hub/migrations']) {
    paths.push(...(await embeddedAssetPaths(root)))
  }
  return paths.sort()
}

async function webAssetPaths(): Promise<string[]> {
  const root = 'hub/web/dist'
  const paths = await embeddedAssetPaths(root)
  if (paths.length === 0) throw new Error('hub/web/dist is empty after the web build')
  return paths
}

export const BINARY_TARGETS = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64'] as const
export type BinaryTarget = (typeof BINARY_TARGETS)[number]

export function parseBinaryTarget(value: string): BinaryTarget {
  if ((BINARY_TARGETS as readonly string[]).includes(value)) return value as BinaryTarget
  throw new Error(
    `unsupported binary target ${JSON.stringify(value)}; supported targets: ${BINARY_TARGETS.join(', ')} (Windows and musl are unsupported)`,
  )
}

function targetParts(target: BinaryTarget): {
  platform: NodeJS.Platform
  arch: string
} {
  const [os, arch] = target.split('-')
  return { platform: os === 'darwin' ? 'darwin' : 'linux', arch }
}

export function assertTargetHost(target: BinaryTarget, hostPlatform: NodeJS.Platform): void {
  if (target.startsWith('darwin-') && hostPlatform !== 'darwin') {
    throw new Error(
      `refusing to build ${target} on ${hostPlatform}: Darwin binaries must be ad-hoc signed on a Darwin host`,
    )
  }
}

export async function buildBinary(
  tag: string,
  outputDirectory: string,
  target: BinaryTarget,
): Promise<string> {
  requireReleaseBun()
  const { platform, arch } = targetParts(target)
  assertTargetHost(target, process.platform)
  const version = releaseVersion(tag)
  const destination = resolve(outputDirectory, PLATFORM_SLUG)
  const generatedDirectory = mkdtempSync(join(tmpdir(), `${PLATFORM_SLUG}-binary-`))
  try {
    mkdirSync(outputDirectory, { recursive: true })
    await run(['bun', 'run', 'build'], join(repositoryRoot, 'hub/web'))
    const commit = await run(['git', 'rev-parse', 'HEAD'])
    const built = await run(['git', 'show', '-s', '--format=%cI', 'HEAD'])
    const manifest = distributionManifest(version, built, commit)
    const assets = join(generatedDirectory, 'embedded-assets.ts')
    writeFileSync(
      assets,
      generatedAssetModule(
        [...(await migrationAssetPaths()), REF_GUARD_RUNTIME_ASSET.packagePath],
        [...(await webAssetPaths()), ...sandboxRuntimePayloadPaths(platform, arch)],
        manifest,
      ),
    )
    const wrapper = join(generatedDirectory, 'entry.ts')
    writeFileSync(
      wrapper,
      `import './embedded-assets.ts'
await import(${JSON.stringify(join(repositoryRoot, 'release', `${PLATFORM_SLUG}.ts`))})
`,
    )

    await run(
      [
        'bun',
        'build',
        '--compile',
        `--target=bun-${target}`,
        '--no-autoload-dotenv',
        '--outfile',
        destination,
        wrapper,
      ],
      generatedDirectory,
    )
    if (platform === 'darwin') {
      await run(['codesign', '--force', '--sign', '-', destination])
    }
    return destination
  } finally {
    rmSync(generatedDirectory, { recursive: true, force: true })
  }
}

export async function buildHostBinary(tag: string, outputDirectory: string): Promise<string> {
  return buildBinary(tag, outputDirectory, parseBinaryTarget(`${process.platform}-${process.arch}`))
}

if (import.meta.main) {
  const [tag, outputDirectory, rawTarget] = process.argv.slice(2)
  if (!tag || !outputDirectory || !rawTarget || process.argv.length !== 5) {
    throw new Error(
      'working form: bun run release:binary -- v<version> <output-directory> <target>',
    )
  }
  console.log(await buildBinary(tag, outputDirectory, parseBinaryTarget(rawTarget)))
}
