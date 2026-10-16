// concern: doc-generator
/** Marks a write as coming from the reference publisher; reference documents accept no other. */

export const REFERENCE_GENERATOR = 'reference-publish' as const
export type DocGenerator = typeof REFERENCE_GENERATOR
