import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TestSubstanceJudgment } from '../../shared/test-substance/test-substance.ts'
import {
  MAX_TEST_FILE_BYTES,
  reconstructTestEdit,
  testSubstanceJudgeCommand,
} from './test-substance-commands.ts'

const file = '/project/example.test.ts'
const payload = (tool_name: string, tool_input: Record<string, unknown>) => ({
  tool_name,
  tool_input: { file_path: file, ...tool_input },
})
const read = () => 'first first\nsecond\n'

describe('test edit reconstruction', () => {
  test('Edit replaces once or everywhere and reports no match', () => {
    expect(
      reconstructTestEdit(payload('Edit', { old_string: 'first', new_string: 'new' }), read),
    ).toMatchObject({ status: 'ready', input: { after: 'new first\nsecond\n' } })
    expect(
      reconstructTestEdit(
        payload('Edit', { old_string: 'first', new_string: '$& and $$', replace_all: true }),
        read,
      ),
    ).toMatchObject({ status: 'ready', input: { after: '$& and $$ $& and $$\nsecond\n' } })
    expect(
      reconstructTestEdit(payload('Edit', { old_string: 'absent', new_string: 'new' }), read),
    ).toMatchObject({ status: 'unchecked', reason: 'old_string does not occur in the file' })
  })

  test('MultiEdit applies entries in order', () => {
    expect(
      reconstructTestEdit(
        payload('MultiEdit', {
          edits: [
            { old_string: 'first first', new_string: 'created' },
            { old_string: 'created', new_string: 'finished' },
          ],
        }),
        read,
      ),
    ).toMatchObject({ status: 'ready', input: { after: 'finished\nsecond\n' } })
  })
})

describe('test-substance judge verb', () => {
  const decision = (status: TestSubstanceJudgment['status']): TestSubstanceJudgment => ({
    status,
    findings:
      status === 'refused'
        ? [{ test: 'empty', rule: 'no-assertion', message: 'empty test', line: 2 }]
        : [],
    reason: status === 'unchecked' ? 'parse failed' : '',
  })

  for (const status of ['refused', 'ok', 'unchecked'] as const) {
    test(`prints the ${status} decision`, async () => {
      expect(
        await testSubstanceJudgeCommand(
          JSON.stringify({ file, before: null, after: 'content' }),
          false,
          async () => decision(status),
        ),
      ).toEqual(decision(status))
    })
  }

  test('a non-test path returns ok without loading detectors', async () => {
    const input = JSON.stringify({ file: '/project/source.ts', before: null, after: 'content' })
    const result = await testSubstanceJudgeCommand(input, false)
    expect(result).toEqual({ status: 'ok', findings: [], reason: '' })
  })

  test('accepts and forwards PHP policy rules', async () => {
    let received: readonly string[] | undefined
    await testSubstanceJudgeCommand(
      JSON.stringify({
        file: '/project/tests/Feature/FooTest.php',
        before: null,
        after: '<?php',
        phpPolicyRules: ['createMock'],
      }),
      false,
      async (input) => {
        received = input.phpPolicyRules
        return decision('ok')
      },
    )
    expect(received).toEqual(['createMock'])
  })

  test('raw tool input with a marker but unsupported extension returns ok without reading', async () => {
    const result = await testSubstanceJudgeCommand(
      JSON.stringify(payload('Write', { file_path: '/missing/example.test.mtsx', content: 'x' })),
      true,
    )
    expect(result).toEqual({ status: 'ok', findings: [], reason: '' })
  })

  test('a non-regular target is unchecked', async () => {
    const root = mkdtempSync(join(tmpdir(), 'test-substance-directory-'))
    try {
      const directory = join(root, 'example.test.ts')
      mkdirSync(directory)
      const result = await testSubstanceJudgeCommand(
        JSON.stringify(payload('Edit', { file_path: directory, old_string: 'x', new_string: 'y' })),
        true,
      )
      expect(result).toEqual({
        status: 'unchecked',
        findings: [],
        reason: 'target is not a regular file',
      })
    } finally {
      rmSync(root, { recursive: true })
    }
  })

  test('oversized proposed content is unchecked', async () => {
    const result = await testSubstanceJudgeCommand(
      JSON.stringify({
        file,
        before: null,
        after: 'x'.repeat(MAX_TEST_FILE_BYTES + 1),
      }),
      false,
    )
    expect(result).toEqual({
      status: 'unchecked',
      findings: [],
      reason: `proposed content is larger than ${MAX_TEST_FILE_BYTES} bytes`,
    })
  })
})
