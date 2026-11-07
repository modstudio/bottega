import { basename, dirname, normalize } from 'node:path'
import type { ImportBoundary } from './architecture-boundaries.ts'
import { branchModuleSpecs } from './architecture-branch-modules.ts'
import { canonBoundarySpecs } from './architecture-canon-boundaries.ts'
import { cleanupBoundarySpecs } from './architecture-cleanup-boundaries.ts'
import { contractBoundarySpecs } from './architecture-contract-boundaries.ts'
import { databaseBoundarySpecs } from './architecture-database-boundaries.ts'
import { mcpBoundarySpecs } from './architecture-mcp-boundaries.ts'
import { portBoundarySpecs } from './architecture-port-boundaries.ts'
import { proseBoundarySpecs } from './architecture-prose-modules.ts'
import { pullRequestModuleSpecs } from './architecture-pull-request.ts'
import {
  recordApiBoundaries,
  recordAuthCommandBoundaries,
  recordMachineBoundaries,
  recordReadBoundariesAfterPublish,
  recordReadBoundariesBeforePublish,
  recordSchemaBoundaries,
  recordSyncCommandBoundaries,
} from './architecture-record-boundaries.ts'
import { recordSettingsBoundarySpecs } from './architecture-record-settings-boundaries.ts'
import { releaseModules } from './architecture-release.ts'
import { reviewBoundarySpecs, reviewModuleSpecs } from './architecture-review-boundaries.ts'
import { runLifecycleBoundarySpecs } from './architecture-run-lifecycle-boundaries.ts'
import {
  runLifecycleModules,
  runLifecycleTypeOnlyBoundarySpecs,
} from './architecture-run-lifecycle-modules.ts'
import { runLivenessBoundarySpecs, runLivenessModuleSpecs } from './architecture-run-liveness.ts'
import { runModuleBoundarySpecs } from './architecture-run-modules.ts'
import { runRetryModuleSpecs } from './architecture-run-retry.ts'
import { runStopBoundarySpecs } from './architecture-run-stop.ts'
import { settingsBoundarySpecs } from './architecture-settings-boundaries.ts'
import { setupModuleSpecs } from './architecture-setup-modules.ts'
import { worktreeBoundarySpecs } from './architecture-worktree-boundaries.ts'

type TypeOnlyAllowedSpec = {
  file: string
  allowed?: readonly string[]
  typeOnlyAllowed?: readonly string[]
}

const normalizeTarget = (file: string, target: string) =>
  target.startsWith('.') ? normalize(`${dirname(file)}/${target}`) : target

const typeOnlyBoundary = (spec: Required<TypeOnlyAllowedSpec>): ImportBoundary => ({
  name: `${basename(spec.file, '.ts')}-type-only-boundary`,
  file: spec.file,
  allowed: spec.allowed.map((target) => normalizeTarget(spec.file, target)),
  typeOnlyAllowed: spec.typeOnlyAllowed.map((target) => normalizeTarget(spec.file, target)),
  reason: `Keep the imports ${basename(spec.file, '.ts')} takes for types only type-only.`,
})

const declaredTypeOnlyBoundaries = (specs: readonly TypeOnlyAllowedSpec[]) =>
  specs
    .filter(
      (spec): spec is Required<TypeOnlyAllowedSpec> =>
        spec.allowed !== undefined &&
        spec.typeOnlyAllowed !== undefined &&
        spec.typeOnlyAllowed.length > 0,
    )
    .map(typeOnlyBoundary)

export const manifestTypeOnlyImportBoundaries = [
  ...declaredTypeOnlyBoundaries(pullRequestModuleSpecs),
  ...declaredTypeOnlyBoundaries(releaseModules),
  ...declaredTypeOnlyBoundaries(reviewModuleSpecs),
]

const typeOnlyAllowedSpecFamilies: readonly {
  name: string
  specs: readonly TypeOnlyAllowedSpec[]
}[] = [
  { name: 'branchModuleSpecs', specs: branchModuleSpecs },
  { name: 'canonBoundarySpecs', specs: canonBoundarySpecs },
  { name: 'cleanupBoundarySpecs', specs: cleanupBoundarySpecs },
  { name: 'contractBoundarySpecs', specs: contractBoundarySpecs },
  { name: 'databaseBoundarySpecs', specs: databaseBoundarySpecs },
  { name: 'mcpBoundarySpecs', specs: mcpBoundarySpecs },
  { name: 'portBoundarySpecs', specs: portBoundarySpecs },
  { name: 'proseBoundarySpecs', specs: proseBoundarySpecs },
  { name: 'pullRequestModuleSpecs', specs: pullRequestModuleSpecs },
  { name: 'recordApiBoundaries', specs: recordApiBoundaries },
  { name: 'recordAuthCommandBoundaries', specs: recordAuthCommandBoundaries },
  { name: 'recordMachineBoundaries', specs: recordMachineBoundaries },
  { name: 'recordReadBoundariesAfterPublish', specs: recordReadBoundariesAfterPublish },
  { name: 'recordReadBoundariesBeforePublish', specs: recordReadBoundariesBeforePublish },
  { name: 'recordSchemaBoundaries', specs: recordSchemaBoundaries },
  { name: 'recordSettingsBoundarySpecs', specs: recordSettingsBoundarySpecs },
  { name: 'recordSyncCommandBoundaries', specs: recordSyncCommandBoundaries },
  { name: 'releaseModules', specs: releaseModules },
  { name: 'reviewBoundarySpecs', specs: reviewBoundarySpecs },
  { name: 'reviewModuleSpecs', specs: reviewModuleSpecs },
  { name: 'runLifecycleBoundarySpecs', specs: runLifecycleBoundarySpecs },
  { name: 'runLifecycleModules', specs: runLifecycleModules },
  { name: 'runLifecycleTypeOnlyBoundarySpecs', specs: runLifecycleTypeOnlyBoundarySpecs },
  { name: 'runLivenessBoundarySpecs', specs: runLivenessBoundarySpecs },
  { name: 'runLivenessModuleSpecs', specs: runLivenessModuleSpecs },
  { name: 'runModuleBoundarySpecs', specs: runModuleBoundarySpecs },
  { name: 'runRetryModuleSpecs', specs: runRetryModuleSpecs },
  { name: 'runStopBoundarySpecs', specs: runStopBoundarySpecs },
  { name: 'settingsBoundarySpecs', specs: settingsBoundarySpecs },
  { name: 'setupModuleSpecs', specs: setupModuleSpecs },
  { name: 'worktreeBoundarySpecs', specs: worktreeBoundarySpecs },
]

export function missingTypeOnlyImportBoundaryViolations(
  boundaries: readonly ImportBoundary[],
): string[] {
  const generated = new Set(
    boundaries.flatMap((spec) =>
      spec.typeOnlyAllowed.map((target) => `${spec.file}\0${normalizeTarget(spec.file, target)}`),
    ),
  )
  const violations: string[] = []
  for (const family of typeOnlyAllowedSpecFamilies) {
    for (const spec of family.specs) {
      for (const target of spec.typeOnlyAllowed ?? []) {
        if (generated.has(`${spec.file}\0${normalizeTarget(spec.file, target)}`)) continue
        violations.push(
          `${spec.file}: type-only target ${target} has no generated type-only rule; add ${family.name} to importBoundaries`,
        )
      }
    }
  }
  return violations
}
