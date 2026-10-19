import { Cards, Check, Cta, PageHero, Panel, Section } from './shared'

const tiers = [
  [
    'Risk',
    'Where the change landed',
    'Paths carry a risk level. Schema and migrations, landing safety, worktree lifecycle, run execution, repository hooks and cross-concern shared code sit at the top. Backend source is lower. A web surface or a skill lower still. Documentation, tests, fixtures and ordinary configuration are zero.',
  ],
  [
    'Size',
    'How much of it there is',
    'Product lines changed, with a bump when the change is spread across many product files — breadth is its own kind of risk. Tests and docs do not inflate it.',
  ],
].map(([eyebrow, title, text]) => ({ eyebrow, title, text }))
const tierLevels = [
  [
    'Tier 0',
    'No lenses',
    'Docs, tests and config only. Review would find nothing and cost a round.',
  ],
  ['Tier 1', 'One lens, one round', 'A surface change with little blast radius.'],
  ['Tier 2', 'Two rounds', 'Ordinary product source.'],
  ['Tier 3', 'Three rounds', 'The paths where a mistake is expensive and quiet.'],
].map(([eyebrow, title, text]) => ({ eyebrow, title, text }))
const multi = [
  [
    'Stable identity',
    'The same lens over time',
    'A lens keeps its id across runs, so its findings accumulate into a record of whether that question is worth asking on this codebase.',
  ],
  [
    'Independent',
    'No shared anchor',
    "Lenses do not see each other's findings. Three reviewers agreeing means three arrived separately, not that one repeated another.",
  ],
  [
    'Explicit exclusions',
    'What it will not say',
    'Each lens names what is out of scope, so the same nit does not arrive from five directions.',
  ],
].map(([eyebrow, title, text]) => ({ eyebrow, title, text }))
const measures = [
  [
    'Yield',
    'What a lens actually finds',
    "How many of a lens's findings survive triage, over time. A lens that yields nothing is costing rounds and can be retired on evidence rather than opinion.",
  ],
  [
    'Calibration',
    'How much to trust a reviewer',
    "An agent's accepted-versus-rejected record on a lens travels with it into routing, so the next review of that dimension goes to whoever has been right about it here.",
  ],
  [
    'Coverage',
    'Whether the diff was looked at',
    'An audit of what the lenses actually reached, so a green review on an unexamined file is visible instead of reassuring.',
  ],
].map(([eyebrow, title, text]) => ({ eyebrow, title, text }))
const checks = [
  'Real findings are fixed in the round that raised them.',
  'Speculation is dropped in triage, not carried into a fix.',
  'A clean round ends the ladder immediately.',
  'At the ceiling it stops and asks you rather than spending another round.',
]
export function ReviewPage() {
  return (
    <main className="site-page">
      <PageHero
        crumb="Review"
        title="Review that knows"
        muted="when to stop."
        copy="Independent lenses, each answering one named question, on a round budget the change itself decides. Agent review usually fails in one of two ways: one pass that misses things, or an endless ladder of findings nobody triages. The tier fixes both ends before the first lens runs."
        actions={[
          ['/docs', 'How findings are judged'],
          ['/product/workflows', 'See it as a workflow step'],
        ]}
      />
      <section className="section-tight">
        <div className="wrap">
          <ReviewShot />
        </div>
      </section>
      <Section
        eyebrow="The tier"
        title="The change decides how much review it gets"
        intro="Not your mood, and not the agent's enthusiasm. The tier is computed from the diff before the first lens runs, and it fixes both the number of lenses and a hard ceiling on rounds."
      >
        <Cards items={tiers} columns={2} />
        <Cards items={tierLevels} columns={4} />
        <p className="center-note">
          The tier is checked before the first lens and before every later round. At the ceiling the
          ladder stops and asks you — never another round, whatever the new findings' severity.
        </p>
      </Section>
      <hr className="rule" />
      <Section
        eyebrow="Multi-lens"
        title="One question each, asked independently"
        intro="A lens is a named viewpoint with a stable identity, one question and explicit exclusions. Narrow beats broad: a reviewer told to “look for problems” returns opinions, while a reviewer asked one question returns findings you can test."
      >
        <Cards items={multi} />
      </Section>
      <hr className="rule" />
      <section>
        <div className="wrap">
          <div className="split">
            <div>
              <div className="sec-head left">
                <span className="eyebrow">Multi-round</span>
                <h2>A ladder that ends</h2>
                <p>
                  The first review is the only full one. After a fix round you read the fix and land
                  it. Re-lensing happens only at the top tier, only when the fix touched a top-tier
                  path, and only with the lenses whose dimension the fix actually touched — carrying
                  the earlier findings forward so nothing is asked twice.
                </p>
              </div>
              <ul className="checks">
                {checks.map((item) => (
                  <li key={item}>
                    <Check />
                    {item}
                  </li>
                ))}
              </ul>
            </div>
            <Panel eyebrow="Triage">
              <div className="stack">
                {[
                  ['accepted', 'Verified and fixed this round.'],
                  ['modified', 'Real, but not for the reason given.'],
                  ['rejected', 'Checked and did not hold.'],
                  ['skipped', 'Out of scope for this change.'],
                ].map(([label, value]) => (
                  <div key={label}>
                    <span className="lbl">{label}</span>
                    <span className="val">{value}</span>
                  </div>
                ))}
              </div>
              <p className="panel-note">
                Every finding gets a disposition, and the disposition is the evidence. A finding is
                a suggestion to test, never an instruction to implement — reviewers argue plausibly
                and are sometimes wrong.
              </p>
            </Panel>
          </div>
        </div>
      </section>
      <hr className="rule" />
      <Section
        eyebrow="It measures itself"
        title="Lenses earn their place, or lose it"
        intro="Review is the one part of a pipeline that is never audited — so it silently fills with checks that have not caught anything in a year. Here, every disposition is a measurement."
      >
        <Cards items={measures} />
      </Section>
      <hr className="rule" />
      <Section
        eyebrow="Integrated"
        title="Not a bolt-on reviewer"
        intro="Review is wired into every other part of the system, which is what keeps it honest."
      >
        <Cards
          columns={4}
          items={[
            {
              title: 'A workflow step',
              text: "Lenses run as a step with an evidence floor — a recorded artifact, not an agent's assurance that it looked.",
            },
            {
              title: 'Routed like any job',
              text: 'A lens is an orch job, so it goes to whichever agent scores best on that dimension in this repository.',
            },
            {
              title: 'Anchored to the work',
              text: 'Findings carry the task key, the run and the file, so a fix is attributable and a stale finding is detectable.',
            },
            {
              title: 'Notes catch the rest',
              text: "A real finding outside this change's scope becomes a note, not scope creep and not a lost observation.",
            },
          ]}
        />
      </Section>
      <Cta
        title={
          <>
            Enough review.
            <br />
            Then stop.
          </>
        }
        copy="The change picks the budget. The findings get judged. The ladder ends."
        actions={[
          ['/product/workflows', 'See the lifecycle'],
          ['/docs', 'How findings are judged'],
        ]}
      />
    </main>
  )
}
function ReviewShot() {
  const rows = [
    ['failure-paths', 'What happens when this call fails?', 'codex', '3', '2'],
    ['boundaries', 'Does this cross a module it should not?', 'grok', '1', '1'],
    ['test-value', 'Can these tests fail for a real defect?', 'claude', '4', '1'],
  ]
  return (
    <div className="shot">
      <div className="shot-bar">
        <i />
        <i />
        <i />
        <span className="t">orch — review · ATL-412 · round 1</span>
      </div>
      <div className="shot-tabs">
        <span className="on">Lenses</span>
        <span>Findings</span>
        <span>Coverage</span>
        <span>Yield</span>
      </div>
      <div className="shot-head">
        <h4>Tier 2</h4>
        <span>
          risk 2: unlisted product path · size 1: 143 product lines — the higher of the two wins
        </span>
      </div>
      <div className="shot-scroll">
        <table className="tbl">
          <thead>
            <tr>
              <th>Lens</th>
              <th>Question it answers</th>
              <th>Agent</th>
              <th>Findings</th>
              <th>Survived triage</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row[0]}>
                {row.map((cell, index) => (
                  <td
                    key={cell}
                    className={index === 0 ? 'k' : index === 1 ? 'ttl' : index > 2 ? 'n' : ''}
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="kpi">
        {[
          ['Lenses', '3', 'fixed by tier 2'],
          ['Rounds used', '1 of 2', 'ceiling is the tier'],
          ['Findings', '8', '4 accepted · 1 modified · 3 rejected'],
          ['Round 2', 'Clean', 'ladder ends'],
        ].map(([label, value, sub]) => (
          <div key={label}>
            <span className="eyebrow">{label}</span>
            <b>{value}</b>
            <span className="oc-sub">{sub}</span>
          </div>
        ))}
      </div>
      <div className="shot-foot">
        <span>Each lens ran without seeing the others' findings.</span>
        <span>Illustrated.</span>
      </div>
    </div>
  )
}
