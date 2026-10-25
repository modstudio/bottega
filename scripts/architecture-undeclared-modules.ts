import { Glob } from 'bun'

/**
 * The source roots whose files must belong to a manifest module. Membership is keyed on the
 * file's location rather than on a `// concern: <slug>` header, so a file whose imports no
 * module rule declares cannot hide behind the header's wording or its absence.
 */
export const DECLARED_SOURCE_ROOTS = ['orchestrator/src', 'hub/src'] as const

const TEST_DIRECTORY = /(^|\/)tests?\//
const TEST_FILE = /\.(?:test|spec)\.[cm]?tsx?$/
const GLOB_CHARACTER = /[*?[\]{}]/

/** Test files and test folders are not judged by the manifest. */
export function isProductionSourceFile(path: string) {
  return !TEST_DIRECTORY.test(path) && !TEST_FILE.test(path)
}

function manifestMatchers(manifestGlobs: readonly string[]) {
  return {
    exact: new Set(manifestGlobs.filter((glob) => !GLOB_CHARACTER.test(glob))),
    patterns: manifestGlobs
      .filter((glob) => GLOB_CHARACTER.test(glob))
      .map((glob) => new Glob(glob)),
  }
}

function isDeclared(file: string, manifest: ReturnType<typeof manifestMatchers>): boolean {
  return manifest.exact.has(file) || manifest.patterns.some((pattern) => pattern.match(file))
}

/**
 * Every source file that belongs to no manifest module, and every baseline entry that no
 * longer earns its place. The decision is pure: the caller supplies the scanned file list,
 * the manifest's declared locations and the baseline.
 *
 * The baseline only shrinks. A baselined file whose path is now declared, or whose file is
 * gone, stays a violation until its line is removed.
 */
export function architectureUndeclaredModules(
  files: readonly string[],
  manifestGlobs: readonly string[],
  baseline: readonly string[],
): string[] {
  const manifest = manifestMatchers(manifestGlobs)
  const baselined = new Set(baseline)
  const violations: string[] = []
  const judged = files.filter(isProductionSourceFile)

  for (const file of judged) {
    if (isDeclared(file, manifest) || baselined.has(file)) continue
    violations.push(
      `${file}: belongs to no manifest module; declare it in scripts/architecture.ts, scripts/architecture-boundaries.ts or the matching scripts/architecture-*-modules.ts (canon 10-code: A module is one concern)`,
    )
  }

  const judgedFiles = new Set(judged)
  for (const file of baseline) {
    if (isDeclared(file, manifest)) {
      violations.push(
        `${file}: baselined file is now declared; remove it from undeclaredModulesBaseline (canon 10-code: A module is one concern)`,
      )
    } else if (!judgedFiles.has(file)) {
      violations.push(
        `${file}: baselined file is gone; remove it from undeclaredModulesBaseline (canon 10-code: A module is one concern)`,
      )
    }
  }

  return violations
}

/**
 * How many judged source files belong to no manifest module. The frozen baseline is what
 * this counts, so the number falls as files are declared and the baseline shrinks with it.
 */
export function countUndeclaredModules(
  files: readonly string[],
  manifestGlobs: readonly string[],
): number {
  const manifest = manifestMatchers(manifestGlobs)
  return files.filter(isProductionSourceFile).filter((file) => !isDeclared(file, manifest)).length
}
