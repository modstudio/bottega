import { basename, dirname, normalize } from 'node:path'
import { Glob } from 'bun'
import type { ImportBoundary } from './architecture-boundaries.ts'
import { pullRequestModuleSpecs } from './architecture-pull-request.ts'
import { releaseModules } from './architecture-release.ts'
import { reviewModuleSpecs } from './architecture-review-boundaries.ts'

type TypeOnlyAllowedSpec = {
  file: string
  typeOnlyAllowed?: readonly string[]
}

type MappedTypeOnlyAllowedSpec = TypeOnlyAllowedSpec & { allowed: readonly string[] }

const normalizeTarget = (file: string, target: string) =>
  target.startsWith('.') ? normalize(`${dirname(file)}/${target}`) : target

const typeOnlyImportBoundaries = (specs: readonly MappedTypeOnlyAllowedSpec[]) =>
  specs
    .filter((spec) => spec.typeOnlyAllowed?.length)
    .map((spec) => ({
      name: `${basename(spec.file, '.ts')}-type-only-boundary`,
      file: spec.file,
      allowed: spec.allowed.map((target) => normalizeTarget(spec.file, target)),
      typeOnlyAllowed: (spec.typeOnlyAllowed ?? []).map((target) =>
        normalizeTarget(spec.file, target),
      ),
      reason: `Keep the imports ${basename(spec.file, '.ts')} takes for types only type-only.`,
    }))

export const manifestTypeOnlyImportBoundaries = [
  ...typeOnlyImportBoundaries(pullRequestModuleSpecs),
  ...typeOnlyImportBoundaries(releaseModules),
  ...typeOnlyImportBoundaries(reviewModuleSpecs),
]

const isTypeOnlyAllowedSpec = (value: unknown): value is TypeOnlyAllowedSpec =>
  typeof value === 'object' &&
  value !== null &&
  'file' in value &&
  typeof value.file === 'string' &&
  'typeOnlyAllowed' in value &&
  Array.isArray(value.typeOnlyAllowed)

async function typeOnlyAllowedSpecFamilies() {
  const families: { name: string; specs: readonly TypeOnlyAllowedSpec[] }[] = []
  for (const moduleFile of new Glob('architecture*.ts').scanSync(import.meta.dir)) {
    if (moduleFile.endsWith('.test.ts')) continue
    const exports = (await import(new URL(moduleFile, import.meta.url).href)) as Record<
      string,
      unknown
    >
    for (const [exportName, value] of Object.entries(exports)) {
      if (!Array.isArray(value) || !value.every(isTypeOnlyAllowedSpec)) continue
      families.push({
        name: `${basename(moduleFile, '.ts')}:${exportName}`,
        specs: value,
      })
    }
  }
  return families
}

export async function missingTypeOnlyImportBoundaryViolations(
  boundaries: readonly ImportBoundary[],
): Promise<string[]> {
  const generated = new Set(
    boundaries.flatMap((spec) =>
      spec.typeOnlyAllowed.map((target) => `${spec.file}\0${normalizeTarget(spec.file, target)}`),
    ),
  )
  const violations: string[] = []
  for (const family of await typeOnlyAllowedSpecFamilies()) {
    for (const spec of family.specs) {
      for (const target of spec.typeOnlyAllowed ?? []) {
        if (generated.has(`${spec.file}\0${normalizeTarget(spec.file, target)}`)) continue
        violations.push(
          `${spec.file}: type-only target ${target} from ${family.name} has no generated type-only rule; map ${family.name} into importBoundaries through boundary(...) with its typeOnlyAllowed`,
        )
      }
    }
  }
  return violations
}

export function duplicateImportBoundaryNameViolations(
  boundaries: readonly ImportBoundary[],
): string[] {
  const firstFileByName = new Map<string, string>()
  const violations: string[] = []
  for (const boundary of boundaries) {
    const firstFile = firstFileByName.get(boundary.name)
    if (firstFile !== undefined) {
      violations.push(
        `import boundary name ${boundary.name} is duplicated for ${firstFile} and ${boundary.file}`,
      )
      continue
    }
    firstFileByName.set(boundary.name, boundary.file)
  }
  return violations
}
