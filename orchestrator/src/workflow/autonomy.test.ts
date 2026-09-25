import { describe, expect, test } from 'bun:test'
import {
  answerRulingRefusal,
  parseAutonomy,
  resolveAutonomy,
  validateAutonomySettings,
} from './autonomy.ts'

const steps = [
  { slug: 'design', stage: 'plan' as const, autonomy: 'ask' as const },
  { slug: 'verify', stage: 'implement' as const, autonomy: 'auto' as const },
]

describe('autonomy resolution', () => {
  test('scope order and within-scope precedence resolve each step independently', () => {
    const result = resolveAutonomy(steps, [
      { name: 'session', settings: { stages: { implement: 'review' } } },
      {
        name: 'project',
        settings: { preset: 'manual', stages: { plan: 'auto' }, steps: { design: 'review' } },
      },
    ])
    expect(result.steps).toEqual({
      design: { value: 'review', scope: 'project' },
      verify: { value: 'review', scope: 'session' },
    })
  })

  test('workflow settings beat general settings only within their scope', () => {
    expect(
      resolveAutonomy(
        steps,
        [
          { name: 'higher', settings: { stages: { plan: 'review' } } },
          {
            name: 'lower',
            settings: { workflows: { ship: { steps: { design: 'auto' } } } },
          },
        ],
        'ship',
      ).steps.design,
    ).toEqual({ value: 'review', scope: 'higher' })
    expect(
      resolveAutonomy(
        steps,
        [
          {
            name: 'same',
            settings: {
              steps: { design: 'ask' },
              workflows: { ship: { preset: 'autonomous' } },
            },
          },
        ],
        'ship',
      ).steps.design,
    ).toEqual({ value: 'auto', scope: 'same' })
  })

  test('presets and guided defaults resolve with their deciding scope', () => {
    expect(
      resolveAutonomy(steps, [{ name: 'manual', settings: { preset: 'manual' } }]).steps,
    ).toEqual({
      design: { value: 'ask', scope: 'manual' },
      verify: { value: 'ask', scope: 'manual' },
    })
    expect(
      resolveAutonomy(steps, [{ name: 'auto', settings: { preset: 'autonomous' } }]).steps,
    ).toEqual({
      design: { value: 'auto', scope: 'auto' },
      verify: { value: 'auto', scope: 'auto' },
    })
    expect(
      resolveAutonomy(steps, [{ name: 'guided', settings: { preset: 'guided' } }]).steps,
    ).toEqual({
      design: { value: 'ask', scope: 'guided' },
      verify: { value: 'auto', scope: 'guided' },
    })
  })

  test('empty stages resolve only settings shared by every step in the stage', () => {
    const canon = ['canon'] as const
    expect(resolveAutonomy(steps, [], undefined, canon).stages?.canon).toEqual({
      value: 'per step',
      scope: 'built-in',
    })
    expect(
      resolveAutonomy(steps, [{ name: 'guided', settings: { preset: 'guided' } }], undefined, canon)
        .stages?.canon,
    ).toEqual({ value: 'per step', scope: 'guided' })
    expect(
      resolveAutonomy(
        steps,
        [{ name: 'explicit', settings: { preset: 'guided', stages: { canon: 'review' } } }],
        undefined,
        canon,
      ).stages?.canon,
    ).toEqual({ value: 'review', scope: 'explicit' })
    for (const [preset, value] of [
      ['manual', 'ask'],
      ['autonomous', 'auto'],
    ] as const) {
      expect(
        resolveAutonomy(steps, [{ name: preset, settings: { preset } }], undefined, canon).stages
          ?.canon,
      ).toEqual({ value, scope: preset })
    }
  })

  test('rulings and invalid values identify the deciding scope and key', () => {
    expect(
      resolveAutonomy(steps, [
        { name: 'higher', settings: {} },
        { name: 'hosted user', settings: { rulings: 'user' } },
      ]).rulings,
    ).toEqual({ value: 'user', scope: 'hosted user' })
    expect(() =>
      resolveAutonomy(steps, [{ name: 'local project', settings: { stages: { plan: 'manual' } } }]),
    ).toThrow('local project key stages.plan')
  })

  test('presets set rulings and explicit rulings beat the same scope preset', () => {
    for (const [preset, value] of [
      ['manual', 'user'],
      ['guided', 'agent'],
      ['autonomous', 'agent'],
    ] as const) {
      expect(resolveAutonomy(steps, [{ name: preset, settings: { preset } }]).rulings).toEqual({
        value,
        scope: preset,
      })
    }
    expect(
      resolveAutonomy(steps, [
        { name: 'session', settings: { preset: 'manual', rulings: 'agent' } },
      ]).rulings,
    ).toEqual({ value: 'agent', scope: 'session' })
  })

  test('workflow rulings follow their within-scope order and are ignored without a workflow', () => {
    const settings = {
      preset: 'manual',
      rulings: 'user',
      workflows: { ship: { preset: 'manual', rulings: 'agent' } },
    } as const
    expect(resolveAutonomy(steps, [{ name: 'same', settings }], 'ship').rulings).toEqual({
      value: 'agent',
      scope: 'same',
    })
    expect(resolveAutonomy(steps, [{ name: 'same', settings }]).rulings).toEqual({
      value: 'user',
      scope: 'same',
    })
    expect(
      resolveAutonomy(
        steps,
        [
          {
            name: 'same',
            settings: { rulings: 'user', workflows: { ship: { preset: 'guided' } } },
          },
        ],
        'ship',
      ).rulings,
    ).toEqual({ value: 'agent', scope: 'same' })
  })

  test('workflow grammar and nested validation preserve the full setting path', () => {
    expect(
      parseAutonomy(
        'workflow.ship.preset=guided,workflow.ship.rulings=user,workflow.ship.stage.review=auto,workflow.ship.step.lens=review',
        'session',
      ),
    ).toEqual({
      workflows: {
        ship: {
          preset: 'guided',
          rulings: 'user',
          stages: { review: 'auto' },
          steps: { lens: 'review' },
        },
      },
    })
    expect(() =>
      validateAutonomySettings(
        { workflows: { 'fix-defect': { stages: { review: 'manual' } } } },
        'project',
      ),
    ).toThrow('project key workflows.fix-defect.stages.review: manual')
  })

  test('answer decision refuses user rulings unless relayed by the operator', () => {
    const ruling = { value: 'user' as const, scope: 'local user' }
    expect(answerRulingRefusal(ruling, false)).toBe(
      'rulings is user (local user): relay this question to the operator and answer with --from-operator',
    )
    expect(answerRulingRefusal(ruling, true)).toBeNull()
    expect(
      answerRulingRefusal(
        { value: 'agent', scope: 'built-in', complete: false, unavailableReason: 'offline' },
        false,
      ),
    ).toBe(
      'rulings could not be resolved: hosted autonomy settings unavailable (offline); answer with --from-operator, or set rulings in machine.toml or the project register',
    )
  })
})
