import type { SQL } from 'bun'

type ChildAlias = 'c' | 'd' | 'e'

export function hostedTaskJoinCondition(child: ChildAlias, task: 't' = 't') {
  return (
    `(${child}.task_id IS NOT NULL AND ${task}.id=${child}.task_id) OR (` +
    `${child}.task_id IS NULL AND ${task}.space_id=${child}.space_id AND ${task}.key=${child}.task_key)`
  )
}

export function hostedTaskJoin(tx: SQL, child: ChildAlias, task: 't' = 't') {
  return tx.unsafe(hostedTaskJoinCondition(child, task))
}

export function childTaskLabelUpdate(previousKey: string, nextKey: string) {
  return previousKey === nextKey ? null : { previousKey, nextKey }
}
