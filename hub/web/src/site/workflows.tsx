import { Cards, Check, Cta, PageHero, Panel, Section } from './shared'

const steps = [
  ['1', 'Rebase onto trunk', '—', 'auto', 'command exit'],
  ['2', 'Run independent review lenses', 'review-lens', 'auto', 'recorded artifact'],
  ['3', 'Triage every finding', '—', 'ask', 'human ruling'],
  ['4', 'Apply accepted findings', 'implement', 'ask', 'command exit · artifact'],
  ['5', 'Check acceptance criteria', '—', 'auto', 'recorded artifact'],
  ['6', 'Run the project gate', '—', 'auto', 'command exit'],
  ['7', 'Open the pull request', '—', 'ask', 'command exit · artifact'],
  ['8', 'Merge the pull request', '—', 'ask', 'command exit · artifact'],
  ['9', 'Promote the release', '—', 'ask', 'command exit · artifact'],
  ['10', 'Close the task', '—', 'auto', 'tracker transition'],
]
const predictable = [
  [
    'Job',
    'Who does the work',
    'A step either names an orch job — review-lens, implement — and routes by scored evidence, or it is a plain command the step runs itself.',
  ],
  [
    'Autonomy',
    'Whether it may proceed',
    'Auto runs and continues. Ask stops and waits for you. Triage, applying findings, opening, merging and promoting all stop — because each is a decision.',
  ],
  [
    'Evidence floor',
    'What it must leave behind',
    'A command exit, a recorded artifact, a human ruling, or a tracker transition. A step that cannot meet its floor has not completed, whatever it reports.',
  ],
].map(([eyebrow, title, text]) => ({ eyebrow, title, text }))
const catalogue = [
  [
    'Before',
    'Plan a task',
    'Turn an intent into a specification a worker could build against, with the decisions already ruled on.',
  ],
  [
    'During',
    'Fix a defect',
    'Diagnose first, then change one thing. The diagnosis is evidence, not a description of evidence.',
  ],
  [
    'During',
    'Review code',
    'Independent lenses under a fixed round budget, each answering one named question.',
  ],
  [
    'After',
    'Ship a task',
    'Rebase, review, triage, gate, open, merge, promote, close — the ten steps above.',
  ],
  [
    'Anytime',
    'Report an issue',
    'File a defect with reproduction, environment and an explicit statement of what is not established.',
  ],
  [
    'Upkeep',
    'Sync the docs',
    'Bring the doc store and the tree back into agreement after the code has moved.',
  ],
].map(([eyebrow, title, text]) => ({ eyebrow, title, text }))
const composition = [
  'One catalogue, versioned, shared by every project.',
  'Project facts resolved at compose time, never hardcoded in a prompt.',
  'Modes select how far to go — plan only, review only, ship and promote.',
  'A step that needs a capability the project lacks is not silently skipped.',
]
export function WorkflowsPage() {
  return (
    <main className="site-page">
      <PageHero
        crumb="Workflows"
        title="One lifecycle."
        muted="Every task, every project."
        copy="A workflow is a named sequence of steps, and each step declares the job that runs it, whether it may proceed on its own, and the evidence it must produce before the next step starts. Your project's own facts — trunk, tracker, gate, release rules — are composed in when the workflow is requested, so the same lifecycle behaves correctly in every repository without being rewritten for each one."
        actions={[
          ['/docs', 'Read the workflow guide'],
          ['/product/board', 'See the board'],
        ]}
      />
      <section className="section-tight">
        <div className="wrap">
          <div className="shot">
            <div className="shot-bar">
              <i />
              <i />
              <i />
              <span className="t">orch — compose ship-task · project: atlas</span>
            </div>
            <div className="shot-tabs">
              <span className="on">Steps</span>
              <span>Facts</span>
              <span>Docs</span>
              <span>Modes</span>
            </div>
            <div className="shot-head">
              <h4>Ship a task</h4>
              <span>mode full · 10 steps · workflow v4</span>
            </div>
            <div className="shot-scroll">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Step</th>
                    <th>Job</th>
                    <th>Autonomy</th>
                    <th>Evidence floor</th>
                  </tr>
                </thead>
                <tbody>
                  {steps.map(([n, step, job, autonomy, evidence]) => (
                    <tr key={n}>
                      <td className="k">{n}</td>
                      <td className="ttl">{step}</td>
                      <td>{job}</td>
                      <td>
                        <span className={`chip${autonomy === 'ask' ? ' act' : ''}`}>
                          {autonomy}
                        </span>
                      </td>
                      <td>{evidence}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="shot-foot">
              <span>
                Steps marked ask stop for a ruling. Nothing downstream runs until you give one.
              </span>
              <span>Illustrated.</span>
            </div>
          </div>
        </div>
      </section>
      <Section
        eyebrow="Why it is predictable"
        title="The step declares what it needs, not how you feel about it"
        intro="Three declarations per step remove the guesswork that makes agent workflows drift: what runs it, whether it may proceed alone, and what it must leave behind."
      >
        <Cards items={predictable} />
      </Section>
      <hr className="rule" />
      <section>
        <div className="wrap">
          <div className="split">
            <div>
              <div className="sec-head left">
                <span className="eyebrow">Composition</span>
                <h2>The same workflow, correct in every project</h2>
                <p>
                  A workflow is not copied into each repository and edited until it fits. It is
                  composed on request: the steps come from the catalogue, and the project register
                  supplies the facts — which branch is trunk, which tracker holds the task and the
                  exact commands to drive it, which gate proves a commit, how releases merge.
                </p>
              </div>
              <ul className="checks">
                {composition.map((item) => (
                  <li key={item}>
                    <Check />
                    {item}
                  </li>
                ))}
              </ul>
            </div>
            <Panel eyebrow="Composed facts">
              <div className="stack">
                {[
                  ['trunk', 'main'],
                  ['tracker', 'hub · list · show · new · set · comment'],
                  ['gate', "the project's own check command"],
                  ['release', 'squash · required checks'],
                  ['docs', 'global · stack · project'],
                ].map(([label, value]) => (
                  <div key={label}>
                    <span className="lbl">{label}</span>
                    <span className="val">{value}</span>
                  </div>
                ))}
              </div>
              <pre className="panel-pre">
                $ <b>orch workflow compose</b> ship-task --project atlas{`\n\n`}
                <span className="c">
                  {' '}
                  workflow ship-task v4 · mode full{`\n`} catalogue v16{`\n`} steps 10 (6 auto · 4
                  ask){`\n`} needs key · branch · worktree
                </span>
              </pre>
            </Panel>
          </div>
        </div>
      </section>
      <hr className="rule" />
      <Section
        eyebrow="The catalogue"
        title="A workflow for each shape of work"
        intro="The lifecycle is covered end to end — from the plan that precedes a task to the release that closes it."
      >
        <Cards items={catalogue} />
      </Section>
      <hr className="rule" />
      <section>
        <div className="wrap">
          <div className="split">
            <Panel eyebrow="MCP surface">
              <pre>
                <span className="c">{'// any agent, any harness'}</span>
                {`\n`}
                <b>list_workflows</b>(){`\n`}
                <b>compose_workflow</b>({'{ slug, project, mode }'}){`\n`}
                <b>get_workflow_step</b>({'{ slug, project, n }'}){`\n\n`}
                <span className="c">{"// the project's own knowledge"}</span>
                {`\n`}
                <b>list_docs</b>({'{ scope }'}){`\n`}
                <b>get_doc</b>({'{ subject }'}){`\n`}
                <b>project_brief</b>()
              </pre>
            </Panel>
            <div>
              <div className="sec-head left">
                <span className="eyebrow">Skills over MCP</span>
                <h2>The workflow is a surface, not a prompt you paste</h2>
                <p>
                  Every workflow and every document is reachable over MCP, so an agent asks for the
                  step it is on and gets that step's instructions, its job, its autonomy and its
                  evidence floor — already composed for the project it is working in.
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>
      <Cta
        title={
          <>
            Same lifecycle.
            <br />
            Every repository.
          </>
        }
        copy="Register a project and its workflows compose themselves from its own facts."
        actions={[['/docs', 'Read the workflow guide']]}
      />
    </main>
  )
}
