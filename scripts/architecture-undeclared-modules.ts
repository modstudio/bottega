/**
 * The source roots whose files must belong to a manifest module. Membership is keyed on the
 * file's location rather than on a `// concern: <slug>` header, so a file whose imports no
 * module rule declares cannot hide behind the header's wording or its absence.
 */
export const DECLARED_SOURCE_ROOTS = ['orchestrator/src', 'hub/src'] as const

const TEST_DIRECTORY = /(^|\/)tests?\//
const TEST_FILE = /\.(?:test|spec)\.[cm]?tsx?$/
const BASELINE_DECLARATION = /export const undeclaredModulesBaseline: readonly string\[\] = \[/
const BASELINE_ENTRY = /^\s*'([^']+)',\s*$/

/** Test files and test folders are not judged by the manifest. */
export function isProductionSourceFile(path: string) {
  return !TEST_DIRECTORY.test(path) && !TEST_FILE.test(path)
}

/**
 * The frozen baseline as it stood in another revision, read as text. The shape is asserted
 * rather than assumed: text that is not the frozen list refuses, instead of reporting every
 * baselined file as newly frozen.
 */
export function parseUndeclaredModulesBaseline(text: string): string[] {
  if (!BASELINE_DECLARATION.test(text)) {
    throw new Error('the base undeclared-modules baseline is not the frozen list module')
  }
  const files: string[] = []
  for (const line of text.split('\n')) {
    const entry = BASELINE_ENTRY.exec(line)
    if (entry) files.push(entry[1]!)
  }
  return files
}

/**
 * The baseline entries the base revision had not frozen. The list may only shrink, so an entry
 * added since that revision fails until its line is removed.
 */
function baselineGrowth(baseline: readonly string[], baseBaseline: readonly string[]): string[] {
  const frozen = new Set(baseBaseline)
  return baseline
    .filter((file) => !frozen.has(file))
    .map(
      (file) =>
        `${file}: not in the undeclaredModulesBaseline of the landing base; the baseline may only shrink (canon 10-code: A module is one concern)`,
    )
}

/**
 * Every source file that belongs to no manifest module, and every baseline entry that no
 * longer earns its place. The decision is pure: the caller supplies the scanned file list,
 * the manifest's declared locations, the baseline and the baseline as the base revision froze
 * it.
 *
 * A manifest module's file is one exact path, never a pattern. The baseline only shrinks: an
 * entry the base revision did not freeze, and a baselined file whose path is now declared or
 * whose file is gone, each stay a violation until its line is removed. A null base is a
 * revision that has no baseline module yet, which leaves nothing to refuse against.
 */
export function architectureUndeclaredModules(
  files: readonly string[],
  manifestFiles: readonly string[],
  baseline: readonly string[],
  baseBaseline: readonly string[] | null,
): string[] {
  const manifest = new Set(manifestFiles)
  const baselined = new Set(baseline)
  const violations: string[] = []
  const judged = files.filter(isProductionSourceFile)

  for (const file of judged) {
    if (manifest.has(file) || baselined.has(file)) continue
    violations.push(
      `${file}: belongs to no manifest module; declare it in scripts/architecture.ts, scripts/architecture-boundaries.ts or the matching scripts/architecture-*-modules.ts (canon 10-code: A module is one concern)`,
    )
  }

  const judgedFiles = new Set(judged)
  for (const file of baseline) {
    if (manifest.has(file)) {
      violations.push(
        `${file}: baselined file is now declared; remove it from undeclaredModulesBaseline (canon 10-code: A module is one concern)`,
      )
    } else if (!judgedFiles.has(file)) {
      violations.push(
        `${file}: baselined file is gone; remove it from undeclaredModulesBaseline (canon 10-code: A module is one concern)`,
      )
    }
  }

  if (baseBaseline) violations.push(...baselineGrowth(baseline, baseBaseline))

  return violations
}

/**
 * How many judged source files belong to no manifest module. The frozen baseline is what
 * this counts, so the number falls as files are declared and the baseline shrinks with it.
 */
export function countUndeclaredModules(
  files: readonly string[],
  manifestFiles: readonly string[],
): number {
  const manifest = new Set(manifestFiles)
  return files.filter(isProductionSourceFile).filter((file) => !manifest.has(file)).length
}
