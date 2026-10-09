import { applyTestWaivers, OUTSIDE_TEST, type TestFinding, type TestWaiver } from './test-substance'

type TestMethod = {
  bodyEnd: number
  declarationLine: number
  end: number
  name: string
  start: number
}

export type PhpSubstanceReport = {
  findings: TestFinding[]
  runner: 'php'
}

const RULES = [
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
] as const

export const PHP_GUARDED_RULES = [...RULES.map(({ rule }) => rule), 'vacuous-test', 'unused-waiver']

function lineAt(content: string, offset: number): number {
  let line = 1
  for (let index = 0; index < offset; index += 1) if (content[index] === '\n') line += 1
  return line
}

function offsetAtLine(content: string, wanted: number): number {
  let line = 1
  let offset = 0
  while (line < wanted) {
    offset = content.indexOf('\n', offset) + 1
    line += 1
  }
  return offset
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

/** Mask tokens which must not influence class and brace discovery, preserving offsets and lines. */
function structuralContent(content: string): string {
  const chars = [...content]
  let state: 'code' | 'single' | 'double' | 'line' | 'block' | 'heredoc' = 'code'
  let heredocEnd = ''
  for (let index = 0; index < chars.length; index += 1) {
    const current = chars[index]!
    const next = chars[index + 1]
    if (state === 'code') {
      const heredoc = content.slice(index).match(/^<<<['"]?([A-Za-z_]\w*)['"]?\r?\n/)
      if (heredoc) {
        heredocEnd = heredoc[1]!
        state = 'heredoc'
      } else if (current === "'") state = 'single'
      else if (current === '"') state = 'double'
      else if (current === '/' && next === '/') state = 'line'
      else if (current === '#' && next !== '[') state = 'line'
      else if (current === '/' && next === '*') state = 'block'
      else continue
    } else if (state === 'single' || state === 'double') {
      if (current === '\\') {
        chars[index] = ' '
        if (chars[index + 1] !== '\n') chars[index + 1] = ' '
        index += 1
        continue
      }
      if ((state === 'single' && current === "'") || (state === 'double' && current === '"')) {
        chars[index] = ' '
        state = 'code'
        continue
      }
    } else if (state === 'line') {
      if (current === '\n') {
        state = 'code'
        continue
      }
    } else if (state === 'block') {
      if (current === '*' && next === '/') {
        chars[index] = ' '
        chars[index + 1] = ' '
        index += 1
        state = 'code'
        continue
      }
    } else if (state === 'heredoc' && current === '\n') {
      const following = content.slice(index + 1).match(/^\s*([A-Za-z_]\w*);?\r?(?=\n|$)/)
      if (following?.[1] === heredocEnd) state = 'code'
    }
    if (current !== '\n' && current !== '\r') chars[index] = ' '
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

function classRanges(structural: string): Array<{ start: number; end: number }> {
  const result: Array<{ start: number; end: number }> = []
  for (const match of structural.matchAll(/\bclass\s+[A-Za-z_]\w*[^{;]*\{/g)) {
    const open = match.index + match[0].lastIndexOf('{')
    const end = closingBrace(structural, open)
    if (end !== undefined) result.push({ start: open, end })
  }
  return result
}

function decorationStart(content: string, declaration: number): number {
  const prefix = content.slice(0, declaration)
  const decorated = prefix.match(/(?:\/\*[\s\S]*?\*\/\s*|#\[[\s\S]*?\]\s*)+$/)
  return decorated ? declaration - decorated[0].length : declaration
}

function isTestMethod(name: string, decoration: string): boolean {
  return (
    name.startsWith('test') ||
    /#\[[\s\S]*?\b(?:PHPUnit\\Framework\\Attributes\\)?Test\b[\s\S]*?\]/.test(decoration) ||
    /\/\*[\s\S]*?@test\b[\s\S]*?\*\//i.test(decoration)
  )
}

function testMethods(content: string): TestMethod[] {
  const structural = structuralContent(content)
  const classes = classRanges(structural)
  const methods: TestMethod[] = []
  const signature =
    /\bpublic\s+(?:static\s+)?function\s+([A-Za-z_]\w*)\s*\([\s\S]*?\)\s*(?::[^{;]+)?\s*\{/g
  for (const match of structural.matchAll(signature)) {
    const declaration = match.index
    if (!classes.some((range) => range.start < declaration && declaration < range.end)) continue
    const open = declaration + match[0].lastIndexOf('{')
    const end = closingBrace(structural, open)
    if (end === undefined) continue
    const start = decorationStart(content, declaration)
    const name = match[1]!
    if (!isTestMethod(name, content.slice(start, declaration))) continue
    methods.push({
      start,
      end,
      bodyEnd: end,
      declarationLine: lineAt(content, declaration),
      name,
    })
  }
  return methods
}

function enclosingMethod(methods: TestMethod[], offset: number): TestMethod | undefined {
  return methods.find((method) => method.start <= offset && offset <= method.end)
}

function finding(
  file: string,
  content: string,
  methods: TestMethod[],
  offset: number,
  rule: string,
  message: string,
): TestFinding {
  return {
    file,
    line: lineAt(content, offset),
    rule,
    testName: enclosingMethod(methods, offset)?.name ?? OUTSIDE_TEST,
    message,
  }
}

function lineFindings(file: string, content: string, methods: TestMethod[]): TestFinding[] {
  const findings: TestFinding[] = []
  const lines = content.split('\n')
  let offset = 0
  let previous: { content: string; offset: number } | undefined
  for (const line of lines) {
    if (!commentLine(line)) {
      for (const rule of RULES) {
        rule.pattern.lastIndex = 0
        for (const match of line.matchAll(rule.pattern)) {
          findings.push(
            finding(file, content, methods, offset + match.index, rule.rule, rule.message),
          )
        }
      }
      if (/^\s*(?:toSql|getBindings)\s*\(/.test(line) && /->\s*$/.test(previous?.content ?? '')) {
        findings.push(
          finding(file, content, methods, offset, 'sql-string-matching', RULES.at(-1)!.message),
        )
      }
      previous = { content: line, offset }
    }
    offset += line.length + 1
  }
  return findings
}

type Assertion = { kind: 'type-only' | 'constant' | 'real'; name: string }

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

function assertions(body: string): Assertion[] {
  const result: Assertion[] = []
  for (const line of body.split('\n')) {
    if (commentLine(line)) continue
    for (const match of line.matchAll(/(?:self::|static::|\$this->)?(assert[A-Z]\w*)\s*\(/g)) {
      const name = match[1]!
      if (name === 'assertInstanceOf' || name === 'assertNotNull') {
        result.push({ name, kind: 'type-only' })
        continue
      }
      const args = callArguments(line, match.index + match[0].indexOf(name) + name.length)
      result.push({
        name,
        kind: args !== undefined && !/[$(]|::/.test(args) ? 'constant' : 'real',
      })
    }
  }
  return result
}

function isVacuous(items: Assertion[]): boolean {
  if (items.length === 0 || items.some((item) => item.kind === 'real')) return false
  const hasInstanceOf = items.some((item) => item.name === 'assertInstanceOf')
  const allConstant = items.every((item) => item.kind === 'constant')
  return hasInstanceOf || allConstant
}

function vacuousFindings(file: string, content: string, methods: TestMethod[]): TestFinding[] {
  return methods.flatMap((method) =>
    isVacuous(assertions(content.slice(method.start, method.bodyEnd)))
      ? [
          {
            file,
            line: method.declarationLine,
            rule: 'vacuous-test',
            testName: method.name,
            message:
              'No assertion references a SUT-produced value; assert the computed value or observable effect.',
          },
        ]
      : [],
  )
}

function waivers(file: string, content: string, methods: TestMethod[]): TestWaiver[] {
  const lines = content.split('\n')
  const result: TestWaiver[] = []
  for (const method of methods) {
    const declarationOffset = offsetAtLine(content, method.declarationLine)
    const regionStart = decorationStart(content, declarationOffset)
    const lineBefore = lineAt(content, regionStart) - 1
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

/** Report all PHP test-substance findings in whole-file content. */
export async function phpTestSubstanceReport(
  file: string,
  content: string,
): Promise<PhpSubstanceReport> {
  const methods = testMethods(content)
  const findings = [
    ...lineFindings(file, content, methods),
    ...vacuousFindings(file, content, methods),
  ]
  return { findings: applyTestWaivers(findings, waivers(file, content, methods)), runner: 'php' }
}
