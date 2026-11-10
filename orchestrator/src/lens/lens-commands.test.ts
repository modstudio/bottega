import { expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Command } from 'commander'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import {
  createMemoryRecordApiClient,
  installRecordApiClient,
} from '../../test/fixtures/record-api.ts'
import { run } from '../cli/program.ts'
import { registerLensCommands } from '../commands/lens.ts'
import { db } from '../database/db.ts'
import { upsertProject } from '../project/projects.ts'
import { rememberProjectSpace } from '../project-space.ts'
import { setProfileCommand } from './lens-commands.ts'

const slots = JSON.stringify({
  type: 'object',
  properties: { looks_for: { type: 'string' } },
  additionalProperties: false,
})

function setCommand(title: string, requiresExecution: boolean): string[] {
  return [
    'lens',
    'set',
    'command-fixture',
    '--title',
    title,
    '--question',
    'What should be checked?',
    '--excludes',
    'Unrelated concerns.',
    '--slots',
    slots,
    '--enabled',
    'true',
    '--requires-execution',
    String(requiresExecution),
    '--reason',
    'command test',
    '--json',
  ]
}

test('review lens preserves the unknown-verb refusal and exit status', async () => {
  const errors: string[] = []
  const error = spyOn(console, 'error').mockImplementation((value) => errors.push(String(value)))
  try {
    expect(await run(['lens', 'bogus'])).toBe(1)
  } finally {
    error.mockRestore()
  }
  expect(errors).toEqual([`unknown: ${PLATFORM_SLUG} review lens. Try list | show | set | profile`])
})

test('lens set adds and changes a lens including requires-execution', async () => {
  const output: string[] = []
  const presentation = { log: (value: string) => output.push(value) }
  for (const argv of [setCommand('First title', false), setCommand('Changed title', true)]) {
    const program = new Command().exitOverride()
    registerLensCommands(program, presentation)
    await program.parseAsync(['node', 'orch', ...argv])
  }

  expect(JSON.parse(output[0]!)).toMatchObject({
    id: 'command-fixture',
    title: 'First title',
    requires_execution: false,
  })
  expect(JSON.parse(output[1]!)).toMatchObject({
    id: 'command-fixture',
    title: 'Changed title',
    version: 2,
    requires_execution: true,
  })
})

test('profile show reads the named project space', async () => {
  const space = newRecordId()
  const project = `profile-show-${newRecordId()}`
  upsertProject({ recordId: newRecordId(), name: project, path: `/tmp/${project}`, settings: {} })
  db()
    .query(
      `INSERT INTO lens (record_id,space_id,id,title,question,excludes,slots,version,enabled,requires_execution)
       SELECT ?,?,id,title,question,excludes,slots,version,enabled,requires_execution
       FROM lens WHERE id='correctness' AND space_id IS NULL`,
    )
    .run(newRecordId(), space)
  db()
    .query(
      `INSERT INTO lens_profile (record_id,space_id,lens_record_id,axis,name,version,current_version_id,body,enabled)
       VALUES (?,?,(SELECT record_id FROM lens WHERE id='correctness' AND space_id=?),'framework','project-show',1,?,?,1)`,
    )
    .run(
      newRecordId(),
      space,
      space,
      newRecordId(),
      '{"framework_guidance":"Project show.","commands":"bun test"}',
    )
  rememberProjectSpace(db(), project, space)

  const output: string[] = []
  const program = new Command().exitOverride()
  registerLensCommands(program, { log: (value) => output.push(value) })
  await program.parseAsync([
    'node',
    'orch',
    'lens',
    'profile',
    'show',
    'correctness',
    '--axis',
    'framework',
    '--name',
    'project-show',
    '--project',
    project,
    '--json',
  ])

  expect(JSON.parse(output[0]!)).toMatchObject({
    lens_id: 'correctness',
    name: 'project-show',
    space_id: space,
  })
})

test('profile set refuses a missing owner before any hosted call', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lens-profile-owner-edge-'))
  let hostedCalls = 0
  process.env.BOTTEGA_RECORD_API_URL = 'https://record.example.test'
  installRecordApiClient({
    ...createMemoryRecordApiClient(),
    async whoami() {
      hostedCalls += 1
      throw new Error('lens profile owner refusal reached the hosted record')
    },
  })
  try {
    await expect(
      setProfileCommand(
        [
          'lens',
          'profile',
          'set',
          'correctness',
          '--axis',
          'framework',
          '--name',
          'owner-edge',
          '--body',
          '{"framework_guidance":"Fixture.","commands":"bun test"}',
          '--enabled',
          'true',
          '--reason',
          'owner edge test',
        ],
        () => {},
        root,
      ),
    ).rejects.toThrow(
      'lens profile set writes to a record space and names none; pass --space <slug>, or --project <name>',
    )
    expect(hostedCalls).toBe(0)
  } finally {
    delete process.env.BOTTEGA_RECORD_API_URL
    installRecordApiClient(null)
    rmSync(root, { recursive: true, force: true })
  }
})
