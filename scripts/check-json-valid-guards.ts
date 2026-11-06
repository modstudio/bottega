import { type Node, parse } from 'sql-parser-cst'

type AstNode = Node & Record<string, unknown> & { range?: [number, number] }

export type UnsafeJsonGuard = {
  offset: number
  subject: string
}

function children(node: AstNode): AstNode[] {
  return Object.entries(node).flatMap(([key, value]) => {
    if (key === 'leading' || key === 'trailing' || key === 'range') return []
    if (Array.isArray(value)) return value.filter(isNode)
    return isNode(value) ? [value] : []
  })
}

function isNode(value: unknown): value is AstNode {
  return Boolean(value && typeof value === 'object' && 'type' in value)
}

function identifierName(node: unknown): string | null {
  if (!isNode(node) || node.type !== 'identifier') return null
  return String(node.name).toLowerCase()
}

function functionArguments(node: AstNode): AstNode[] {
  if (node.type !== 'func_call') return []
  const parens = node.args
  if (!isNode(parens)) return []
  const functionArgs = parens.expr
  if (!isNode(functionArgs)) return []
  const args = functionArgs.args
  if (!isNode(args)) return []
  if (args.type === 'list_expr' && Array.isArray(args.items))
    return (args.items as unknown[]).filter(isNode)
  return [args]
}

function expressionKey(node: AstNode): string {
  if (node.type === 'identifier') return `identifier:${String(node.name).toLowerCase()}`
  return JSON.stringify(node, (key, value) => {
    if (key === 'leading' || key === 'trailing' || key === 'range' || key === 'text')
      return undefined
    if (key === 'name' && typeof value === 'string') return value.toLowerCase()
    return value
  })
}

function jsonSubject(node: AstNode, expectedName?: string): string | null {
  if (node.type !== 'func_call') return null
  const name = identifierName(node.name)
  if (!name || (expectedName ? name !== expectedName : !name.startsWith('json_'))) return null
  if (!expectedName && name === 'json_valid') return null
  const subject = functionArguments(node)[0]
  return subject ? expressionKey(subject) : null
}

function operatorName(node: AstNode): string | null {
  if (typeof node.operator === 'string') return node.operator.toUpperCase()
  if (isNode(node.operator))
    return String(node.operator.name ?? node.operator.text ?? '').toUpperCase()
  return null
}

function guaranteedValidSubjects(node: AstNode): Set<string> {
  const direct = jsonSubject(node, 'json_valid')
  if (direct) return new Set([direct])
  if (node.type === 'paren_expr' && isNode(node.expr)) return guaranteedValidSubjects(node.expr)
  if (node.type === 'binary_expr' && operatorName(node) === 'AND') {
    const result = new Set<string>()
    if (isNode(node.left))
      for (const subject of guaranteedValidSubjects(node.left)) result.add(subject)
    if (isNode(node.right))
      for (const subject of guaranteedValidSubjects(node.right)) result.add(subject)
    return result
  }
  return new Set()
}

type TraversalBranch = { node: AstNode; protectedSubjects: ReadonlySet<string> }

function traversalBranches(
  node: AstNode,
  protectedSubjects: ReadonlySet<string>,
): TraversalBranch[] {
  if (node.type !== 'case_expr' || !Array.isArray(node.clauses))
    return children(node).map((child) => ({ node: child, protectedSubjects }))
  const branches: TraversalBranch[] = []
  for (const clause of node.clauses.filter(isNode)) {
    if (clause.type === 'case_when' && isNode(clause.condition) && isNode(clause.result)) {
      branches.push({ node: clause.condition, protectedSubjects })
      const branchSubjects = new Set(protectedSubjects)
      for (const guarded of guaranteedValidSubjects(clause.condition)) branchSubjects.add(guarded)
      branches.push({ node: clause.result, protectedSubjects: branchSubjects })
    } else if (isNode(clause.result)) {
      branches.push({ node: clause.result, protectedSubjects })
    }
  }
  return branches
}

function collectDangerousSubjects(
  node: AstNode,
  protectedSubjects: ReadonlySet<string>,
  result: Set<string>,
): void {
  const subject = jsonSubject(node)
  if (subject && !protectedSubjects.has(subject)) result.add(subject)
  for (const branch of traversalBranches(node, protectedSubjects))
    collectDangerousSubjects(branch.node, branch.protectedSubjects, result)
}

function dangerousSubjects(node: AstNode, protectedSubjects: ReadonlySet<string>): Set<string> {
  const result = new Set<string>()
  collectDangerousSubjects(node, protectedSubjects, result)
  return result
}

function andOperandIssues(
  node: AstNode,
  protectedSubjects: ReadonlySet<string>,
): UnsafeJsonGuard[] {
  if (
    node.type !== 'binary_expr' ||
    operatorName(node) !== 'AND' ||
    !isNode(node.left) ||
    !isNode(node.right)
  )
    return []
  const leftValid = guaranteedValidSubjects(node.left)
  const rightValid = guaranteedValidSubjects(node.right)
  const leftDangerous = dangerousSubjects(node.left, protectedSubjects)
  const rightDangerous = dangerousSubjects(node.right, protectedSubjects)
  return [
    ...[...leftValid]
      .filter((subject) => rightDangerous.has(subject))
      .map((subject) => ({ offset: node.range?.[0] ?? 0, subject })),
    ...[...rightValid]
      .filter((subject) => leftDangerous.has(subject))
      .map((subject) => ({ offset: node.range?.[0] ?? 0, subject })),
  ]
}

function collectMatchingSubjects(
  node: AstNode,
  names: ReadonlySet<string>,
  subjects: Map<string, number>,
  root = true,
): void {
  if (!root && node.type === 'select_stmt') return
  if (node.type === 'func_call') {
    const name = identifierName(node.name)
    if (name && names.has(name)) {
      const subject = jsonSubject(node, name)
      if (subject) subjects.set(subject, node.range?.[0] ?? 0)
    }
  }
  for (const child of children(node)) collectMatchingSubjects(child, names, subjects, false)
}

function tableValuedJsonIssues(node: AstNode): UnsafeJsonGuard[] {
  if (node.type !== 'select_stmt' || !Array.isArray(node.clauses)) return []
  const clauses = (node.clauses as unknown[]).filter(isNode)
  const from = clauses.find((clause) => clause.type === 'from_clause')
  if (!from) return []

  const tableReads = new Map<string, number>()
  collectMatchingSubjects(from, new Set(['json_each', 'json_tree']), tableReads)
  if (tableReads.size === 0) return []

  const guards = new Map<string, number>()
  for (const clause of clauses)
    if (clause.type === 'where_clause')
      collectMatchingSubjects(clause, new Set(['json_valid']), guards)
  const collectJoinGuards = (candidate: AstNode, root = true): void => {
    if (!root && candidate.type === 'select_stmt') return
    if (candidate.type === 'join_on_specification')
      collectMatchingSubjects(candidate, new Set(['json_valid']), guards)
    for (const child of children(candidate)) collectJoinGuards(child, false)
  }
  collectJoinGuards(from)

  return [...tableReads]
    .filter(([subject]) => guards.has(subject))
    .map(([subject, offset]) => ({ subject, offset }))
}

function inspect(node: AstNode, protectedSubjects: ReadonlySet<string>, issues: UnsafeJsonGuard[]) {
  issues.push(...andOperandIssues(node, protectedSubjects))
  issues.push(...tableValuedJsonIssues(node))
  for (const branch of traversalBranches(node, protectedSubjects))
    inspect(branch.node, branch.protectedSubjects, issues)
}

/** Finds JSON reads whose safety relies on SQLite evaluating an AND operand first. */
export function detectUnsafeJsonGuards(sql: string): UnsafeJsonGuard[] {
  if (!/json_valid/i.test(sql) || !/json_(?!valid\b)[a-z_]+/i.test(sql)) return []
  const program = parse(sql, { dialect: 'sqlite', includeRange: true, paramTypes: ['?'] })
  const issues: UnsafeJsonGuard[] = []
  for (const statement of program.statements as AstNode[]) {
    if (/^(?:create|alter|drop)_/.test(statement.type)) continue
    inspect(statement, new Set(), issues)
  }
  return issues.filter(
    (issue, index) =>
      issues.findIndex(
        (candidate) => candidate.offset === issue.offset && candidate.subject === issue.subject,
      ) === index,
  )
}
