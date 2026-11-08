// concern: ajv-validator-loader
/** Lazily loads the embedded Ajv validator without putting Ajv on CLI startup paths. */

import type { AjvValidator } from './ajv-validator.ts'

let schemaValidator: AjvValidator | null = null

export function loadAjvValidator(): AjvValidator {
  if (schemaValidator) return schemaValidator
  // Loaded here, not at module load: doctor and every reporting command reach
  // the reply contract, and hermetic linked-tree fixtures carry no
  // orchestrator/node_modules. Ajv belongs only on a schema-validation path.
  try {
    const loaded = require('./ajv-validator.ts') as typeof import('./ajv-validator.ts')
    schemaValidator = loaded.createStrictSchemaValidator()
    return schemaValidator
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error)
    throw new Error(`failed to load or construct the strict schema validator: ${cause}`)
  }
}
