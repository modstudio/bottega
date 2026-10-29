import type { Transaction } from '@electric-sql/pglite'
import { PLATFORM_SPACE_ID } from '../shared/record/schema.ts'

export const repair = '20261029210000_dev_1885_jsonb_string_repair'

const ids = {
  machine: '01990000-0000-7000-8000-000000001851',
  run: '01990000-0000-7000-8000-000000001852',
  structuredRun: '01990000-0000-7000-8000-000000001853',
  invalidRun: '01990000-0000-7000-8000-000000001854',
  nullRun: '01990000-0000-7000-8000-000000001855',
  review: '01990000-0000-7000-8000-000000001856',
  reviewLens: '01990000-0000-7000-8000-000000001857',
  reviewFinding: '01990000-0000-7000-8000-000000001858',
  reviewRead: '01990000-0000-7000-8000-000000001859',
  landing: '01990000-0000-7000-8000-00000000185a',
  landingOverride: '01990000-0000-7000-8000-00000000185b',
  pullRequestCi: '01990000-0000-7000-8000-00000000185c',
  contention: '01990000-0000-7000-8000-00000000185d',
  testFlake: '01990000-0000-7000-8000-00000000185e',
  branchDisposal: '01990000-0000-7000-8000-00000000185f',
  question: '01990000-0000-7000-8000-000000001860',
  release: '01990000-0000-7000-8000-000000001861',
} as const

const arrayString = `to_jsonb('["a"]'::text)`
const objectString = `to_jsonb('{"k":1}'::text)`
const structuredArray = `'["a"]'::jsonb`
const structuredObject = `'{"k":1}'::jsonb`

export async function seedRepair(transaction: Transaction, userId: string): Promise<void> {
  const input = { spaceId: PLATFORM_SPACE_ID, userId }
  await transaction.exec(`
    SELECT set_config('app.space_id', '${input.spaceId}', true);
    SELECT set_config('app.user_id', '${input.userId}', true);
    INSERT INTO machine (id, user_id, name, registered_at, last_seen)
    VALUES ('${ids.machine}', '${input.userId}', 'DEV-1885 jsonb repair proof', now(), now());
    INSERT INTO "run"
      (id, space_id, machine_id, started_by_user_id, started_at, agent, job, prompt_sha,
       prompt_bytes, prompt_head, probe, status, turn, changed_paths, doc_revisions,
       outside_worktree_writes, review_provenance, no_failover, automatic_failover,
       work_preserved, provisioning_phases, provisioning_host_load, provisioning_entry_roots,
       withheld_fields, created_at, updated_at)
    VALUES
      ('${ids.run}', '${input.spaceId}', '${ids.machine}', '${input.userId}', now(),
       'migration-check', 'proof', 'prompt', 6, 'prompt', false, 'ok', 1,
       ${arrayString}, ${arrayString}, ${arrayString}, ${objectString}, false, false, false,
       ${arrayString}, ${objectString}, ${arrayString}, ${arrayString}, now(), now()),
      ('${ids.structuredRun}', '${input.spaceId}', '${ids.machine}', '${input.userId}', now(),
       'migration-check', 'proof', 'prompt', 6, 'prompt', false, 'ok', 1,
       ${structuredArray}, ${structuredArray}, ${structuredArray}, ${structuredObject},
       false, false, false, ${structuredArray}, ${structuredObject}, ${structuredArray},
       ${structuredArray}, now(), now()),
      ('${ids.invalidRun}', '${input.spaceId}', '${ids.machine}', '${input.userId}', now(),
       'migration-check', 'proof', 'prompt', 6, 'prompt', false, 'ok', 1,
       to_jsonb('not json'::text), NULL, NULL, NULL, false, false, false,
       NULL, NULL, NULL, NULL, now(), now()),
      ('${ids.nullRun}', '${input.spaceId}', '${ids.machine}', '${input.userId}', now(),
       'migration-check', 'proof', 'prompt', 6, 'prompt', false, 'ok', 1,
       NULL, NULL, NULL, NULL, false, false, false, NULL, NULL, NULL, NULL, now(), now());
    INSERT INTO run_score
      (run_id, space_id, delivery, quality, fidelity, scored_at, scored_by, withheld_fields, updated_at)
    VALUES ('${ids.run}', '${input.spaceId}', 'full', 'right', 'faithful', now(),
      'migration-check', ${arrayString}, now());
    INSERT INTO review
      (id, space_id, machine_id, recorded_at, role, tier_reasons, path_set, withheld_fields,
       created_at, updated_at)
    VALUES ('${ids.review}', '${input.spaceId}', '${ids.machine}', now(), 'round',
      ${arrayString}, ${arrayString}, ${arrayString}, now(), now());
    INSERT INTO review_lens
      (id, space_id, review_id, run_id, machine_id, lens, agent, standards_read,
       files_covered, commands_run, could_not_verify, mcp_tools, docs_read, substitutes,
       withheld_fields, created_at, updated_at)
    VALUES ('${ids.reviewLens}', '${input.spaceId}', '${ids.review}', '${ids.run}',
      '${ids.machine}', 'proof', 'migration-check', ${arrayString}, ${arrayString},
      ${arrayString}, ${arrayString}, ${arrayString}, ${arrayString}, ${arrayString},
      ${arrayString}, now(), now());
    INSERT INTO review_finding
      (id, space_id, review_id, review_lens_id, machine_id, ordinal, severity, location,
       evidence, proposed_correction, withheld_fields, created_at, updated_at)
    VALUES ('${ids.reviewFinding}', '${input.spaceId}', '${ids.review}', '${ids.reviewLens}',
      '${ids.machine}', 1, 'major', 'proof', 'proof', 'proof', ${arrayString}, now(), now());
    INSERT INTO review_read
      (id, space_id, machine_id, branch, tip, patch_id, path_set, tier, note, recorded_at,
       withheld_fields, created_at, updated_at)
    VALUES ('${ids.reviewRead}', '${input.spaceId}', '${ids.machine}', 'proof', 'tip', 'patch',
      ${arrayString}, 1, 'proof', now(), ${arrayString}, now(), now());
    INSERT INTO landing
      (id, space_id, machine_id, branch, status, started_at, path_set, steps, withheld_fields,
       created_at, updated_at)
    VALUES ('${ids.landing}', '${input.spaceId}', '${ids.machine}', 'proof', 'started', now(),
      ${arrayString}, ${arrayString}, ${arrayString}, now(), now());
    INSERT INTO landing_override
      (id, space_id, machine_id, branch, tip, tree, path_set, reason, attribution,
       missing_lenses, at, withheld_fields, created_at, updated_at)
    VALUES ('${ids.landingOverride}', '${input.spaceId}', '${ids.machine}', 'proof', 'tip',
      'tree', ${arrayString}, 'proof', 'operator', ${structuredArray}, now(), ${arrayString},
      now(), now());
    INSERT INTO pull_request_ci
      (id, space_id, machine_id, pr_number, record_kind, failed_jobs, recorded_at,
       withheld_fields, created_at, updated_at)
    VALUES ('${ids.pullRequestCi}', '${input.spaceId}', '${ids.machine}', 1885, 'proof',
      ${arrayString}, now(), ${arrayString}, now(), now());
    INSERT INTO contention
      (id, space_id, machine_id, at, resource_kind, resource_key, event_kind, withheld_fields,
       created_at, updated_at)
    VALUES ('${ids.contention}', '${input.spaceId}', '${ids.machine}', now(), 'proof', 'proof',
      'proof', ${arrayString}, now(), now());
    INSERT INTO test_flake
      (id, space_id, machine_id, test, file, load_at_failure, at, withheld_fields,
       created_at, updated_at)
    VALUES ('${ids.testFlake}', '${input.spaceId}', '${ids.machine}', 'proof', 'proof.ts',
      ${objectString}, now(), ${arrayString}, now(), now());
    INSERT INTO branch_disposal
      (id, space_id, machine_id, branch, tip, reason, note, archive_ref, archive_expires_at,
       actor_session, disposed_at, withheld_fields, created_at, updated_at)
    VALUES ('${ids.branchDisposal}', '${input.spaceId}', '${ids.machine}', 'proof', 'tip',
      'proof', 'proof', 'archive', now(), 'proof', now(), ${arrayString}, now(), now());
    INSERT INTO question
      (id, space_id, run_id, machine_id, revision, asked_at, question, options,
       withheld_fields, created_at, updated_at)
    VALUES ('${ids.question}', '${input.spaceId}', '${ids.run}', '${ids.machine}', 1, now(),
      'proof?', ${arrayString}, ${arrayString}, now(), now());
    INSERT INTO release
      (id, space_id, machine_id, rung, candidate_commit, rollback, actor, started_at,
       withheld_fields, created_at, updated_at)
    VALUES ('${ids.release}', '${input.spaceId}', '${ids.machine}', 'proof', 'commit', false,
      'migration-check', now(), ${arrayString}, now(), now());
    SELECT set_config('app.space_id', '', true);
    SELECT set_config('app.user_id', '', true);
  `)
}

type JsonbProofRow = { label: string; kind: string; value: unknown }

export async function proveRepair(transaction: Transaction, userId: string): Promise<void> {
  const input = { spaceId: PLATFORM_SPACE_ID, userId }
  await transaction.exec(`
    SELECT set_config('app.space_id', '${input.spaceId}', true);
    SELECT set_config('app.user_id', '${input.userId}', true);
  `)
  const repaired = await transaction.query<JsonbProofRow>(`
    SELECT label, jsonb_typeof(value) AS kind, value
    FROM (VALUES
      ('run.changed_paths', (SELECT changed_paths FROM "run" WHERE id='${ids.run}')),
      ('run.doc_revisions', (SELECT doc_revisions FROM "run" WHERE id='${ids.run}')),
      ('run.outside_worktree_writes', (SELECT outside_worktree_writes FROM "run" WHERE id='${ids.run}')),
      ('run.review_provenance', (SELECT review_provenance FROM "run" WHERE id='${ids.run}')),
      ('run.provisioning_phases', (SELECT provisioning_phases FROM "run" WHERE id='${ids.run}')),
      ('run.provisioning_host_load', (SELECT provisioning_host_load FROM "run" WHERE id='${ids.run}')),
      ('run.provisioning_entry_roots', (SELECT provisioning_entry_roots FROM "run" WHERE id='${ids.run}')),
      ('run.withheld_fields', (SELECT withheld_fields FROM "run" WHERE id='${ids.run}')),
      ('run_score.withheld_fields', (SELECT withheld_fields FROM run_score WHERE run_id='${ids.run}')),
      ('review.tier_reasons', (SELECT tier_reasons FROM review WHERE id='${ids.review}')),
      ('review.path_set', (SELECT path_set FROM review WHERE id='${ids.review}')),
      ('review.withheld_fields', (SELECT withheld_fields FROM review WHERE id='${ids.review}')),
      ('review_lens.standards_read', (SELECT standards_read FROM review_lens WHERE id='${ids.reviewLens}')),
      ('review_lens.files_covered', (SELECT files_covered FROM review_lens WHERE id='${ids.reviewLens}')),
      ('review_lens.commands_run', (SELECT commands_run FROM review_lens WHERE id='${ids.reviewLens}')),
      ('review_lens.could_not_verify', (SELECT could_not_verify FROM review_lens WHERE id='${ids.reviewLens}')),
      ('review_lens.mcp_tools', (SELECT mcp_tools FROM review_lens WHERE id='${ids.reviewLens}')),
      ('review_lens.docs_read', (SELECT docs_read FROM review_lens WHERE id='${ids.reviewLens}')),
      ('review_lens.substitutes', (SELECT substitutes FROM review_lens WHERE id='${ids.reviewLens}')),
      ('review_lens.withheld_fields', (SELECT withheld_fields FROM review_lens WHERE id='${ids.reviewLens}')),
      ('review_finding.withheld_fields', (SELECT withheld_fields FROM review_finding WHERE id='${ids.reviewFinding}')),
      ('review_read.path_set', (SELECT path_set FROM review_read WHERE id='${ids.reviewRead}')),
      ('review_read.withheld_fields', (SELECT withheld_fields FROM review_read WHERE id='${ids.reviewRead}')),
      ('landing.path_set', (SELECT path_set FROM landing WHERE id='${ids.landing}')),
      ('landing.steps', (SELECT steps FROM landing WHERE id='${ids.landing}')),
      ('landing.withheld_fields', (SELECT withheld_fields FROM landing WHERE id='${ids.landing}')),
      ('landing_override.path_set', (SELECT path_set FROM landing_override WHERE id='${ids.landingOverride}')),
      ('landing_override.missing_lenses', (SELECT missing_lenses FROM landing_override WHERE id='${ids.landingOverride}')),
      ('landing_override.withheld_fields', (SELECT withheld_fields FROM landing_override WHERE id='${ids.landingOverride}')),
      ('pull_request_ci.failed_jobs', (SELECT failed_jobs FROM pull_request_ci WHERE id='${ids.pullRequestCi}')),
      ('pull_request_ci.withheld_fields', (SELECT withheld_fields FROM pull_request_ci WHERE id='${ids.pullRequestCi}')),
      ('contention.withheld_fields', (SELECT withheld_fields FROM contention WHERE id='${ids.contention}')),
      ('test_flake.load_at_failure', (SELECT load_at_failure FROM test_flake WHERE id='${ids.testFlake}')),
      ('test_flake.withheld_fields', (SELECT withheld_fields FROM test_flake WHERE id='${ids.testFlake}')),
      ('branch_disposal.withheld_fields', (SELECT withheld_fields FROM branch_disposal WHERE id='${ids.branchDisposal}')),
      ('question.options', (SELECT options FROM question WHERE id='${ids.question}')),
      ('question.withheld_fields', (SELECT withheld_fields FROM question WHERE id='${ids.question}')),
      ('release.withheld_fields', (SELECT withheld_fields FROM release WHERE id='${ids.release}'))
    ) AS repaired(label, value)
    ORDER BY label
  `)
  const objectColumns = new Set([
    'run.provisioning_host_load',
    'run.review_provenance',
    'test_flake.load_at_failure',
  ])
  const invalidRepair = repaired.rows.find(
    (row) =>
      row.kind !== (objectColumns.has(row.label) ? 'object' : 'array') ||
      JSON.stringify(row.value) !== JSON.stringify(objectColumns.has(row.label) ? { k: 1 } : ['a']),
  )
  if (invalidRepair) {
    throw new Error(`DEV-1885 jsonb string repair produced ${JSON.stringify(invalidRepair)}`)
  }

  const untouched = await transaction.query<{
    structured: boolean
    invalid: boolean
    null_value: boolean
  }>(`
    SELECT
      changed_paths='["a"]'::jsonb AND doc_revisions='["a"]'::jsonb
        AND outside_worktree_writes='["a"]'::jsonb AND review_provenance='{"k":1}'::jsonb
        AND provisioning_phases='["a"]'::jsonb AND provisioning_host_load='{"k":1}'::jsonb
        AND provisioning_entry_roots='["a"]'::jsonb AND withheld_fields='["a"]'::jsonb
        AS structured,
      (SELECT changed_paths=to_jsonb('not json'::text) FROM "run" WHERE id='${ids.invalidRun}')
        AS invalid,
      (SELECT changed_paths IS NULL FROM "run" WHERE id='${ids.nullRun}') AS null_value
    FROM "run" WHERE id='${ids.structuredRun}'
  `)
  if (
    !untouched.rows[0]?.structured ||
    !untouched.rows[0].invalid ||
    !untouched.rows[0].null_value
  ) {
    throw new Error(
      `DEV-1885 jsonb string repair changed an excluded value: ${JSON.stringify(untouched.rows)}`,
    )
  }

  const rls = await transaction.query<{ relname: string; relforcerowsecurity: boolean }>(`
    SELECT relname, relforcerowsecurity
    FROM pg_class
    WHERE relname IN ('run','run_score','review','review_lens','review_finding','review_read',
      'landing','landing_override','pull_request_ci','contention','test_flake','branch_disposal',
      'question','release')
    ORDER BY relname
  `)
  if (rls.rows.length !== 14 || rls.rows.some((row) => !row.relforcerowsecurity)) {
    throw new Error(
      `DEV-1885 jsonb string repair did not restore forced RLS: ${JSON.stringify(rls.rows)}`,
    )
  }
  await transaction.exec(`
    SELECT set_config('app.space_id', '', true);
    SELECT set_config('app.user_id', '', true);
  `)
}
