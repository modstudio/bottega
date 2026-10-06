import { PLATFORM_NAME } from '../../../../shared/brand.ts'
import { Cards, Cta, PageHero, Section } from './shared'

export function ContextPage() {
  return (
    <main className="site-page">
      <PageHero
        crumb="Context management"
        title="A handoff you read,"
        muted="not a compaction you hope about."
        copy={`Long work outlives a session. When the window fills, the usual answer is automatic compaction — something summarizes your context, you are not shown what it dropped, and you find out later by discovering what the next turn forgot. ${PLATFORM_NAME} makes the handoff an artifact instead: written deliberately, reviewed by you, and chosen when it is picked up.`}
        actions={[
          ['/docs', 'Read the context guide'],
          ['/product/doc-store', 'See the doc store'],
        ]}
      />
      <Section title="Decisions survive the session that made them">
        <Cards
          two
          items={[
            {
              eyebrow: 'Task docs',
              title: 'The plan lives on the task',
              text: 'A task carries its own documents — the specification, the research that settled a decision, the acceptance criteria.',
            },
            {
              eyebrow: 'Epic handoffs',
              title: 'Work larger than one task',
              text: "An epic's state — what is done, what is next, which rulings already stand — is a document with a handoff role.",
            },
            {
              eyebrow: 'Resume briefs',
              title: 'Written at a boundary, on purpose',
              text: 'At a task or epic boundary — and before any clear or compaction — a brief is offered.',
            },
            {
              eyebrow: 'You choose',
              title: 'Nothing resumes itself',
              text: 'Open briefs are listed when a session starts, and a session never consumes one you did not pick.',
            },
          ]}
        />
      </Section>
      <Section
        eyebrow="Resume brief"
        title="Where it stands. Rulings that stand. What is open. What must not happen yet."
      >
        <div className="site-panel">
          <pre>{`Where it stands\nImplemented and gated. One finding open.\n\nRulings that stand\n· Retry only the new path.\n· Backoff is capped, not unbounded.\n\nOpen, needs a decision\n· Whether a 429 counts against the budget.\n\nDo not\n· Land while the budget question is open.`}</pre>
        </div>
      </Section>
      <Cta
        title={
          <>
            Decisions survive
            <br />
            the session that made them.
          </>
        }
      />
    </main>
  )
}
