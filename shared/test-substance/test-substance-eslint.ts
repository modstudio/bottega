import { isAbsolute } from 'node:path'
import parser from '@typescript-eslint/parser'
import vitestPlugin from '@vitest/eslint-plugin'
import { ESLint, type Linter } from 'eslint'
import jestPlugin from 'eslint-plugin-jest'
import sonarPlugin from 'eslint-plugin-sonarjs'
import ts from 'typescript'
import { expectWithoutMatcherRule } from './expect-without-matcher'
import { noAssertionRule } from './no-assertion'
import { readRelativeModule } from './relative-module'
import { selfComparisonRule } from './self-comparison'
import {
  applyTestWaivers,
  OUTSIDE_TEST,
  TEST_FILE_EXTENSIONS,
  type TestFinding,
  type TestWaiver,
} from './test-substance'
import { vitestAsyncAssertionRule } from './vitest-async-assertion'

type Runner = 'browser' | 'bun' | 'vitest' | 'unrecognised'

const RUNNERS_BY_PACKAGE = new Map<string, Exclude<Runner, 'unrecognised'>>([
  ['bun:test', 'bun'],
  ['vitest', 'vitest'],
  ['@playwright/test', 'browser'],
])

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
  'no-trivial-assertions',
  'async-test-assertions',
  'no-exclusive-tests',
  'no-duplicate-test-title',
] as const
const SHARED_RUNNER_RULES = ['no-disabled-tests', 'no-focused-tests'] as const

const SHARED_GUARDED_RULES = [
  'no-assertion',
  'no-trivial-assertions',
  'no-exclusive-tests',
  'no-duplicate-test-title',
  'no-disabled-tests',
  'no-focused-tests',
  'self-comparison',
  'unused-waiver',
] as const

export function guardedRules(runner: Exclude<Runner, 'unrecognised'>): readonly string[] {
  if (runner === 'browser') return []
  return runner === 'bun'
    ? [...SHARED_GUARDED_RULES, 'expect-without-matcher']
    : [...SHARED_GUARDED_RULES, 'async-test-assertions', 'valid-expect']
}

function callRootName(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) return expression.text
  if (ts.isPropertyAccessExpression(expression)) return callRootName(expression.expression)
  if (ts.isCallExpression(expression)) return callRootName(expression.expression)
  return undefined
}

function testTitle(source: ts.SourceFile, call: ts.CallExpression) {
  const title = call.arguments[0]
  return title && (ts.isStringLiteralLike(title) || ts.isNoSubstitutionTemplateLiteral(title))
    ? title.text
    : (title?.getText(source) ?? '<missing title>')
}

function callback(call: ts.CallExpression): ts.ArrowFunction | ts.FunctionExpression | undefined {
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
        if (body) visit(body.body, [...titles, testTitle(source, node)])
        return
      }
      if (root === 'test' || root === 'it') {
        const start = node.getStart(source)
        locations.push({
          start,
          end: node.getEnd(),
          line: source.getLineAndCharacterOfPosition(start).line + 1,
          name: [...titles, testTitle(source, node)].join(' > '),
        })
        return
      }
    }
    ts.forEachChild(node, (child) => visit(child, titles))
  }

  visit(source, [])
  return locations
}

function importedRunners(source: ts.SourceFile) {
  const runners: Exclude<Runner, 'unrecognised'>[] = []
  function collect(specifier: ts.Expression | undefined) {
    if (!specifier || !ts.isStringLiteralLike(specifier)) return
    const runner = RUNNERS_BY_PACKAGE.get(specifier.text)
    if (runner) runners.push(runner)
  }
  function visit(node: ts.Node) {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause
      const importsValue =
        !clause ||
        (!clause.isTypeOnly &&
          (Boolean(clause.name) ||
            !clause.namedBindings ||
            ts.isNamespaceImport(clause.namedBindings) ||
            clause.namedBindings.elements.some((element) => !element.isTypeOnly)))
      if (importsValue) collect(node.moduleSpecifier)
    } else if (ts.isExportDeclaration(node)) {
      const exportsValue =
        !node.isTypeOnly &&
        (!node.exportClause ||
          ts.isNamespaceExport(node.exportClause) ||
          node.exportClause.elements.some((element) => !element.isTypeOnly))
      if (exportsValue) collect(node.moduleSpecifier)
    } else if (ts.isCallExpression(node)) {
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require'
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword
      if (isRequire || isDynamicImport) collect(node.arguments[0])
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return runners
}

function valueImportBindings(statement: ts.ImportDeclaration) {
  const clause = statement.importClause
  if (!clause || clause.isTypeOnly) return []
  const bindings: string[] = []
  if (clause.name) bindings.push(clause.name.text)
  if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
    bindings.push(clause.namedBindings.name.text)
  }
  if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
    for (const element of clause.namedBindings.elements) {
      if (!element.isTypeOnly) bindings.push(element.name.text)
    }
  }
  return bindings
}

function statementCallRoots(source: ts.SourceFile, relativeBindings: Set<string>) {
  const roots = new Set<string>()

  function visitCallback(node: ts.CallExpression) {
    for (const argument of node.arguments) {
      if (ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)) visit(argument.body)
    }
  }

  function visit(node: ts.Node) {
    if (ts.isFunctionLike(node)) return
    if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)) {
      const root = callRootName(node.expression.expression)
      if (root) {
        roots.add(root)
        if (relativeBindings.has(root) || root === 'describe' || root === 'test' || root === 'it') {
          visitCallback(node.expression)
        }
      }
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return roots
}

function valueImports(source: ts.SourceFile) {
  const valueBindings = new Set<string>()
  const relativeImports: Array<{ bindings: string[]; specifier: string }> = []
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue
    if (!ts.isStringLiteralLike(statement.moduleSpecifier)) continue
    const bindings = valueImportBindings(statement)
    for (const binding of bindings) valueBindings.add(binding)
    if (bindings.length && statement.moduleSpecifier.text.startsWith('.')) {
      relativeImports.push({ bindings, specifier: statement.moduleSpecifier.text })
    }
  }
  return { relativeImports, valueBindings }
}

function runnerFromRelativeImports(
  file: string,
  relativeImports: Array<{ bindings: string[]; specifier: string }>,
  called: Set<string>,
): Runner {
  const runners = new Set<Exclude<Runner, 'unrecognised'>>()
  for (const { bindings, specifier } of relativeImports) {
    if (!bindings.some((binding) => called.has(binding))) continue
    const imported = readRelativeModule(file, specifier)
    if (!imported) continue
    for (const runner of importedRunners(imported.parsed.source)) runners.add(runner)
  }
  return runners.size === 1 ? [...runners][0]! : 'unrecognised'
}

function runnerFor(file: string, content: string): Runner {
  const source = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true)
  const [direct] = importedRunners(source)
  if (direct) return direct

  const { relativeImports, valueBindings } = valueImports(source)
  const relativeBindings = new Set(relativeImports.flatMap(({ bindings }) => bindings))
  const called = statementCallRoots(source, relativeBindings)
  if (['test', 'it', 'describe'].some((name) => called.has(name) && !valueBindings.has(name))) {
    return 'unrecognised'
  }
  return runnerFromRelativeImports(file, relativeImports, called)
}

function rules(prefix: string, names: readonly string[]): Linter.RulesRecord {
  return Object.fromEntries(names.map((name) => [`${prefix}/${name}`, 'error']))
}

function eslint(file: string, runner: Runner, sonar: boolean, custom = true, runnerRules = true) {
  const plugins: Record<string, ESLint.Plugin> = {}
  const configuredRules: Linter.RulesRecord = {}
  if (custom) {
    plugins['test-substance'] = {
      rules: {
        'expect-without-matcher': expectWithoutMatcherRule,
        'no-assertion': noAssertionRule(file),
        'self-comparison': selfComparisonRule,
        'async-test-assertions': vitestAsyncAssertionRule,
      },
    }
    configuredRules['test-substance/no-assertion'] = 'error'
    configuredRules['test-substance/self-comparison'] = 'error'
    if (runner === 'bun') configuredRules['test-substance/expect-without-matcher'] = 'error'
    if (runner === 'vitest') configuredRules['test-substance/async-test-assertions'] = 'error'
  }
  const settings: Record<string, unknown> = {}
  if (sonar) {
    plugins.sonarjs = sonarPlugin as ESLint.Plugin
    Object.assign(
      configuredRules,
      rules(
        'sonarjs',
        SONAR_RULES.filter((rule) => rule !== 'async-test-assertions'),
      ),
    )
  }
  if (runnerRules && runner === 'bun') {
    plugins.jest = jestPlugin as ESLint.Plugin
    Object.assign(configuredRules, rules('jest', SHARED_RUNNER_RULES))
    settings.jest = { globalPackage: 'bun:test' }
  }
  if (runnerRules && runner === 'vitest') {
    plugins.vitest = vitestPlugin as ESLint.Plugin
    Object.assign(configuredRules, rules('vitest', SHARED_RUNNER_RULES))
    configuredRules['vitest/valid-expect'] = ['error', { maxArgs: 2 }]
  }

  return new ESLint({
    allowInlineConfig: false,
    overrideConfigFile: true,
    overrideConfig: [
      {
        files: [`**/*.{${TEST_FILE_EXTENSIONS.join(',')}}`],
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
  // ESLint ignores an absolute file outside its process cwd. The content and
  // extension are all this config needs, so keep installed orch able to judge
  // a test in any registered project by linting under its basename.
  const lintFile = file.split(/[\\/]/).at(-1) ?? file
  if (runner !== 'bun') {
    const result = (await eslint(file, runner, true).lintText(content, { filePath: lintFile }))[0]!
    return {
      ...result,
      messages: result.messages.filter(
        (message) =>
          !(
            runner === 'vitest' &&
            message.ruleId === 'vitest/valid-expect' &&
            message.message.startsWith('Async assertions must be awaited')
          ),
      ),
    }
  }

  // The SonarJS pass for bun files replaces bun:test with vitest only in the module
  // specifier of import and export declarations, located through the parse, never by
  // a text search over the file.
  const source = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const replacements: Array<{ end: number; start: number }> = []
  function visit(node: ts.Node) {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier) &&
      node.moduleSpecifier.text === 'bun:test'
    ) {
      replacements.push({
        start: node.moduleSpecifier.getStart(source) + 1,
        end: node.moduleSpecifier.getEnd() - 1,
      })
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  let sonarContent = content
  for (const replacement of replacements.reverse()) {
    sonarContent = `${sonarContent.slice(0, replacement.start)}vitest${sonarContent.slice(replacement.end)}`
  }
  const [sonarResult] = await eslint(file, 'bun', true, false, false).lintText(sonarContent, {
    filePath: lintFile,
  })
  const [runnerResult] = await eslint(file, 'bun', false).lintText(content, { filePath: lintFile })
  return {
    ...runnerResult!,
    messages: [...sonarResult!.messages, ...runnerResult!.messages],
  }
}

export async function testSubstanceReport(file: string, content: string): Promise<SubstanceReport> {
  if (!isAbsolute(file)) throw new Error('test-substance requires an absolute test file path')
  const runner = runnerFor(file, content)
  if (runner === 'browser') return { findings: [], runner }
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
