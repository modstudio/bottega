// concern: test-substance-project-policy
/** Resolves a project's declared PHP test policy without giving consumers register knowledge. */

import type { Database } from 'bun:sqlite'
import type { PhpPolicyRule } from '../../shared/test-substance/test-substance.ts'
import { openReadOnlyDatabase } from './database/db.ts'
import type { ProjectSettings } from './project/project-settings.ts'
import { projectAt } from './project/projects.ts'

export type PhpPolicyResolution = {
  rules: readonly PhpPolicyRule[]
  notReadReason?: string
}

/** Select the declared rules, or universal-only policy when the setting is absent. */
export function phpPolicyRulesFromSettings(
  settings: Pick<ProjectSettings, 'testSubstance'> | undefined,
): readonly PhpPolicyRule[] {
  return settings?.testSubstance?.phpPolicyRules ?? []
}

type ReadOnlyDatabase = () => Database

function detail(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Resolve one path through the register, falling back visibly when the register cannot be read. */
export function resolvePhpPolicyRules(
  path: string,
  openDatabase: ReadOnlyDatabase = openReadOnlyDatabase,
): PhpPolicyResolution {
  let database: Database
  try {
    database = openDatabase()
  } catch (error) {
    return { rules: [], notReadReason: detail(error) }
  }
  try {
    const project = projectAt(path, database)
    return { rules: phpPolicyRulesFromSettings(project?.settings) }
  } catch (error) {
    return { rules: [], notReadReason: detail(error) }
  } finally {
    database.close()
  }
}

export function unreadPhpPolicyRulesLine(reason: string): string {
  return `the project's PHP policy rules were not read: ${reason}`
}
