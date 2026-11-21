// concern: release-binary-autoload-check
/** Builds the host release binary and proves that runtime working-directory config stays inert. */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startBounded } from '../../../shared/bounded-process.ts'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { COMPILE_AUTOLOAD_OFF_FLAGS } from '../../../shared/compile-autoload.ts'
import { refusal, renderRefusal } from '../../../shared/refusal.ts'

export const RELEASE_REQUIRE_PINNED_BUN_ENV = `${PLATFORM_SLUG.toUpperCase()}_RELEASE_REQUIRE_PINNED_BUN`
const RELEASE_DOTENV_SENTINEL_ENV = `${PLATFORM_SLUG.toUpperCase()}_RELEASE_DOTENV_SENTINEL`

type AutoloadOffFlag = (typeof COMPILE_AUTOLOAD_OFF_FLAGS)[number]
type ProbePlant = (facts: {
  directory: string
  marker: string
  observerMarker: string
  environment: Record<string, string | undefined>
}) => Record<string, string | undefined>
type AutoloadProbe = { flag: AutoloadOffFlag; directory: string; plant: ProbePlant }

function compileAutoloadFlag(source: string): AutoloadOffFlag {
  return (COMPILE_AUTOLOAD_OFF_FLAGS.find((flag) => flag.endsWith(`autoload-${source}`)) ??
    `--no-compile-autoload-${source}`) as AutoloadOffFlag
}

function observerSource(observerMarker: string): string {
  return `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(observerMarker)}, '')\n`
}

const AUTOLOAD_PROBES: readonly AutoloadProbe[] = [
  {
    flag: compileAutoloadFlag('dotenv'),
    directory: 'dotenv',
    plant: ({ directory, marker, observerMarker, environment }) => {
      writeFileSync(join(directory, '.env'), `${RELEASE_DOTENV_SENTINEL_ENV}=loaded\n`)
      writeFileSync(
        join(directory, 'observer.ts'),
        `${observerSource(observerMarker)}if (process.env.${RELEASE_DOTENV_SENTINEL_ENV}) writeFileSync(${JSON.stringify(marker)}, '')\n`,
      )
      const cleanEnvironment = { ...environment }
      delete cleanEnvironment[RELEASE_DOTENV_SENTINEL_ENV]
      return { ...cleanEnvironment, BUN_OPTIONS: '--preload=./observer.ts' }
    },
  },
  {
    flag: compileAutoloadFlag('bunfig'),
    directory: 'bunfig',
    plant: ({ directory, marker, observerMarker, environment }) => {
      writeFileSync(join(directory, 'bunfig.toml'), 'preload = ["./sentinel.ts"]\n')
      writeFileSync(join(directory, 'observer.ts'), observerSource(observerMarker))
      writeFileSync(
        join(directory, 'sentinel.ts'),
        `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(marker)}, '')\n`,
      )
      return { ...environment, BUN_OPTIONS: '--preload=./observer.ts' }
    },
  },
  {
    flag: compileAutoloadFlag('tsconfig'),
    directory: 'tsconfig',
    plant: ({ directory, marker, observerMarker, environment }) => {
      mkdirSync(join(directory, 'planted'))
      writeFileSync(
        join(directory, 'tsconfig.json'),
        `${JSON.stringify({
          compilerOptions: {
            baseUrl: '.',
            paths: { '@release-guard/*': ['./planted/*'] },
          },
        })}\n`,
      )
      writeFileSync(
        join(directory, 'observer.ts'),
        `${observerSource(observerMarker)}const modulePath = '@release-guard/' + 'marker'\nawait import(modulePath)\n`,
      )
      writeFileSync(
        join(directory, 'planted', 'marker.ts'),
        `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(marker)}, '')\n`,
      )
      return { ...environment, BUN_OPTIONS: '--preload=./observer.ts' }
    },
  },
  {
    flag: compileAutoloadFlag('package-json'),
    directory: 'package-json',
    plant: ({ directory, marker, observerMarker, environment }) => {
      writeFileSync(
        join(directory, 'package.json'),
        `${JSON.stringify({ imports: { '#release-autoload-sentinel': './sentinel.ts' } })}\n`,
      )
      writeFileSync(
        join(directory, 'observer.ts'),
        `${observerSource(observerMarker)}const modulePath = '#release-autoload-' + 'sentinel'\nawait import(modulePath)\n`,
      )
      writeFileSync(
        join(directory, 'sentinel.ts'),
        `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(marker)}, '')\n`,
      )
      return { ...environment, BUN_OPTIONS: '--preload=./observer.ts' }
    },
  },
]

const coveredFlags = new Set(AUTOLOAD_PROBES.map(({ flag }) => flag))
if (
  coveredFlags.size !== AUTOLOAD_PROBES.length ||
  COMPILE_AUTOLOAD_OFF_FLAGS.some(
    (flag) => AUTOLOAD_PROBES.filter(({ flag: probeFlag }) => probeFlag === flag).length !== 1,
  )
) {
  throw new Error(
    'release binary runtime guard must define exactly one probe for every compile autoload flag',
  )
}

function positiveFlag(flag: AutoloadOffFlag): string {
  return flag.replace('--no-', '--')
}

function autoloadFailure(flag: AutoloadOffFlag): Error {
  return new Error(
    renderRefusal(
      refusal(
        `release binary runtime guard failed: ${positiveFlag(flag)} took effect from the working directory`,
        {
          kind: 'edit',
          text: 'keep every flag of COMPILE_AUTOLOAD_OFF_FLAGS on the compile in scripts/build-binary.ts, then retry',
        },
      ),
    ),
  )
}

function observerFailure(flag: AutoloadOffFlag): Error {
  return new Error(
    renderRefusal(
      refusal(
        `release binary runtime guard failed for ${positiveFlag(flag)}: the sentinel's observer never ran, so the guard proved nothing`,
        {
          kind: 'edit',
          text: "the guard's injection mechanism stopped working on this Bun; fix the sentinel before releasing",
        },
      ),
    ),
  )
}

async function probe(
  binary: string,
  scratch: string,
  entry: AutoloadProbe,
  environment: Record<string, string | undefined>,
): Promise<void> {
  const directory = join(scratch, entry.directory)
  const marker = join(directory, 'autoload-marker')
  const observerMarker = join(directory, 'observer-ran')
  mkdirSync(directory)
  const probeEnvironment = entry.plant({ directory, marker, observerMarker, environment })
  await startBounded([binary, '--version'], {
    budget: 'self-cli',
    cwd: directory,
    env: probeEnvironment,
  })
  if (!existsSync(observerMarker)) throw observerFailure(entry.flag)
  if (existsSync(marker)) throw autoloadFailure(entry.flag)
}

/** Build and execute the same host binary as the release artifact path, with every cwd sentinel. */
export async function checkReleaseBinaryAutoload(
  root: string,
  tag: string,
  environment: Record<string, string | undefined> = process.env,
): Promise<void> {
  const scratch = mkdtempSync(join(tmpdir(), `${PLATFORM_SLUG}-release-autoload-`))
  const output = join(scratch, 'binary')
  try {
    mkdirSync(output)
    const build = await startBounded(
      [
        'bun',
        '--no-env-file',
        'scripts/build-binary.ts',
        tag,
        output,
        `${process.platform}-${process.arch}`,
      ],
      { budget: 'release-build', cwd: root, env: environment },
    )
    if (build.exitCode !== 0) {
      throw new Error(
        renderRefusal(
          refusal(
            `release binary runtime guard could not build the host binary: ${build.stderr.trim() || build.stdout.trim() || `exit ${build.exitCode}`}`,
            { kind: 'edit', text: 'fix the reported release build failure, then retry' },
          ),
        ),
      )
    }
    const binary = join(output, PLATFORM_SLUG)
    for (const entry of AUTOLOAD_PROBES) await probe(binary, scratch, entry, environment)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}
