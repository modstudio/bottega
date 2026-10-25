// concern: ruling-attribution
/** Owns which person's name, if any, is recorded for a ruling. */

import { userInfo } from 'node:os'
import { db } from '../database/db.ts'
import { cachedSignedInRecordUser } from '../record/record-session.ts'
import { answererKindFromAnsweredBy, rulingActor } from './question-vocabulary.ts'

export function rulingPersonName(
  fromOperator: boolean,
  cachedName: string | null,
  machineUsername: string,
): string | null {
  if (!fromOperator) return null
  return cachedName ?? machineUsername
}

export function resolvedRulingPersonName(fromOperator: boolean): string | null {
  if (!fromOperator) return null
  try {
    return rulingPersonName(true, cachedSignedInRecordUser(db())?.name ?? null, userInfo().username)
  } catch {
    return rulingPersonName(true, null, userInfo().username)
  }
}

function answeredBy(
  operatorAuthorized: boolean,
  fromOperator: boolean,
  callerSession: string | null,
): string {
  if (operatorAuthorized && fromOperator) return 'operator via hub'
  return rulingActor(fromOperator, callerSession)
}

/** The answered_by, answered_by_name and answerer_kind columns for each answer, in order. */
export function answerAttributions(
  authorityKind: string,
  channel: string,
  answers: readonly { fromOperator: boolean }[],
  callerSession: string | null,
) {
  const operatorAuthorized = authorityKind === 'allow-as-operator' && channel === 'ui'
  return answers.map((answer) => {
    const identity = answeredBy(operatorAuthorized, answer.fromOperator, callerSession)
    return [
      identity,
      resolvedRulingPersonName(answer.fromOperator),
      answererKindFromAnsweredBy(identity),
    ] as const
  })
}
