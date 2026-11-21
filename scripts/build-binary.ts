import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { commentParserAssets } from '../orchestrator/src/check/check-comment-parser-assets.ts'
import {
  SYSTEMD_TEMPLATE_DIRECTORY,
  SYSTEMD_UNIT_SUFFIXES,
} from '../orchestrator/src/setup/setup-schedule-policy.ts'
import { PLATFORM_SLUG } from '../shared/brand.ts'
import { COMPILE_AUTOLOAD_OFF_FLAGS } from '../shared/compile-autoload.ts'
import {
  EMBEDDED_ASSET_PREFIXES,
  RUNTIME_ASSETS,
  registerEmbeddedAssets,
} from '../shared/embedded-assets.ts'
import { LAUNCHD_TEMPLATE_OWNERS } from '../shared/launchd-owners.ts'
import { BINARY_TARGETS, type BinaryTarget } from '../shared/release-artifacts.ts'
import { sandboxRuntimePayloadPaths } from '../shared/sandbox-runtime-assets.ts'
import { requireReleaseBun } from './release-config.ts'
import { distributionManifest, releaseVersion, run } from './release-support.ts'

const repositoryRoot = resolve(import.meta.dir, '..')

function generatedAssetModule(
  textPaths: string[],
  literalTextPaths: string[],
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
    .concat(
      literalTextPaths.map(
        (path) =>
          `${JSON.stringify(path)}: ${JSON.stringify(readFileSync(join(repositoryRoot, path), 'utf8'))}`,
      ),
    )
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
  for (const root of EMBEDDED_ASSET_PREFIXES.filter((path) => path.endsWith('/migrations'))) {
    paths.push(...(await embeddedAssetPaths(root)))
  }
  return paths.sort()
}

async function scheduleTemplateAssetPaths(): Promise<string[]> {
  const paths: string[] = []
  for (const owner of LAUNCHD_TEMPLATE_OWNERS) {
    const root = `${owner.concern}/${owner.directory}`
    paths.push(
      ...(await embeddedAssetPaths(root)).filter((path) => path.endsWith('.plist.template')),
    )
  }
  paths.push(
    ...(await embeddedAssetPaths(SYSTEMD_TEMPLATE_DIRECTORY)).filter((path) =>
      SYSTEMD_UNIT_SUFFIXES.some((suffix) => path.endsWith(suffix)),
    ),
  )
  return paths.sort()
}

async function webAssetPaths(): Promise<string[]> {
  const root = EMBEDDED_ASSET_PREFIXES.find((path) => path.endsWith('/web/dist'))!
  const paths = await embeddedAssetPaths(root)
  if (paths.length === 0) throw new Error('hub/web/dist is empty after the web build')
  return paths
}

export { BINARY_TARGETS }

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
  return { platform: os === 'darwin' ? 'darwin' : 'linux', arch: arch! }
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
    const commentParserPaths = commentParserAssets(target).map(({ packagePath }) => packagePath)
    for (const path of commentParserPaths) {
      const source = join(repositoryRoot, path)
      if (!existsSync(source)) throw new Error(`required comment parser is missing: ${source}`)
    }
    const assets = join(generatedDirectory, 'embedded-assets.ts')
    writeFileSync(
      assets,
      generatedAssetModule(
        [
          ...(await migrationAssetPaths()),
          ...(await scheduleTemplateAssetPaths()),
          ...RUNTIME_ASSETS.filter((asset) => !asset.packagePath.endsWith('.json')).map(
            (asset) => asset.packagePath,
          ),
        ],
        RUNTIME_ASSETS.filter((asset) => asset.packagePath.endsWith('.json')).map(
          (asset) => asset.packagePath,
        ),
        [
          ...(await webAssetPaths()),
          ...sandboxRuntimePayloadPaths(platform, arch),
          ...commentParserPaths,
        ],
        manifest,
      ),
    )
    const wrapper = join(generatedDirectory, 'entry.ts')
    writeFileSync(
      wrapper,
      `import './embedded-assets.ts'
await import(${JSON.stringify(join(repositoryRoot, 'cli', `${PLATFORM_SLUG}.ts`))})
`,
    )

    await run(
      [
        'bun',
        'build',
        '--compile',
        `--target=bun-${target}`,
        ...COMPILE_AUTOLOAD_OFF_FLAGS,
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
