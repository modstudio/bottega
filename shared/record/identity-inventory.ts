// concern: postgres-identity-inventory
import { type AnyPgTable, getTableConfig } from 'drizzle-orm/pg-core'
import { machine, membership, project, seq, space, user } from './schema.ts'
import { account, invitation, session, verification } from './schema-auth.ts'
import { boardClaim, boardMessage, boardMessageTag, boardReceipt } from './schema-board.ts'
import {
  configEntry,
  configSecret,
  machinePublicKey,
  secretDek,
  secretDekWrap,
} from './schema-config.ts'
import { doc, docRelatedSubject, docRevision, publicDocSpace } from './schema-docs.ts'
import {
  hubChange,
  hubChangeHead,
  hubDay,
  hubInterval,
  hubNote,
  hubNoteAcknowledgement,
  hubReportSubscription,
  hubReportSubscriptionMember,
  hubReportSubscriptionProject,
  hubReportSubscriptionRecipient,
  hubSend,
  hubSendRecipient,
  hubTask,
  hubTaskComment,
  hubTaskDocument,
  hubTaskStatusEvent,
  operatorWaitingEmail,
} from './schema-hub.ts'
import {
  contention,
  landing,
  landingOverride,
  landingReviewCarry,
  landingTriageSnapshot,
  testFlake,
} from './schema-landing.ts'
import { question, questionMutationAudit } from './schema-question.ts'
import { release } from './schema-release.ts'
import { review, reviewFinding, reviewLens, reviewRead } from './schema-review.ts'
import { run, runExclusion, runScore } from './schema-run.ts'
import { orchSnapshot } from './schema-snapshots.ts'
import { subject } from './schema-subjects.ts'

export type HostedKeyTable = {
  name: string
  primaryKey: string[]
  columns: {
    table: string
    name: string
    type: string
    primaryKey: boolean
    foreignKey: boolean
  }[]
}

const HOSTED_TABLES: readonly AnyPgTable[] = [
  space,
  user,
  membership,
  machine,
  project,
  seq,
  session,
  account,
  verification,
  invitation,
  boardClaim,
  boardMessage,
  boardMessageTag,
  boardReceipt,
  configEntry,
  secretDek,
  configSecret,
  secretDekWrap,
  machinePublicKey,
  doc,
  publicDocSpace,
  docRevision,
  docRelatedSubject,
  hubChangeHead,
  hubChange,
  hubTask,
  hubTaskComment,
  hubTaskDocument,
  hubTaskStatusEvent,
  hubNote,
  hubNoteAcknowledgement,
  hubReportSubscription,
  hubReportSubscriptionMember,
  hubReportSubscriptionProject,
  hubReportSubscriptionRecipient,
  hubSend,
  hubSendRecipient,
  operatorWaitingEmail,
  hubInterval,
  hubDay,
  landing,
  landingOverride,
  landingReviewCarry,
  landingTriageSnapshot,
  contention,
  testFlake,
  question,
  questionMutationAudit,
  release,
  review,
  reviewLens,
  reviewFinding,
  reviewRead,
  run,
  runScore,
  runExclusion,
  orchSnapshot,
  subject,
]

export function hostedKeyTables(): HostedKeyTable[] {
  return HOSTED_TABLES.map((table) => {
    const config = getTableConfig(table)
    const primaryColumns = [
      ...config.columns.filter((column) => column.primary),
      ...config.primaryKeys.flatMap((primaryKey) => primaryKey.columns),
    ]
    const primaryNames = new Set(primaryColumns.map((column) => column.name))
    const foreignNames = new Set(
      config.foreignKeys.flatMap((foreignKey) =>
        foreignKey.reference().columns.map((column) => column.name),
      ),
    )
    return {
      name: config.name,
      primaryKey: [...primaryNames],
      columns: config.columns.map((column) => ({
        table: config.name,
        name: column.name,
        type:
          column.getSQLType() === 'uuid'
            ? 'uuid'
            : /^(?:bigint|integer|smallint|serial|bigserial)/.test(column.getSQLType())
              ? 'integer'
              : column.getSQLType(),
        primaryKey: primaryNames.has(column.name),
        foreignKey: foreignNames.has(column.name),
      })),
    }
  }).sort((left, right) => left.name.localeCompare(right.name))
}
