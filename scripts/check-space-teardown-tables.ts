import { SPACE_TEARDOWN_EXCLUSIONS, SPACE_TEARDOWN_ORDER, spaceForeignKeyFacts, unclassifiedSpaceTables } from '../shared/record/space-teardown.ts'
const missing = unclassifiedSpaceTables(spaceForeignKeyFacts())
if (missing.length) throw new Error(`space teardown does not classify hosted tables: ${missing.join(', ')}`)
if (Object.entries(SPACE_TEARDOWN_EXCLUSIONS).some(([, reason]) => !reason.trim())) throw new Error('every space teardown exclusion needs a reason')
console.log(`space teardown tables: ${SPACE_TEARDOWN_ORDER.length} ordered, ${Object.keys(SPACE_TEARDOWN_EXCLUSIONS).length} excluded`)
