// concern: hosted-question-number
/** Allocates question numbers from the hosted space counter. */

import type { SQL } from 'bun'

export async function allocateQuestionNumber(tx: SQL, spaceId: string): Promise<number> {
  const rows = (await tx`
    INSERT INTO question_number_counter (space_id,next)
    VALUES (
      ${spaceId}::uuid,
      COALESCE((SELECT MAX(number)::bigint + 2 FROM question WHERE space_id=${spaceId}::uuid),2)
    )
    ON CONFLICT (space_id) DO UPDATE SET next=GREATEST(
      question_number_counter.next,
      COALESCE((SELECT MAX(number)::bigint + 1 FROM question WHERE space_id=${spaceId}::uuid),1)
    ) + 1
    RETURNING next - 1 AS number
  `) as Array<{ number: bigint | number | string }>
  return Number(rows[0]!.number)
}
