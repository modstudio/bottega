import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PLATFORM_SLUG } from '../shared/brand.ts'
import { registerEmbeddedAssets } from '../shared/embedded-assets.ts'
import { distributionManifest, releaseVersion, run } from './build-release.ts'

const repositoryRoot = resolve(import.meta.dir, '..')

function generatedAssetModule(
  paths: string[],
  manifest: ReturnType<typeof distributionManifest>,
): string {
  const imports = paths
    .map(
      (path, index) =>
        `import asset${index} from ${JSON.stringify(join(repositoryRoot, path))} with { type: 'text' }`,
    )
    .join('\n')
  const entries = paths.map((path, index) => `${JSON.stringify(path)}: asset${index}`).join(',\n')
  return `${imports}
import { ${registerEmbeddedAssets.name} } from ${JSON.stringify(join(repositoryRoot, 'shared/embedded-assets.ts'))}

${registerEmbeddedAssets.name}({ assets: {
${entries}
}, manifest: ${JSON.stringify(manifest)} })
`
}

async function migrationAssetPaths(): Promise<string[]> {
  const paths: string[] = []
  for (const root of ['orchestrator/migrations', 'hub/migrations']) {
    for await (const path of new Bun.Glob('**/*').scan({ cwd: join(repositoryRoot, root) })) {
      paths.push(join(root, path))
    }
  }
  return paths.sort()
}

export async function buildHostBinary(tag: string, outputDirectory: string): Promise<string> {
  const version = releaseVersion(tag)
  const destination = resolve(outputDirectory, PLATFORM_SLUG)
  const generatedDirectory = mkdtempSync(join(tmpdir(), `${PLATFORM_SLUG}-binary-`))
  try {
    mkdirSync(outputDirectory, { recursive: true })
    const commit = await run(['git', 'rev-parse', 'HEAD'])
    const built = await run(['git', 'show', '-s', '--format=%cI', 'HEAD'])
    const manifest = distributionManifest(version, built, commit)
    const assets = join(generatedDirectory, 'embedded-assets.ts')
    writeFileSync(assets, generatedAssetModule(await migrationAssetPaths(), manifest))
    const wrapper = join(generatedDirectory, 'entry.ts')
    writeFileSync(
      wrapper,
      `import './embedded-assets.ts'
await import(${JSON.stringify(join(repositoryRoot, 'release', `${PLATFORM_SLUG}.ts`))})
`,
    )

    const buildCwd = process.cwd()
    process.chdir(generatedDirectory)
    const result = await Bun.build({
      entrypoints: [wrapper],
      target: 'bun',
      compile: {
        outfile: destination,
        autoloadDotenv: false,
      },
    }).finally(() => process.chdir(buildCwd))
    if (!result.success) {
      throw new Error(`binary build failed:\n${result.logs.map(String).join('\n')}`)
    }
    if (process.platform === 'darwin') {
      await run(['codesign', '--force', '--sign', '-', destination])
    }
    return destination
  } finally {
    rmSync(generatedDirectory, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  const [tag, outputDirectory] = process.argv.slice(2)
  if (!tag || !outputDirectory || process.argv.length !== 4) {
    throw new Error('working form: bun run release:binary -- v<version> <output-directory>')
  }
  console.log(await buildHostBinary(tag, outputDirectory))
}
