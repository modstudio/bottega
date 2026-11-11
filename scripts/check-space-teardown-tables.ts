import {
  PROJECT_PURGE_EXCLUSIONS,
  PROJECT_PURGE_ORDER,
  SPACE_TEARDOWN_EXCLUSIONS,
  SPACE_TEARDOWN_ORDER,
  unclassifiedProjectTables,
  unclassifiedSpaceTables,
} from '../orchestrator/src/record/record-space-teardown-plan.ts'

const started = performance.now()
const missing = unclassifiedSpaceTables()
if (missing.length)
  throw new Error(`space teardown does not classify hosted tables: ${missing.join(', ')}`)
if (Object.entries(SPACE_TEARDOWN_EXCLUSIONS).some(([, reason]) => !reason.trim()))
  throw new Error('every space teardown exclusion needs a reason')
const missingProject = unclassifiedProjectTables()
if (missingProject.length)
  throw new Error(`project purge does not classify hosted tables: ${missingProject.join(', ')}`)
if (Object.entries(PROJECT_PURGE_EXCLUSIONS).some(([, reason]) => !reason.trim()))
  throw new Error('every project purge exclusion needs a reason')
console.log(
  `space teardown tables: ${SPACE_TEARDOWN_ORDER.length} ordered, ${Object.keys(SPACE_TEARDOWN_EXCLUSIONS).length} excluded; project purge tables: ${PROJECT_PURGE_ORDER.length} ordered, ${Object.keys(PROJECT_PURGE_EXCLUSIONS).length} excluded (${(performance.now() - started).toFixed(1)}ms)`,
)
