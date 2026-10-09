// concern: canon-empty-store-refusal
/** Holds the empty-project canon store refusal text. Must not know planning, stores, filesystems, or commands. */

export const EMPTY_PROJECT_CANON_STORE_CONDITION =
  'this store holds no project canon while the tree has managed canon paths'

export const EMPTY_PROJECT_CANON_IMPORT_REMEDY = 'orch canon import --project'

export const EMPTY_PROJECT_CANON_STORE_REFUSAL = `${EMPTY_PROJECT_CANON_STORE_CONDITION}; keep them by importing with \`${EMPTY_PROJECT_CANON_IMPORT_REMEDY}\`; or remove the files yourself`
