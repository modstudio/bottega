import {
  applyTestWaivers,
  OUTSIDE_TEST,
  PHP_POLICY_RULES,
  PHP_UNIVERSAL_RULES,
  type PhpPolicyRule,
  type PhpRule,
  type TestFinding,
  type TestWaiver,
} from './test-substance'

type TestMethod = {
  declaration: number
  declarationLine: number
  end: number
  name: string
  start: number
}

export type PhpSubstanceReport = {
  findings: TestFinding[]
  runner: 'php'
}

type LineRule = { rule: PhpRule; pattern: RegExp; message: string }

const LINE_RULES = [
  {
    rule: 'createMock',
    pattern: /\bcreateMock\s*\(/g,
    message:
      'createMock() is forbidden because it leads to interaction tests; use a stub, real object, or fake and assert an observable effect.',
  },
  {
    rule: 'mock-builder',
    pattern: /\bgetMockBuilder\s*\(/g,
    message:
      'getMockBuilder() is forbidden interaction-test machinery; use a stub, real object, or fake and assert an observable effect.',
  },
  {
    rule: 'self-equal-assertion',
    pattern: /\bassert(?:Same|Equals)\s*\(\s*([^,()]+?)\s*,\s*\1\s*[,)]/g,
    message: 'Both assertion arguments are the same expression, so the assertion cannot fail.',
  },
  {
    rule: 'tautology',
    pattern: /\bassert(?:True|False)\s*\(\s*(?:true|false)\s*[,)]/gi,
    message: 'A literal boolean assertion proves nothing; assert the observable effect.',
  },
  {
    rule: 'skipped',
    pattern: /\bmarkTest(?:Skipped|Incomplete)\s*\(/g,
    message: 'A skipped or incomplete test guards nothing; make it deterministic or delete it.',
  },
  {
    rule: 'no-assertions',
    pattern: /\bexpectNotToPerformAssertions\s*\(/g,
    message: 'expectNotToPerformAssertions() declares that the test guards nothing.',
  },
  {
    rule: 'refresh-database',
    pattern: /\b(?:use\s+)?(?:Illuminate\\Foundation\\Testing\\)?RefreshDatabase\b/g,
    message:
      'RefreshDatabase is forbidden because migrate:fresh can wipe the main database; use DatabaseTransactions instead.',
  },
  {
    rule: 'sql-string-matching',
    pattern: /->\s*(?:toSql|getBindings)\s*\(/g,
    message:
      'Asserting on toSql() or getBindings() restates query-builder code; seed rows and assert real query results.',
  },
] as const satisfies readonly LineRule[]

const lineRulesByName = new Map(LINE_RULES.map((rule) => [rule.rule, rule]))

const policyRules = new Set<string>(PHP_POLICY_RULES)
const universalRules = new Set<string>(PHP_UNIVERSAL_RULES)

function lineStarts(content: string): number[] {
  const starts = [0]
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] === '\n') starts.push(index + 1)
  }
  return starts
}

function lineAt(starts: number[], offset: number): number {
  let low = 0
  let high = starts.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (starts[middle]! <= offset) low = middle + 1
    else high = middle
  }
  return low
}

function commentLine(content: string): boolean {
  const trimmed = content.trimStart()
  return (
    trimmed === '' ||
    trimmed.startsWith('//') ||
    trimmed.startsWith('#') ||
    trimmed.startsWith('*') ||
    trimmed.startsWith('/*')
  )
}

function quotedTokenEnd(content: string, start: number): number {
  const quote = content[start]
  for (let index = start + 1; index < content.length; index += 1) {
    if (content[index] === '\\') index += 1
    else if (content[index] === quote) return index + 1
  }
  return content.length
}

function heredocTokenEnd(content: string, start: number): number | undefined {
  const opening = content.slice(start).match(/^<<<['"]?([A-Za-z_]\w*)['"]?\r?\n/)
  if (!opening) return undefined
  const bodyStart = start + opening[0].length
  const closing = content.slice(bodyStart).match(new RegExp(`^\\s*${opening[1]};?\\r?$`, 'm'))
  return closing ? bodyStart + closing.index! + closing[0].length : content.length
}

function lineTokenEnd(content: string, start: number): number {
  const end = content.indexOf('\n', start)
  return end < 0 ? content.length : end
}

function maskedTokenEnd(content: string, start: number): number | undefined {
  const current = content[start]
  const next = content[start + 1]
  if (current === "'" || current === '"') return quotedTokenEnd(content, start)
  if (current === '/' && next === '/') return lineTokenEnd(content, start + 2)
  if (current === '#' && next !== '[') return lineTokenEnd(content, start + 1)
  if (current === '/' && next === '*') {
    const end = content.indexOf('*/', start + 2)
    return end < 0 ? content.length : end + 2
  }
  if (current === '<' && next === '<' && content[start + 2] === '<') {
    return heredocTokenEnd(content, start)
  }
  return undefined
}

function maskToken(chars: string[], start: number, end: number): void {
  for (let index = start; index < end; index += 1) {
    if (chars[index] !== '\n' && chars[index] !== '\r') chars[index] = ' '
  }
}

/** Mask tokens which must not influence class and brace discovery, preserving offsets and lines. */
function structuralContent(content: string): string {
  const chars = content.split('')
  for (let index = 0; index < chars.length; index += 1) {
    const end = maskedTokenEnd(content, index)
    if (end === undefined) continue
    maskToken(chars, index, end)
    index = Math.max(index, end - 1)
  }
  return chars.join('')
}

function closingBrace(content: string, open: number): number | undefined {
  let depth = 0
  for (let index = open; index < content.length; index += 1) {
    if (content[index] === '{') depth += 1
    if (content[index] === '}' && --depth === 0) return index
  }
  return undefined
}

function typeRanges(structural: string): Array<{ start: number; end: number }> {
  const result: Array<{ start: number; end: number }> = []
  for (const match of structural.matchAll(/\b(?:class|trait)\s+[A-Za-z_]\w*[^{;]*\{/g)) {
    const open = match.index + match[0].lastIndexOf('{')
    const end = closingBrace(structural, open)
    if (end !== undefined) result.push({ start: open, end })
  }
  return result
}

function decorationStart(content: string, declaration: number): number {
  let start = declaration
  while (start > 0) {
    let cursor = start
    while (cursor > 0 && /\s/.test(content[cursor - 1]!)) cursor -= 1
    if (content.slice(cursor - 2, cursor) === '*/') {
      const opening = content.lastIndexOf('/*', cursor - 2)
      if (opening < 0) break
      start = opening
      continue
    }
    if (content[cursor - 1] !== ']') break
    let depth = 0
    let opening = cursor - 1
    for (; opening >= 0; opening -= 1) {
      if (content[opening] === ']') depth += 1
      else if (content[opening] === '[' && --depth === 0) break
    }
    if (opening < 1 || content[opening - 1] !== '#') break
    start = opening - 1
  }
  return start
}

function isTestMethod(name: string, decoration: string): boolean {
  return (
    name.startsWith('test') ||
    /#\[[\s\S]*?\b(?:PHPUnit\\Framework\\Attributes\\)?Test\b[\s\S]*?\]/.test(decoration) ||
    /\/\*[\s\S]*?@test\b[\s\S]*?\*\//i.test(decoration)
  )
}

function nextPosition(positions: number[], after: number): number | undefined {
  let low = 0
  let high = positions.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (positions[middle]! < after) low = middle + 1
    else high = middle
  }
  return positions[low]
}

function testMethods(content: string, starts: number[]): TestMethod[] {
  const structural = structuralContent(content)
  const types = typeRanges(structural)
  const methods: TestMethod[] = []
  const declarations = [
    ...structural.matchAll(/\bpublic\s+(?:static\s+)?function\s+([A-Za-z_]\w*)/g),
  ]
  const boundaries = [...structural.matchAll(/[{;]/g)].map((match) => match.index)
  let typeIndex = 0
  for (let index = 0; index < declarations.length; index += 1) {
    const match = declarations[index]!
    const declaration = match.index
    while (types[typeIndex] && types[typeIndex]!.end < declaration) typeIndex += 1
    const type = types[typeIndex]
    if (!type || declaration <= type.start || declaration >= type.end) continue
    const afterName = declaration + match[0].length
    const open = nextPosition(boundaries, afterName)
    const nextDeclaration = declarations[index + 1]?.index
    if (
      open === undefined ||
      structural[open] !== '{' ||
      (nextDeclaration !== undefined && nextDeclaration < open)
    ) {
      continue
    }
    const signature = structural.slice(afterName, open)
    if (!/^\s*\([\s\S]*\)\s*(?::[^;{}]+)?\s*$/.test(signature)) continue
    const end = closingBrace(structural, open)
    if (end === undefined) continue
    const start = decorationStart(content, declaration)
    const name = match[1]!
    if (!isTestMethod(name, content.slice(start, declaration))) continue
    methods.push({
      start,
      end,
      declaration,
      declarationLine: lineAt(starts, declaration),
      name,
    })
  }
  return methods
}

function enclosingMethod(methods: TestMethod[], offset: number): TestMethod | undefined {
  let low = 0
  let high = methods.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (methods[middle]!.start <= offset) low = middle + 1
    else high = middle
  }
  const candidate = methods[low - 1]
  return candidate && offset <= candidate.end ? candidate : undefined
}

function finding(
  file: string,
  starts: number[],
  methods: TestMethod[],
  offset: number,
  rule: string,
  message: string,
): TestFinding {
  return {
    file,
    line: lineAt(starts, offset),
    rule,
    testName: enclosingMethod(methods, offset)?.name ?? OUTSIDE_TEST,
    message,
  }
}

function lineRuleEnabled(rule: string, enabledPolicyRules: ReadonlySet<PhpPolicyRule>): boolean {
  return universalRules.has(rule) || enabledPolicyRules.has(rule as PhpPolicyRule)
}

function splitSqlFinding(
  file: string,
  starts: number[],
  methods: TestMethod[],
  offset: number,
  line: string,
  previous: string | undefined,
  enabledPolicyRules: ReadonlySet<PhpPolicyRule>,
): TestFinding | undefined {
  if (!enabledPolicyRules.has('sql-string-matching')) return undefined
  if (!/^\s*(?:toSql|getBindings)\s*\(/.test(line) || !/->\s*$/.test(previous ?? '')) {
    return undefined
  }
  return finding(
    file,
    starts,
    methods,
    offset,
    'sql-string-matching',
    lineRulesByName.get('sql-string-matching')!.message,
  )
}

function directLineFindings(
  file: string,
  starts: number[],
  methods: TestMethod[],
  offset: number,
  line: string,
  enabledPolicyRules: ReadonlySet<PhpPolicyRule>,
): TestFinding[] {
  const findings: TestFinding[] = []
  for (const rule of LINE_RULES) {
    if (!lineRuleEnabled(rule.rule, enabledPolicyRules)) continue
    rule.pattern.lastIndex = 0
    for (const match of line.matchAll(rule.pattern)) {
      findings.push(finding(file, starts, methods, offset + match.index, rule.rule, rule.message))
    }
  }
  return findings
}

function lineFindings(
  file: string,
  content: string,
  starts: number[],
  methods: TestMethod[],
  enabledPolicyRules: ReadonlySet<PhpPolicyRule>,
): TestFinding[] {
  const findings: TestFinding[] = []
  const lines = content.split('\n')
  let offset = 0
  let previous: string | undefined
  for (const line of lines) {
    if (!commentLine(line)) {
      findings.push(...directLineFindings(file, starts, methods, offset, line, enabledPolicyRules))
      const splitFinding = splitSqlFinding(
        file,
        starts,
        methods,
        offset,
        line,
        previous,
        enabledPolicyRules,
      )
      if (splitFinding) findings.push(splitFinding)
      previous = line
    }
    offset += line.length + 1
  }
  return findings
}

type Assertion = { kind: 'type-only' | 'constant' | 'real'; name: string }

// Only known PHPUnit assertions receive argument-based classification. An assert-prefixed
// method outside this list may be a project helper which performs the actual SUT assertion.
const PHPUNIT_VALUE_ASSERTIONS = new Set([
  'assertArrayHasKey',
  'assertArrayNotHasKey',
  'assertContains',
  'assertContainsEquals',
  'assertContainsOnly',
  'assertContainsOnlyInstancesOf',
  'assertCount',
  'assertEmpty',
  'assertEquals',
  'assertEqualsCanonicalizing',
  'assertEqualsIgnoringCase',
  'assertEqualsWithDelta',
  'assertFalse',
  'assertFileEquals',
  'assertFileEqualsCanonicalizing',
  'assertFileEqualsIgnoringCase',
  'assertFileExists',
  'assertFileIsReadable',
  'assertFileIsWritable',
  'assertFileMatchesFormat',
  'assertFileMatchesFormatFile',
  'assertFileNotEquals',
  'assertFileNotEqualsCanonicalizing',
  'assertFileNotEqualsIgnoringCase',
  'assertFileNotExists',
  'assertFileNotIsReadable',
  'assertFileNotIsWritable',
  'assertFinite',
  'assertGreaterThan',
  'assertGreaterThanOrEqual',
  'assertInfinite',
  'assertIsArray',
  'assertIsBool',
  'assertIsCallable',
  'assertIsClosedResource',
  'assertIsFloat',
  'assertIsInt',
  'assertIsIterable',
  'assertIsNumeric',
  'assertIsObject',
  'assertIsReadable',
  'assertIsResource',
  'assertIsScalar',
  'assertIsString',
  'assertIsWritable',
  'assertJson',
  'assertJsonFileEqualsJsonFile',
  'assertJsonStringEqualsJsonFile',
  'assertJsonStringEqualsJsonString',
  'assertLessThan',
  'assertLessThanOrEqual',
  'assertMatchesRegularExpression',
  'assertNan',
  'assertNotContains',
  'assertNotContainsEquals',
  'assertNotEmpty',
  'assertNotEquals',
  'assertNotEqualsCanonicalizing',
  'assertNotEqualsIgnoringCase',
  'assertNotEqualsWithDelta',
  'assertNotFalse',
  'assertNotInfinite',
  'assertNotNan',
  'assertNotSame',
  'assertNotTrue',
  'assertNull',
  'assertObjectHasProperty',
  'assertObjectNotHasProperty',
  'assertSame',
  'assertStringContainsString',
  'assertStringContainsStringIgnoringCase',
  'assertStringEndsNotWith',
  'assertStringEndsWith',
  'assertStringEqualsFile',
  'assertStringEqualsFileCanonicalizing',
  'assertStringEqualsFileIgnoringCase',
  'assertStringMatchesFormat',
  'assertStringMatchesFormatFile',
  'assertStringNotContainsString',
  'assertStringNotContainsStringIgnoringCase',
  'assertStringNotEqualsFile',
  'assertStringNotEqualsFileCanonicalizing',
  'assertStringNotEqualsFileIgnoringCase',
  'assertStringNotMatchesFormat',
  'assertStringNotMatchesFormatFile',
  'assertStringStartsNotWith',
  'assertStringStartsWith',
  'assertTrue',
])

function callArguments(line: string, from: number): string | undefined {
  const open = line.indexOf('(', from)
  if (open < 0) return undefined
  let depth = 0
  for (let index = open; index < line.length; index += 1) {
    if (line[index] === '(') depth += 1
    else if (line[index] === ')' && --depth === 0) return line.slice(open + 1, index)
  }
  return undefined
}

function assertionReceiver(prefix: string): 'phpunit' | 'other' | 'none' {
  if (
    /(?:\$this\s*(?:->|::)|(?:self|static|parent)\s*::|(?:\\?[A-Za-z_]\w*\\)*Assert\s*::)\s*$/.test(
      prefix,
    )
  ) {
    return 'phpunit'
  }
  return /(?:->|::)\s*$/.test(prefix) ? 'other' : 'none'
}

function classifyAssertion(line: string, match: RegExpMatchArray): Assertion {
  const name = match[1]!
  const prefix = line.slice(0, match.index).trimEnd()
  const receiver = assertionReceiver(prefix)
  if (name.startsWith('expects') || name.startsWith('should')) {
    return { name, kind: receiver === 'none' ? 'constant' : 'real' }
  }
  if (name.startsWith('expectException')) {
    return { name, kind: receiver === 'phpunit' ? 'real' : 'constant' }
  }
  const phpunitAssertion =
    name === 'assertInstanceOf' || name === 'assertNotNull' || PHPUNIT_VALUE_ASSERTIONS.has(name)
  if (receiver === 'other' || !phpunitAssertion) return { name, kind: 'real' }
  if (name === 'assertInstanceOf' || name === 'assertNotNull') return { name, kind: 'type-only' }
  const args = callArguments(line, match.index! + match[0].indexOf(name) + name.length)
  return {
    name,
    kind: args !== undefined && !/[$(]|::/.test(args) ? 'constant' : 'real',
  }
}

function assertions(body: string): Assertion[] {
  const result: Assertion[] = []
  for (const line of body.split('\n')) {
    if (commentLine(line)) continue
    for (const match of line.matchAll(
      /\b((?:assert|expects|should)[A-Z]\w*|expectException\w*)\s*\(/g,
    )) {
      result.push(classifyAssertion(line, match))
    }
  }
  return result
}

function methodSubstanceRule(
  items: Assertion[],
  enabledPolicyRules: ReadonlySet<PhpPolicyRule>,
): 'type-only-test' | 'vacuous-test' | undefined {
  if (items.length === 0 || items.some((item) => item.kind === 'real')) return undefined
  if (items.every((item) => item.kind === 'constant')) return 'vacuous-test'
  if (
    enabledPolicyRules.has('type-only-test') &&
    items.some((item) => item.name === 'assertInstanceOf')
  ) {
    return 'type-only-test'
  }
  return undefined
}

function methodSubstanceFindings(
  file: string,
  content: string,
  methods: TestMethod[],
  enabledPolicyRules: ReadonlySet<PhpPolicyRule>,
): TestFinding[] {
  return methods.flatMap((method) => {
    const rule = methodSubstanceRule(
      assertions(content.slice(method.start, method.end)),
      enabledPolicyRules,
    )
    if (!rule) return []
    return [
      {
        file,
        line: method.declarationLine,
        rule,
        testName: method.name,
        message:
          rule === 'type-only-test'
            ? 'The method checks only result types; assert the computed value or observable effect.'
            : 'Every assertion is constant-only; assert the computed value or observable effect.',
      },
    ]
  })
}

function waivers(
  file: string,
  content: string,
  starts: number[],
  methods: TestMethod[],
): TestWaiver[] {
  const lines = content.split('\n')
  const result: TestWaiver[] = []
  for (const method of methods) {
    const regionStart = decorationStart(content, method.declaration)
    const lineBefore = lineAt(starts, regionStart) - 1
    const match = (lines[lineBefore - 1] ?? '').match(
      /^\s*\/\/\s*test-substance-allow:\s+(\S+)(?:\s+(.*?))?\s*$/,
    )
    if (!match) continue
    result.push({
      file,
      line: lineBefore,
      testName: method.name,
      rule: match[1]!,
      reason: match[2]?.trim() ?? '',
    })
  }
  return result
}

/**
 * Report all PHP test-substance findings in whole-file content.
 *
 * This scanner is intentionally not a PHP parser. It masks strings, comments, and heredocs
 * while matching braces and public method declarations by bounded patterns. It does not model
 * PHP grammar, interpolation, dynamic declarations, or malformed nesting. Line rules preserve
 * the reference guard's raw-line behaviour, so trailing comments and strings can still match.
 */
export async function phpTestSubstanceReport(
  file: string,
  content: string,
  enabledPolicyRules: readonly PhpPolicyRule[] = [],
): Promise<PhpSubstanceReport> {
  const starts = lineStarts(content)
  const methods = testMethods(content, starts)
  const enabled = new Set(enabledPolicyRules)
  const findings = [
    ...lineFindings(file, content, starts, methods, enabled),
    ...methodSubstanceFindings(file, content, methods, enabled),
  ]
  const applicableWaivers = waivers(file, content, starts, methods).filter(
    (waiver) => !policyRules.has(waiver.rule) || enabled.has(waiver.rule as PhpPolicyRule),
  )
  return { findings: applyTestWaivers(findings, applicableWaivers), runner: 'php' }
}
