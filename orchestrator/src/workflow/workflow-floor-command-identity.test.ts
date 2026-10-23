import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_NAME, PLATFORM_SLUG } from '../../../shared/brand.ts'
import { DIST_MANIFEST, INSTALL_HOME_ENV } from '../../../shared/install-root.ts'
import { newRecordId } from '../../../shared/record/schema.ts'
import { testDatabaseFixture } from '../database/test-database.fixture.ts'
import { bottegaVerbArgv, decideFloorSatisfaction, type Floor } from './workflow-floor.ts'
import {
  bottegaCommandIdentity,
  type CursorIdentity,
  type FloorEvidencePorts,
  gatherValidatedEvidence,
} from './workflow-floor-evidence.ts'

test(`command identity accepts only registered ${PLATFORM_SLUG} executable paths`, () => {
  const root = mkdtempSync(join(tmpdir(), `workflow-${PLATFORM_SLUG}-command-`))
  const main = join(root, 'main')
  const installed = join(root, 'installed')
  const executable = (directory: string, targetName: string) => {
    const bin = join(directory, 'bin')
    const target = join(root, targetName)
    mkdirSync(bin, { recursive: true })
    writeFileSync(target, '')
    const path = join(bin, PLATFORM_SLUG)
    symlinkSync(target, path)
    return path
  }
  const mainExecutable = executable(main, 'main-executable')
  const installedExecutable = executable(installed, 'installed-executable')
  const unrelatedExecutable = executable(join(root, 'unrelated'), 'unrelated-executable')
  writeFileSync(
    join(installed, DIST_MANIFEST),
    JSON.stringify({
      name: PLATFORM_NAME,
      version: 'test',
      built: '2026-09-01T00:00:00.000Z',
      commit: 'test',
    }),
  )

  const previousInstallHome = process.env[INSTALL_HOME_ENV]
  process.env[INSTALL_HOME_ENV] = installed
  try {
    const d = testDatabaseFixture((database) => {
      database
        .query('INSERT INTO project (record_id,name,path,stack,settings) VALUES (?,?,?,?,?)')
        .run(newRecordId(), PLATFORM_SLUG, main, 'bun', '{}')
    })()
    const accepts = (path: string) =>
      bottegaVerbArgv(
        [path, 'pr', 'create'],
        ['pr', 'create'],
        bottegaCommandIdentity(path, root, d),
      )

    expect(accepts(mainExecutable)).toBeTrue()
    expect(accepts(installedExecutable)).toBeTrue()
    expect(accepts(unrelatedExecutable)).toBeFalse()
  } finally {
    if (previousInstallHome === undefined) delete process.env[INSTALL_HOME_ENV]
    else process.env[INSTALL_HOME_ENV] = previousInstallHome
    rmSync(root, { recursive: true, force: true })
  }
})

test(`a recorded pr-create exec accepts the registered ${PLATFORM_SLUG} path only`, () => {
  const root = mkdtempSync(join(tmpdir(), `workflow-${PLATFORM_SLUG}-floor-`))
  const main = join(root, 'main')
  const mainExecutable = join(main, 'bin', PLATFORM_SLUG)
  const unrelatedExecutable = join(root, 'unrelated', PLATFORM_SLUG)
  const executable = (path: string, targetName: string) => {
    mkdirSync(join(path, '..'), { recursive: true })
    const target = join(root, targetName)
    writeFileSync(target, '')
    symlinkSync(target, path)
  }
  executable(mainExecutable, 'main-executable')
  executable(unrelatedExecutable, 'unrelated-executable')

  try {
    const d = testDatabaseFixture((database) => {
      database
        .query('INSERT INTO project (record_id,name,path,stack,settings) VALUES (?,?,?,?,?)')
        .run(newRecordId(), PLATFORM_SLUG, main, 'bun', '{}')
      database
        .query('INSERT INTO project (record_id,name,path,stack,settings) VALUES (?,?,?,?,?)')
        .run(newRecordId(), 'fixture', '/fixture', 'bun', '{"trunk":"main"}')
      database
        .query(
          `INSERT INTO workflow_cursor
          (record_id,project,workflow_slug,mode_slug,workflow_key,instance_id,session_id,
           workflow_version,catalogue_version,args,ordinal,step_slug,state,closed,question,
           total_steps,created_at,updated_at,enforcement)
         VALUES ('${newRecordId()}','fixture','flow','default','DEV-977','','s',1,1,'{}',0,'rebase','running','[]',NULL,
                 1,'2026-09-01','2026-09-01','floors')`,
        )
        .run()
    })()
    const url = 'https://github.com/acme/app/pull/15'
    const insertExec = (path: string) =>
      (
        d
          .query<{ id: number }, [string, string]>(
            `INSERT INTO probe
              (record_id,command,cwd,head_commit,exit_code,output_tail,created_at,kind,session_id)
             VALUES ('${newRecordId()}',?,'/fixture/work','abc',0,?,'2026-09-01','exec','s')
             RETURNING id`,
          )
          .get(JSON.stringify([path, 'pr', 'create']), `opened ${url}`) as { id: number }
      ).id
    const identity: CursorIdentity = {
      project: 'fixture',
      workflowKey: 'DEV-977',
      branch: 'DEV-977-work',
      worktree: '/fixture/work',
      session: 's',
      createdAt: '2026-09-01',
      stepActivatedAt: '2026-09-01',
    }
    const ports: FloorEvidencePorts = {
      resolveCheckout: () => ({
        project: 'fixture',
        branch: 'DEV-977-work',
        checkoutPath: '/fixture/work',
        headIsTipOrAncestor: true,
        landingBranch: 'main',
      }),
      resolveTreeCommit: () => 'abc',
      viewPullRequest: () => ({
        state: 'OPEN',
        mergedAt: null,
        headRefName: 'DEV-977-work',
        baseRefName: 'main',
        url,
      }),
      readOriginUrl: () => 'git@github.com:acme/app.git',
    }
    const floor: Floor = {
      kind: 'command-exit',
      deferrable: false,
      expectedExitCode: 0,
      expectedStatus: 'done',
      requirePullRequest: false,
      operatorRuling: false,
      commandEvidence: 'pull-request',
    }
    const decideExec = (id: number) =>
      decideFloorSatisfaction({
        floors: [floor],
        evidence: gatherValidatedEvidence({
          cursorId: 1,
          identity,
          stepOrdinal: 1,
          stepSlug: 'rebase',
          evidence: { artifact: `exec:${id}` },
          ports,
          d,
        }),
        enforcement: 'floors',
        finishing: false,
        openObligations: [],
      })

    expect(decideExec(insertExec(mainExecutable)).action).toBe('allow')
    const unrelated = decideExec(insertExec(unrelatedExecutable))
    expect(unrelated.action).toBe('refuse')
    if (unrelated.action === 'refuse')
      expect(unrelated.message).toContain(`the recorded command is not ${PLATFORM_SLUG} pr create`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
