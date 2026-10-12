// concern: enforcement-catalogue
/** Declares the stable mechanical-check vocabulary and its stack defaults. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'

export const ENFORCEMENT_POINTS = ['write', 'commit', 'gate', 'schedule'] as const
export type EnforcementPoint = (typeof ENFORCEMENT_POINTS)[number]
export type EnforcementScope = 'file' | 'project'
export type EnforcementToolchain = 'typescript' | 'php' | 'unknown'

export type MechanicalCheckDefault = {
  tool?: string
  points?: readonly EnforcementPoint[]
  blocking?: boolean
  limit?: number
  platform?: true
}

export type MechanicalCheckCategory = {
  id: string
  title: string
  scope: EnforcementScope
  allowsLimit?: true
  allowsCommit?: true
  general?: MechanicalCheckDefault
  typescript?: MechanicalCheckDefault | 'not-applicable'
  php?: MechanicalCheckDefault | 'not-applicable'
}

const category = <const Category extends MechanicalCheckCategory>(value: Category): Category =>
  value

export const MECHANICAL_CHECK_CATALOGUE = [
  category({
    id: 'naming',
    title: 'Naming conventions',
    scope: 'file',
    typescript: { tool: 'biome style/useNamingConvention' },
    php: { tool: 'phpcs naming sniffs' },
  }),
  category({ id: 'file-placement', title: 'File and class placement', scope: 'file' }),
  category({
    id: 'function-length',
    title: 'Function length',
    scope: 'file',
    allowsLimit: true,
    typescript: { tool: 'biome complexity/noExcessiveLinesPerFunction', limit: 50 },
    php: { tool: 'phpcs SlevomatCodingStandard.Functions.FunctionLength', limit: 50 },
  }),
  category({
    id: 'file-length',
    title: 'File length',
    scope: 'file',
    allowsLimit: true,
    typescript: { tool: 'biome style/noExcessiveLinesPerFile', limit: 1000 },
    php: { tool: 'phpcs SlevomatCodingStandard.Files.FileLength', limit: 300 },
  }),
  category({
    id: 'cognitive-complexity',
    title: 'Cognitive complexity',
    scope: 'file',
    allowsLimit: true,
    typescript: { tool: 'biome complexity/noExcessiveCognitiveComplexity', limit: 15 },
    php: { tool: 'phpcs SlevomatCodingStandard.Complexity.Cognitive', limit: 15 },
  }),
  category({
    id: 'forbidden-apis',
    title: 'Forbidden functions and APIs',
    scope: 'file',
    typescript: { tool: 'biome restricted-globals, types and imports rules' },
    php: { tool: 'phpcs Generic.PHP.ForbiddenFunctions' },
  }),
  category({
    id: 'unused-imports',
    title: 'Unused imports',
    scope: 'file',
    typescript: { tool: 'biome correctness/noUnusedImports' },
    php: { tool: 'phpcs SlevomatCodingStandard.Namespaces.UnusedUses' },
  }),
  category({
    id: 'unused-variables',
    title: 'Unused variables and parameters',
    scope: 'file',
    typescript: { tool: 'biome correctness/noUnusedVariables' },
    php: { tool: 'phpcs SlevomatCodingStandard.Variables.UnusedVariable' },
  }),
  category({
    id: 'unreachable-code',
    title: 'Unreachable code',
    scope: 'file',
    typescript: { tool: 'biome correctness/noUnreachable' },
    php: { tool: 'phpstan', points: ['gate'] },
  }),
  category({
    id: 'formatting',
    title: 'Formatting',
    scope: 'file',
    typescript: { tool: 'biome format' },
    php: { tool: 'php-cs-fixer' },
  }),
  category({
    id: 'final-classes',
    title: 'Final or abstract classes',
    scope: 'file',
    typescript: 'not-applicable',
    php: { tool: 'phpcs SlevomatCodingStandard.Classes.RequireAbstractOrFinal' },
  }),
  category({
    id: 'test-substance',
    title: 'Tests that assert nothing',
    scope: 'file',
    general: { tool: `${PLATFORM_SLUG} test-substance`, platform: true },
  }),
  category({ id: 'test-naming', title: 'Test naming and structure', scope: 'file' }),
  category({
    id: 'attribution-markers',
    title: 'No attribution markers',
    scope: 'file',
    general: { tool: `${PLATFORM_SLUG} no-attribution`, platform: true },
  }),
  category({
    id: 'comment-hygiene',
    title: 'Comment task keys and history',
    scope: 'file',
  }),
  category({ id: 'spelling', title: 'Spelling', scope: 'file' }),
  category({
    id: 'secrets',
    title: 'Secrets',
    scope: 'file',
    general: { tool: 'gitleaks', points: ['commit', 'gate'] },
  }),
  category({
    id: 'commit-message',
    title: 'Commit message format',
    scope: 'project',
    allowsCommit: true,
    general: { points: ['commit'] },
  }),
  category({
    id: 'import-boundaries',
    title: 'Import boundaries',
    scope: 'project',
    typescript: { tool: 'dependency-cruiser' },
    php: { tool: 'phpstan with phpat' },
  }),
  category({
    id: 'unused-exports',
    title: 'Unused exports and dead code',
    scope: 'project',
    typescript: { tool: 'knip' },
    php: { tool: 'shipmonk/dead-code-detector', points: ['schedule'], blocking: false },
  }),
  category({
    id: 'type-errors',
    title: 'Type errors',
    scope: 'project',
    typescript: { tool: 'tsc' },
    php: { tool: 'phpstan' },
  }),
  category({
    id: 'null-safety',
    title: 'Null safety',
    scope: 'project',
    typescript: { tool: 'tsc strict null checks' },
    php: { tool: 'phpstan' },
  }),
  category({ id: 'test-placement', title: 'Test placement', scope: 'project' }),
  category({ id: 'test-suite', title: 'The test suite passes', scope: 'project' }),
  category({ id: 'migrations', title: 'Migration rules', scope: 'project' }),
] as const satisfies readonly MechanicalCheckCategory[]

export const MECHANICAL_CHECK_CATEGORIES = new Map<string, MechanicalCheckCategory>(
  MECHANICAL_CHECK_CATALOGUE.map((entry) => [entry.id, entry]),
)

export function toolchainForStack(stack: string | null): EnforcementToolchain {
  if (stack === 'node' || stack?.startsWith('node-')) return 'typescript'
  if (stack?.startsWith('php')) return 'php'
  return 'unknown'
}
