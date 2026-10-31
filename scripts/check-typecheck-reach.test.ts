import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { posix } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CHECK_LEGS } from './check-plan.ts'
import { uncoveredTypeScriptPaths } from './check-typecheck-reach.ts'

const root = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')

function packageScript(directory: string, scriptName: string, legName: string): string {
  const packageJson = JSON.parse(readFileSync(`${root}/${directory}/package.json`, 'utf8')) as {
    scripts?: Record<string, string>
  }
  const script = packageJson.scripts?.[scriptName]
  if (!script) throw new Error(`${legName}: package script ${scriptName} is not declared`)
  return script
}

function configForDirectory(directory: string): string {
  return directory === '.' ? 'tsconfig.json' : `${directory}/tsconfig.json`
}

function declaredConfigsFromCommand(leg: (typeof CHECK_LEGS)[number]): string[] {
  if (leg.typecheck === null) return []
  const [bun, run, scriptName, ...rest] = leg.typecheck
  if (bun !== 'bun' || run !== 'run' || !scriptName || rest.length > 0) {
    throw new Error(`${leg.name}: unsupported typecheck command ${leg.typecheck.join(' ')}`)
  }
  const script = packageScript(leg.directory, scriptName, leg.name)
  if (script === 'tsc --noEmit') return [configForDirectory(leg.directory)]

  const project = /^tsc --noEmit -p ([^ ]+)$/.exec(script)
  if (leg.directory === '.' && project) return [project[1]!]

  if (leg.name === 'hub/web') {
    const commands = script.split(' && ')
    if (commands.pop() !== 'tsc --noEmit') {
      throw new Error(`${leg.name}: typecheck script must finish with tsc --noEmit`)
    }
    const chained = commands.map((command) => {
      const chained = /^bun run --cwd ([^ ]+) typecheck$/.exec(command)
      if (!chained) throw new Error(`${leg.name}: unsupported typecheck script command ${command}`)
      const directory = posix.normalize(posix.join(leg.directory, chained[1]!))
      const targetScript = packageScript(directory, 'typecheck', leg.name)
      if (targetScript !== 'tsc --noEmit') {
        throw new Error(`${leg.name}: unsupported chained typecheck script ${targetScript}`)
      }
      return configForDirectory(directory)
    })
    return [configForDirectory(leg.directory), ...chained]
  }

  throw new Error(`${leg.name}: unsupported typecheck script ${script}`)
}

test('reports a tracked TypeScript file that no typecheck leg covers', () => {
  expect(uncoveredTypeScriptPaths(['scripts/example.ts'], [[]])).toEqual(['scripts/example.ts'])
})

test("every leg's declared configs match its typecheck command", () => {
  for (const leg of CHECK_LEGS) {
    const declared: readonly string[] = leg.typecheckConfigs
    expect(declared, leg.name).toEqual(declaredConfigsFromCommand(leg))
  }
})

test('does not report a tracked TypeScript file covered by one leg', () => {
  expect(uncoveredTypeScriptPaths(['scripts/example.ts'], [['scripts/example.ts']])).toEqual([])
})

test('does not report a tracked TypeScript file covered by two legs', () => {
  expect(
    uncoveredTypeScriptPaths(['shared/example.ts'], [['shared/example.ts'], ['shared/example.ts']]),
  ).toEqual([])
})
