import type { Transaction } from '@electric-sql/pglite'
import type { MigrationMeta } from 'drizzle-orm/migrator'
import { PLATFORM_SPACE_ID } from '../shared/record/schema.ts'
import { CheckFailure, errorMessage } from './record-migration-failure.ts'

type ApplyMigration = (transaction: Transaction, migration: MigrationMeta) => Promise<unknown>

const catalogueProofId = (n: number) => `01990000-0000-7000-8000-${n.toString().padStart(12, '0')}`

async function seedLensPinContractRow(
  transaction: Transaction,
  selectedVersion: number | null,
): Promise<void> {
  await transaction.exec(`
    ALTER TABLE project_lens_profile NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE lens_profile NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE lens NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE project NO FORCE ROW LEVEL SECURITY;
    INSERT INTO project (id,space_id,name,created_at)
    VALUES ('${catalogueProofId(390)}','${PLATFORM_SPACE_ID}','pin-contract-proof',now());
    INSERT INTO lens (id,space_id,key,title,question,excludes,slots,version)
    VALUES ('${catalogueProofId(391)}','${PLATFORM_SPACE_ID}','pin-contract-proof','Proof','Question?','[]','[]',1);
    INSERT INTO lens_profile
      (id,space_id,lens_id,axis,name,version,current_version_id,body)
    VALUES (
      '${catalogueProofId(392)}','${PLATFORM_SPACE_ID}','${catalogueProofId(391)}',
      'framework','proof',1,'${catalogueProofId(393)}','{}'
    );
    INSERT INTO project_lens_profile
      (id,space_id,project_id,lens_id,axis,profile_name,selected_version,selected_version_id)
    VALUES (
      '${catalogueProofId(394)}','${PLATFORM_SPACE_ID}','${catalogueProofId(390)}',
      '${catalogueProofId(391)}','framework','proof',${selectedVersion ?? 'NULL'},NULL
    );
    ALTER TABLE project_lens_profile FORCE ROW LEVEL SECURITY;
    ALTER TABLE lens_profile FORCE ROW LEVEL SECURITY;
    ALTER TABLE lens FORCE ROW LEVEL SECURITY;
    ALTER TABLE project FORCE ROW LEVEL SECURITY;
  `)
}

export async function proofLensPinContractGuard(
  transaction: Transaction,
  migration: MigrationMeta,
  applyRecordMigration: ApplyMigration,
): Promise<void> {
  await transaction.exec('SAVEPOINT lens_pin_contract_guard_refusal')
  await seedLensPinContractRow(transaction, 2)
  let refusal: unknown
  try {
    await applyRecordMigration(transaction, migration)
  } catch (error) {
    refusal = error
  }
  await transaction.exec('ROLLBACK TO SAVEPOINT lens_pin_contract_guard_refusal')
  await transaction.exec('RELEASE SAVEPOINT lens_pin_contract_guard_refusal')
  if (!errorMessage(refusal).includes('unresolved lens profile pins block the S4 contract'))
    throw new CheckFailure(
      `DEV-1991 hosted pin guard did not refuse the integer-only row: ${errorMessage(refusal)}`,
    )

  await transaction.exec('SAVEPOINT lens_pin_contract_guard_resolution')
  await seedLensPinContractRow(transaction, 1)
  await applyRecordMigration(transaction, migration)
  await transaction.exec('ALTER TABLE project_lens_profile NO FORCE ROW LEVEL SECURITY')
  const resolved = await transaction.query<{ selected_version_id: string | null }>(
    'SELECT selected_version_id FROM project_lens_profile WHERE id = $1',
    [catalogueProofId(394)],
  )
  if (resolved.rows[0]?.selected_version_id !== catalogueProofId(393))
    throw new CheckFailure('DEV-1991 hosted pin guard did not re-resolve the current-version pin')
  await transaction.exec('ROLLBACK TO SAVEPOINT lens_pin_contract_guard_resolution')
  await transaction.exec('RELEASE SAVEPOINT lens_pin_contract_guard_resolution')

  await seedLensPinContractRow(transaction, null)
}
