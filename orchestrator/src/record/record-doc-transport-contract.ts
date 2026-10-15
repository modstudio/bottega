// concern: record-doc-transport-contract
/** Pure compatibility contract for document writes across independently deployed clients and APIs. */

const RECORD_DOC_ARTICLE_RESPONSE_KEYS = [
  'form',
  'articleSubject',
  'relatedSubjects',
  'sourceFiles',
  'checkedAgainstCommit',
  'summary',
] as const

type ArticleResponseKey = (typeof RECORD_DOC_ARTICLE_RESPONSE_KEYS)[number]
type ArticleWriteField =
  | 'form'
  | 'articleSubjectId'
  | 'relatedSubjectIds'
  | 'sourceFiles'
  | 'checkedAgainstCommit'
  | 'summary'

export type RecordDocWriteResponse<T extends { id: string }> = T &
  Partial<Record<ArticleResponseKey, unknown>>

const RECORD_DOC_ARTICLE_COMPATIBILITY_REFUSAL =
  "the document's other changes were stored on the hosted record, but its article fields were not because the hosted API predates them; cleared by: deploy the hosted API"

const ARTICLE_WRITE_FIELDS: readonly ArticleWriteField[] = [
  'form',
  'articleSubjectId',
  'relatedSubjectIds',
  'sourceFiles',
  'checkedAgainstCommit',
  'summary',
]

const owns = (value: object, key: PropertyKey): boolean => Object.hasOwn(value, key)

export function recordDocArticleCompatibilityRefusal(
  rows: readonly object[],
  response: object,
): string | null {
  const sentArticleFields = rows.some((row) => ARTICLE_WRITE_FIELDS.some((key) => owns(row, key)))
  if (!sentArticleFields || RECORD_DOC_ARTICLE_RESPONSE_KEYS.every((key) => owns(response, key))) {
    return null
  }
  return RECORD_DOC_ARTICLE_COMPATIBILITY_REFUSAL
}

export function recordDocWriteResponseFields(
  record: Record<string, unknown>,
): Partial<Record<ArticleResponseKey, unknown>> {
  return Object.fromEntries(
    RECORD_DOC_ARTICLE_RESPONSE_KEYS.filter((key) => owns(record, key)).map((key) => [
      key,
      record[key],
    ]),
  )
}
