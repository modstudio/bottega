export const RECORD_TIMESTAMP_COMPARISON_REMEDY =
  'Compare record timestamps with sameRecordInstant from shared/record-timestamp.ts.'

export const RECORD_TIMESTAMP_GUARD_SCOPE = {
  files: ['hub/src/hosted-push-*.ts'],
  ignores: ['hub/src/hosted-push-*.test.ts'],
}

export const RECORD_TIMESTAMP_GUARD_FIELDS = [
  'at',
  'acknowledged_at',
  'closed_at',
  'collected_at',
  'created_at',
  'deleted_at',
  'end_at',
  'first_seen',
  'last_seen',
  'last_seen_at',
  'opened_at',
  'stale_at',
  'start_at',
  'updated_at',
]

const recordTimestampFieldPattern = `^(${RECORD_TIMESTAMP_GUARD_FIELDS.join('|')})$`

export const RECORD_TIMESTAMP_COMPARISON_SELECTORS = [
  {
    selector: "CallExpression[callee.type='MemberExpression'][callee.property.name='getTime']",
    message: RECORD_TIMESTAMP_COMPARISON_REMEDY,
  },
  {
    selector: "BinaryExpression[operator='instanceof'][right.name='Date']",
    message: RECORD_TIMESTAMP_COMPARISON_REMEDY,
  },
  {
    selector: `BinaryExpression[operator=/^(===|!==|==|!=)$/][left.type='MemberExpression'][right.type='MemberExpression'][left.property.name=/${recordTimestampFieldPattern}/][right.property.name=/${recordTimestampFieldPattern}/]`,
    message: RECORD_TIMESTAMP_COMPARISON_REMEDY,
  },
]
