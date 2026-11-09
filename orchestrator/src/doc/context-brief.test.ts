import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { type ContextBrief, renderContextBrief } from './context-brief.ts'

const item = (
  holder: string,
  id: string,
  kind: ContextBrief['holders'][number]['items'][number]['kind'],
  body: string,
  source = 'task-doc',
) => ({ holder, id, kind, body, source })

test('renders the compact context layout line by line and keeps only item first lines', () => {
  const brief: ContextBrief = {
    session: '65fbe830',
    fullCommand: `${PLATFORM_SLUG} agent context show --task DEV-1844/2`,
    holders: [
      {
        key: '65fbe830',
        title: '',
        kind: 'session',
        items: [item('session:65fbe830', 'weekend', 'fact', 'work autonomously\nthrough Sunday')],
      },
      {
        key: 'DEV-1844/2',
        title: 'Build the brief',
        kind: 'task',
        items: [item('task:DEV-1844/2', 'next', 'next-action', 'implement the renderer')],
      },
      {
        key: 'DEV-1844',
        title: 'Architect context',
        kind: 'epic',
        items: [
          item('task:DEV-1844', 'approved', 'ruling', 'Approved as proposed\nwith detail', 'q5282'),
        ],
      },
    ],
    runs: [
      { number: 31110, job: 'implement', status: 'running' },
      { number: 31111, job: 'review', status: 'asking' },
    ],
    cursors: [
      { number: 1369, workflow: 'plan-task', state: 'awaiting-ruling', questionNumber: 5277 },
    ],
    claims: [{ kind: 'task', value: 'DEV-1844/2' }],
    waiting: { boardRequests: 2, questions: 0, resumeBriefs: 1 },
    autonomy: 'plan review · implement, review, docs, canon auto · ship trunk',
  }

  expect(renderContextBrief(brief).split('\n')).toEqual([
    `Context (session 65fbe830) · full: ${PLATFORM_SLUG} agent context show --task DEV-1844/2`,
    'Session 65fbe830',
    '  fact: work autonomously',
    '  open: none',
    'DEV-1844/2 Build the brief',
    '  next: implement the renderer',
    '  open: none',
    'DEV-1844 Architect context',
    '  ruling q5282: "Approved as proposed"',
    '  open: none',
    'In flight: run 31110 implement running · run 31111 review asking · cursor 1369 plan-task, awaiting q5277 · claim task:DEV-1844/2',
    `Waiting: 2 board requests (${PLATFORM_SLUG} board read) · 0 questions · 1 resume brief (${PLATFORM_SLUG} doc resumes)`,
    'Autonomy: plan review · implement, review, docs, canon auto · ship trunk',
  ])
})
