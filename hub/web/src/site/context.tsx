import { Cards, Cta, PageHero, Panel } from './shared'

const cards = [
  [
    'Task docs',
    'The plan lives on the task',
    'A task carries its own documents — the specification it was built against, the research that settled a decision, the acceptance criteria. Attached to the key, so they travel with the work rather than sitting in one session’s scrollback.',
  ],
  [
    'Epic handoffs',
    'Work larger than one task',
    "An epic's state — what is done, what is next, which rulings already stand — is a document with a handoff role, so the next session starts from the decisions rather than re-deriving them.",
  ],
  [
    'Resume briefs',
    'Written at a boundary, on purpose',
    'At a task or epic boundary — and before any clear or compaction — a brief is offered. It records where the work stands, what was ruled and what remains open, in your words, not a summariser’s.',
  ],
  [
    'You choose',
    'Nothing resumes itself',
    'Open briefs are listed when a session starts, and a session never consumes one you did not pick. A handoff you did not choose is just another invisible context change.',
  ],
].map(([eyebrow, title, text]) => ({ eyebrow, title, text }))
export function ContextPage() {
  return (
    <main className="site-page">
      <PageHero
        crumb="Context management"
        title="A handoff you read,"
        muted="not a compaction you hope about."
        copy="Long work outlives a session. When the window fills, the usual answer is automatic compaction — something summarises your context, you are not shown what it dropped, and you find out later by discovering what the next turn forgot. Bottega makes the handoff an artifact instead: written deliberately, reviewed by you, and chosen when it is picked up."
        actions={[
          ['/docs', 'Read the context guide'],
          ['/product/doc-store', 'See the doc store'],
        ]}
      />
      <p className="wrap phero-micro">
        These are documents too — the same store as your technical docs, attached in different
        places: on the task, on the epic, and in a resume scope a new session can pick up.
      </p>
      <section className="section-tight">
        <div className="wrap">
          <div className="split split-start">
            <div>
              <Cards items={cards} columns={2} />
              <p className="context-note">
                The difference is control. Compaction is a lossy transform applied to your context
                without review. A brief is a document: you read it, you edit it, you decide when it
                is used — and it stays readable long after the session that wrote it is gone.
              </p>
            </div>
            <Panel eyebrow="Resume brief">
              <pre>
                $ <b>orch doc list</b> --scope resume{`\n\n`}
                <b> atlas · ATL-412</b>{' '}
                <span className="c">
                  webhook retries{`\n`} open brief · written at the review boundary{`\n\n`}
                  ──────────────────────────────────────────
                </span>
                {`\n`}
                <b> Where it stands</b>
                {`\n`}
                <span className="c">
                  {' '}
                  Implemented and gated. Two lenses clean,{`\n`} one finding open on retry budgets.
                </span>
                {`\n\n`}
                <b> Rulings that stand</b>
                {`\n`}
                <span className="c">
                  {' '}
                  · Retry only the new path; the two existing{`\n`} callers are a separate change
                  (noted).{`\n`} · Backoff is capped, not unbounded.
                </span>
                {`\n\n`}
                <b> Open, needs a decision</b>
                {`\n`}
                <span className="c"> · Whether a 429 counts against the budget.</span>
                {`\n\n`}
                <b> Do not</b>
                {`\n`}
                <span className="c">
                  {' '}
                  · Land while the budget question is open.{`\n`}
                  ──────────────────────────────────────────{`\n\n`} resume it, or leave it and
                  start fresh
                </span>
              </pre>
            </Panel>
          </div>
        </div>
      </section>
      <Cta
        title={
          <>
            Decisions survive
            <br />
            the session that made them.
          </>
        }
        actions={[['/docs', 'Read the context guide']]}
      />
    </main>
  )
}
