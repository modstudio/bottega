// concern: release-binary-autoload-check
/** Builds the host release binary and proves that runtime working-directory config stays inert. */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startBounded } from '../../../shared/bounded-process.ts'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { refusal, renderRefusal } from '../../../shared/refusal.ts'

const AUTOLOAD_SWITCHES = [
  '--compile-autoload-dotenv',
  '--compile-autoload-bunfig',
  '--compile-autoload-tsconfig',
  '--compile-autoload-package-json',
] as const

async function runBinary(
  binary: string,
  args: readonly string[],
  cwd: string,
  environment: Record<string, string | undefined>,
): Promise<{ stdout: string; stderr: string }> {
  const result = await startBounded([binary, ...args], {
    budget: 'self-cli',
    cwd,
    env: environment,
  })
  return { stdout: result.stdout, stderr: result.stderr }
}

function autoloadFailure(flag: (typeof AUTOLOAD_SWITCHES)[number]): Error {
  return new Error(
    `release binary runtime guard failed: ${flag} took effect from the working directory`,
  )
}

async function checkDotenv(
  binary: string,
  directory: string,
  environment: Record<string, string | undefined>,
): Promise<void> {
  const marker = join(directory, 'dotenv-marker')
  const sentinelName = 'BOTTEGA_RELEASE_DOTENV_SENTINEL'
  writeFileSync(join(directory, '.env'), `${sentinelName}=loaded\n`)
  writeFileSync(
    join(directory, 'planted.ts'),
    `import { writeFileSync } from 'node:fs'\nif (process.env.${sentinelName}) writeFileSync(${JSON.stringify(marker)}, '')\n`,
  )
  const cleanEnvironment = { ...environment }
  delete cleanEnvironment[sentinelName]
  await runBinary(binary, ['--version'], directory, {
    ...cleanEnvironment,
    BUN_OPTIONS: '--preload=./planted.ts',
  })
  if (existsSync(marker)) throw autoloadFailure(AUTOLOAD_SWITCHES[0])
}

async function checkBunfig(
  binary: string,
  directory: string,
  environment: Record<string, string | undefined>,
): Promise<void> {
  const marker = join(directory, 'bunfig-marker')
  writeFileSync(join(directory, 'bunfig.toml'), 'preload = ["./planted.ts"]\n')
  writeFileSync(
    join(directory, 'planted.ts'),
    `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(marker)}, '')\n`,
  )
  await runBinary(binary, ['--version'], directory, environment)
  if (existsSync(marker)) throw autoloadFailure(AUTOLOAD_SWITCHES[1])
}

async function checkTsconfig(
  binary: string,
  directory: string,
  environment: Record<string, string | undefined>,
): Promise<void> {
  const marker = join(directory, 'tsconfig-marker')
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
    join(directory, 'entry.ts'),
    `const modulePath = '@release-guard/' + 'marker'\nawait import(modulePath)\n`,
  )
  writeFileSync(
    join(directory, 'planted', 'marker.ts'),
    `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(marker)}, '')\n`,
  )
  await runBinary(binary, ['--version'], directory, {
    ...environment,
    BUN_OPTIONS: '--preload=./entry.ts',
  })
  if (existsSync(marker)) throw autoloadFailure(AUTOLOAD_SWITCHES[2])
}

async function checkPackageJson(
  binary: string,
  directory: string,
  environment: Record<string, string | undefined>,
): Promise<void> {
  const marker = join(directory, 'package-json-marker')
  writeFileSync(
    join(directory, 'package.json'),
    `${JSON.stringify({
      imports: { '#release-autoload-sentinel': './planted.ts' },
    })}\n`,
  )
  writeFileSync(
    join(directory, 'entry.ts'),
    `const modulePath = '#release-autoload-' + 'sentinel'\nawait import(modulePath)\n`,
  )
  writeFileSync(
    join(directory, 'planted.ts'),
    `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(marker)}, '')\n`,
  )
  await runBinary(binary, ['--version'], directory, {
    ...environment,
    BUN_OPTIONS: '--preload=./entry.ts',
  })
  if (existsSync(marker)) throw autoloadFailure(AUTOLOAD_SWITCHES[3])
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
      { budget: 'self-cli', cwd: root, env: environment },
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
    const dotenv = join(scratch, 'dotenv')
    const bunfig = join(scratch, 'bunfig')
    const tsconfig = join(scratch, 'tsconfig')
    const packageJson = join(scratch, 'package-json')
    for (const directory of [dotenv, bunfig, tsconfig, packageJson]) mkdirSync(directory)
    await checkDotenv(binary, dotenv, environment)
    await checkBunfig(binary, bunfig, environment)
    await checkTsconfig(binary, tsconfig, environment)
    await checkPackageJson(binary, packageJson, environment)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}
