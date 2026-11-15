import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { sameChangeSql } from './evidence-query.ts'

test('sameChangeSql pairs measured and legacy review identities with null-safe semantics', () => {
  const database = new Database(':memory:')
  try {
    database.exec(`CREATE TABLE review_pair (
      pair TEXT NOT NULL,
      side TEXT NOT NULL,
      patch_id TEXT,
      zero_context_patch_id TEXT,
      path_set TEXT
    )`)
    const insert = database.query(
      'INSERT INTO review_pair (pair,side,patch_id,zero_context_patch_id,path_set) VALUES (?,?,?,?,?)',
    )
    insert.run('zero-context', 'left', 'legacy-left', 'zero', '["a.ts"]')
    insert.run('zero-context', 'right', 'legacy-right', 'zero', '["a.ts"]')
    insert.run('legacy', 'left', 'legacy', null, '["a.ts"]')
    insert.run('legacy', 'right', 'legacy', null, '["a.ts"]')
    insert.run('mixed-mismatch', 'left', 'legacy-left', null, '["a.ts"]')
    insert.run('mixed-mismatch', 'right', 'legacy-right', 'zero', '["a.ts"]')

    const matched = database
      .query<{ pair: string }, []>(
        `SELECT left_review.pair
           FROM review_pair left_review
           JOIN review_pair right_review ON right_review.pair=left_review.pair
          WHERE left_review.side='left' AND right_review.side='right'
            AND ${sameChangeSql('left_review', 'right_review')}
          ORDER BY left_review.pair`,
      )
      .all()
      .map(({ pair }) => pair)

    expect(matched).toEqual(['legacy', 'zero-context'])
  } finally {
    database.close()
  }
})
