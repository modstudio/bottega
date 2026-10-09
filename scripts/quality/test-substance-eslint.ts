import parser from '@typescript-eslint/parser'
import vitestPlugin from '@vitest/eslint-plugin'
import { ESLint, type Linter } from 'eslint'
import jestPlugin from 'eslint-plugin-jest'
import sonarPlugin from 'eslint-plugin-sonarjs'
import ts from 'typescript'
import { selfComparisonRule } from './self-comparison'
import { applyTestWaivers, OUTSIDE_TEST, type TestFinding, type TestWaiver } from './test-substance'

type Runner = 'bun' | 'vitest' | 'unrecognised'

export type SubstanceReport = {
  findings: TestFinding[]
  parseError?: string
  runner: Runner
}

type TestLocation = {
  end: number
  line: number
  name: string
  start: number
}

const SONAR_RULES = [
  'assertions-in-tests',
  'no-trivial-assertions',
  'async-test-assertions',
  'no-exclusive-tests',
  'no-duplicate-test-title',
] as const
const RUNNER_RULES = ['valid-expect', 'no-disabled-tests', 'no-focused-tests'] as const

export const GUARDED_RULES = [
  'assertions-in-tests',
  'no-trivial-assertions',
  'async-test-assertions',
  'no-exclusive-tests',
  'no-duplicate-test-title',
  'valid-expect',
  'no-disabled-tests',
  'no-focused-tests',
  'self-comparison',
  'unused-waiver',
] as const

function callRootName(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) return expression.text
  if (ts.isPropertyAccessExpression(expression)) return callRootName(expression.expression)
  if (ts.isCallExpression(expression)) return callRootName(expression.expression)
  return undefined
}

function staticTitle(call: ts.CallExpression) {
  const title = call.arguments[0]
  return title && (ts.isStringLiteralLike(title) || ts.isNoSubstitutionTemplateLiteral(title))
    ? title.text
    : '<dynamic title>'
}

function callback(call: ts.CallExpression): ts.FunctionLikeDeclaration | undefined {
  return [...call.arguments]
    .reverse()
    .find(
      (argument): argument is ts.ArrowFunction | ts.FunctionExpression =>
        ts.isArrowFunction(argument) || ts.isFunctionExpression(argument),
    )
}

function testLocations(file: string, content: string): TestLocation[] {
  const source = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const locations: TestLocation[] = []

  function visit(node: ts.Node, titles: string[]) {
    if (ts.isCallExpression(node)) {
      const root = callRootName(node.expression)
      if (root === 'describe') {
        const body = callback(node)
        if (body) visit(body.body, [...titles, staticTitle(node)])
        return
      }
      if (root === 'test' || root === 'it') {
        const start = node.getStart(source)
        locations.push({
          start,
          end: node.getEnd(),
          line: source.getLineAndCharacterOfPosition(start).line + 1,
          name: [...titles, staticTitle(node)].join(' > '),
        })
        return
      }
    }
    ts.forEachChild(node, (child) => visit(child, titles))
  }

  visit(source, [])
  return locations
}

function runnerFor(content: string): Runner {
  const source = ts.createSourceFile('runner.ts', content, ts.ScriptTarget.Latest, true)
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
      continue
    if (statement.moduleSpecifier.text === 'bun:test') return 'bun'
    if (statement.moduleSpecifier.text === 'vitest') return 'vitest'
  }
  return 'unrecognised'
}

function rules(prefix: string, names: readonly string[]): Linter.RulesRecord {
  return Object.fromEntries(names.map((name) => [`${prefix}/${name}`, 'error']))
}

function eslint(runner: Runner, sonar: boolean, custom = true) {
  const plugins: Record<string, ESLint.Plugin> = {}
  const configuredRules: Linter.RulesRecord = {}
  if (custom) {
    plugins['test-substance'] = { rules: { 'self-comparison': selfComparisonRule } }
    configuredRules['test-substance/self-comparison'] = 'error'
  }
  const settings: Record<string, unknown> = {}
  if (sonar) {
    plugins.sonarjs = sonarPlugin as ESLint.Plugin
    Object.assign(configuredRules, rules('sonarjs', SONAR_RULES))
  }
  if (runner === 'bun') {
    plugins.jest = jestPlugin as ESLint.Plugin
    Object.assign(configuredRules, rules('jest', RUNNER_RULES))
    settings.jest = { globalPackage: 'bun:test' }
  }
  if (runner === 'vitest') {
    plugins.vitest = vitestPlugin as ESLint.Plugin
    Object.assign(configuredRules, rules('vitest', RUNNER_RULES))
  }

  return new ESLint({
    overrideConfigFile: true,
    overrideConfig: [
      {
        files: ['**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}'],
        languageOptions: {
          parser,
          parserOptions: {
            ecmaFeatures: { jsx: true },
            ecmaVersion: 'latest',
            sourceType: 'module',
          },
        },
        plugins,
        rules: configuredRules,
        settings,
      },
    ],
  })
}

function normalizedRule(ruleId: string) {
  return ruleId.slice(ruleId.indexOf('/') + 1)
}

function offsetAt(content: string, line: number, column: number) {
  let offset = 0
  for (let current = 1; current < line; current += 1) offset = content.indexOf('\n', offset) + 1
  return offset + column - 1
}

function enclosingTest(locations: TestLocation[], offset: number) {
  return locations
    .filter((location) => location.start <= offset && offset <= location.end)
    .sort((left, right) => left.end - left.start - (right.end - right.start))[0]
}

function waivers(file: string, content: string, locations: TestLocation[]): TestWaiver[] {
  const lines = content.split('\n')
  const result: TestWaiver[] = []
  for (const location of locations) {
    const line = lines[location.line - 2] ?? ''
    const match = line.match(
      /^\s*(?:\/\/|\/\*)\s*test-substance-allow:\s+(\S+)(?:\s+(.*?))?\s*(?:\*\/)?\s*$/,
    )
    if (!match) continue
    result.push({
      file,
      line: location.line - 1,
      testName: location.name,
      rule: match[1]!,
      reason: match[2]?.replace(/\s*\*\/$/, '').trim() ?? '',
    })
  }
  return result
}

async function lintMessages(file: string, content: string, runner: Runner) {
  if (runner !== 'bun')
    return (await eslint(runner, true).lintText(content, { filePath: file }))[0]!

  // SonarJS recognises Vitest's API but not bun:test. Preserve the test source and
  // substitute only its module name for the SonarJS pass; the Jest pass sees the
  // original bun:test import and settings.
  const sonarContent = content.replace(/(['"])bun:test\1/g, '$1vitest$1')
  const [sonarResult] = await eslint('unrecognised', true, false).lintText(sonarContent, {
    filePath: file,
  })
  const [runnerResult] = await eslint('bun', false).lintText(content, { filePath: file })
  return {
    ...runnerResult!,
    messages: [...sonarResult!.messages, ...runnerResult!.messages],
  }
}

export async function testSubstanceReport(file: string, content: string): Promise<SubstanceReport> {
  const runner = runnerFor(content)
  const locations = testLocations(file, content)
  const result = await lintMessages(file, content, runner)
  const fatal = result.messages.find((message) => message.fatal)
  if (fatal) return { findings: [], parseError: fatal.message, runner }

  const findings = result.messages
    .filter((message): message is typeof message & { ruleId: string } => Boolean(message.ruleId))
    .map((message): TestFinding => {
      const test = enclosingTest(locations, offsetAt(content, message.line, message.column))
      return {
        file,
        line: message.line,
        rule: normalizedRule(message.ruleId),
        testName: test?.name ?? OUTSIDE_TEST,
        message: message.message.replace(/\s+/g, ' ').trim(),
      }
    })
  return {
    findings: applyTestWaivers(findings, waivers(file, content, locations)),
    runner,
  }
}
