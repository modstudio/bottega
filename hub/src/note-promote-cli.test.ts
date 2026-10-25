import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { promotionFlags } from './note-promote-cli.ts'

describe('note promotion flags', () => {
  test('a creating promotion refuses without a title, naming the flag', () => {
    expect(() => promotionFlags({ taskFlagPresent: false, titleFlagPresent: false })).toThrow(
      `${PLATFORM_SLUG} note promote <LABEL> --title "<the point>"`,
    )
    expect(() =>
      promotionFlags({ title: '   ', titleFlagPresent: true, taskFlagPresent: false }),
    ).toThrow(`${PLATFORM_SLUG} note promote <LABEL> --title "<the point>"`)
  })

  test('a title names the created task, trimmed', () => {
    expect(
      promotionFlags({
        title: '  note promote gives the task a title, not the note body  ',
        titleFlagPresent: true,
        taskFlagPresent: false,
      }),
    ).toEqual({
      taskKey: undefined,
      title: 'note promote gives the task a title, not the note body',
    })
  })

  test('linking an existing task refuses a title it would ignore', () => {
    expect(() =>
      promotionFlags({
        task: 'DEV-42',
        taskFlagPresent: true,
        title: 'ignored',
        titleFlagPresent: true,
      }),
    ).toThrow('--title names the task a promotion creates, but --task links the existing one')
    expect(
      promotionFlags({ task: 'DEV-42', taskFlagPresent: true, titleFlagPresent: false }),
    ).toEqual({ taskKey: 'DEV-42', title: undefined })
  })

  test('distinguishes an absent task option from a bare or blank one', () => {
    expect(() => promotionFlags({ taskFlagPresent: true, titleFlagPresent: false })).toThrow(
      `${PLATFORM_SLUG} note promote <LABEL|UUID|NUMBER> --task <KEY>`,
    )
    expect(() =>
      promotionFlags({ task: '  ', taskFlagPresent: true, titleFlagPresent: false }),
    ).toThrow(`${PLATFORM_SLUG} note promote <LABEL|UUID|NUMBER> --task <KEY>`)
  })
})
