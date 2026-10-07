import { PLATFORM_NAME } from '../../../../shared/brand.ts'
import { Cards, Check, Cta, PageHero, Panel, Section } from './shared'

const features = [
  [
    'Register',
    'Each project declares itself',
    'Task-key prefix, landing branch, which concerns it keeps, and how to provision a worktree. The register is the authority — not a guess in a prompt.',
  ],
  [
    'Provider-agnostic',
    'Whatever is behind it',
    `A project's own database, a Laravel app's task tables, a hosted issue tracker, or ${PLATFORM_NAME}'s native store. The board does not care which.`,
  ],
  [
    'Two directions',
    'Read and write',
    'Statuses, comments and new tasks go back to the system of record. The aggregate view never becomes a second source of truth.',
  ],
  [
    'Attribution',
    'Cost per change, per project',
    'Runs, tokens and time roll up to the task and to the project, so you can see what a feature cost and where the spend concentrated.',
  ],
  [
    'Docs',
    'A store, not a folder',
    'Plans, briefs and project rules live in one queryable store and hydrate into the tree, so a prompt cites a source instead of copying it.',
  ],
  [
    'Notes',
    'Observations, not a backlog',
    'One line, anchored to a file, run and commit. Repeat sightings are the promotion signal; nothing becomes a task by itself.',
  ],
].map(([eyebrow, title, text]) => ({ eyebrow, title, text }))
const notes = [
  'Project, run, branch, session, commit and file anchor are derived when it is filed — the agent writes one sentence.',
  'A repeat finding adds a sighting instead of a duplicate row. Repetition with cost is the promotion signal.',
  'Promotion to a task is a human act. Scheduled work never promotes, so the board never grows by itself.',
  "Staleness is mechanical: when a note's anchor disappears, it is marked, and untouched singletons are reaped.",
]
const mcp = [
  "Outbound: one client per project, speaking that project's own MCP server.",
  `Inbound: agents read tasks, docs and rules from ${PLATFORM_NAME} through its own server.`,
  "Scoped per project, so one project's agent never sees another's surface.",
  'A worker fetches its own context instead of the architect pasting it in.',
]
export function BoardPage() {
  return (
    <main className="site-page">
      <PageHero
        crumb="Project"
        title="Every project on one board."
        muted="Whatever runs them."
        copy={`Each project keeps the tracker it already has — its own database, its own MCP server, its own conventions. ${PLATFORM_NAME} speaks to each one over MCP and aggregates the result: one board, one cost view, one place where a run is already attributed to the task that caused it.`}
        actions={[['/docs', 'Connect a project']]}
      />
      <section className="section-tight">
        <div className="wrap">
          <BoardShot />
        </div>
      </section>
      <Section
        eyebrow="Aggregation"
        title="One board without migrating anything"
        intro={`A project that already has a tracker does not need a second one. ${PLATFORM_NAME} reads and writes each project's own system over MCP, and keeps the register of which project owns what.`}
      >
        <Cards items={features} />
      </Section>
      <hr className="rule" />
      <Split
        eyebrow="Suggestion box"
        title="Agents find things. The board should not drown in them."
        copy="A worker notices a defect next door, a missing test, a smell it was not sent to fix. Turn each into a task and the board stops showing what is actually happening; tell the agent to stay quiet and the finding is lost. A note is the third option: one line, filed in a second, that never reaches the board on its own."
        checks={notes}
      >
        <Panel eyebrow="Notes">
          <pre>
            <span className="c">{'// during a run, costing nothing'}</span>
            {`\n`}$ <b>orch note</b> "rate limiter counts retries{`\n`} as new requests"{`\n\n`}
            <span className="c">
              {' '}
              note 189 filed · 1 sighting{`\n`} anchored: harbor · HBR-205 · rate-limit.ts:64
              {`\n\n`}
              {'// later, yours to dispose of'}
            </span>
            {`\n`}$ <b>hub note list</b> --actionable{`\n\n`}
            <b> 189</b> <span className="c">rate limiter counts retries … 3 sightings</span>
            {`\n`}
            <b> 204</b> <span className="c">export job has no timeout 1 sighting</span>
            {`\n\n`}$ <b>hub note promote</b> 189{`\n`}
            <span className="c">
              {' '}
              HBR-212 opened, carrying the note and{`\n`} its sightings as evidence
            </span>
          </pre>
        </Panel>
      </Split>
      <hr className="rule" />
      <Split
        eyebrow="MCP"
        title="The board is a surface your agents can use"
        copy={`${PLATFORM_NAME} talks to your projects over MCP, and exposes its own surface the same way. Any agent in any harness can read the board, file a note, open a task or record evidence — without a bespoke integration per tool.`}
        checks={mcp}
      >
        <Panel eyebrow="Connected projects">
          <div className="stack">
            {[
              ['atlas', 'hub · native store · ATL-'],
              ['harbor', 'mcp · app server · HBR-'],
              ['meridian', 'mcp · issue tracker · MER-'],
            ].map(([label, value]) => (
              <div key={label}>
                <span className="lbl">{label}</span>
                <span className="val">{value}</span>
              </div>
            ))}
          </div>
          <pre className="panel-pre">
            $ <b>hub task list</b> --all-projects --open{`\n\n`}
            <span className="c">
              {' '}
              atlas ATL-412 in run codex{`\n`} harbor HBR-205 in review claude{`\n`} meridian
              MER-114 asking qwen3-32b{`\n\n`} 3 projects · 4 trackers · one board
            </span>
          </pre>
        </Panel>
      </Split>
      <Cta
        title={
          <>
            Connect a project
            <br />
            without moving its tasks.
          </>
        }
        copy={`Register the project, point ${PLATFORM_NAME} at its MCP server, and its work joins the board.`}
        actions={[['/docs', 'Read the MCP guide']]}
      />
    </main>
  )
}
function Split({
  eyebrow,
  title,
  copy,
  checks,
  children,
}: {
  eyebrow: string
  title: string
  copy: string
  checks: string[]
  children: React.ReactNode
}) {
  return (
    <section>
      <div className="wrap">
        <div className="split">
          <div>
            <div className="sec-head left">
              <span className="eyebrow">{eyebrow}</span>
              <h2>{title}</h2>
              <p>{copy}</p>
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
          {children}
        </div>
      </div>
    </section>
  )
}
function BoardShot() {
  const rows = [
    [
      'ATL-412',
      'Retry failed webhook deliveries with backoff',
      'atlas',
      'hub · native',
      'in run',
      '2',
    ],
    ['HBR-205', 'Paginate the audit log endpoint', 'harbor', 'mcp · app server', 'in review', '3'],
    ['MER-114', 'Throttle large export jobs', 'meridian', 'mcp · issue tracker', 'asking', '4'],
    ['HBR-201', 'Expire sessions on password change', 'harbor', 'mcp · app server', 'landed', '5'],
    ['ATL-409', 'Backfill missing invoice totals', 'atlas', 'hub · native', 'in run', '1'],
    [
      'note',
      'Rate limiter counts retries as new requests',
      'atlas',
      'hub · note',
      '3 sightings',
      '—',
    ],
  ]
  return (
    <div className="shot">
      <div className="shot-bar">
        <i />
        <i />
        <i />
        <span className="t">hub — all projects</span>
      </div>
      <div className="shot-tabs">
        <span className="on">Board</span>
        <span>Runs</span>
        <span>Docs</span>
        <span>Workflows</span>
        <span>Notes</span>
        <span>Cost</span>
      </div>
      <div className="shot-head">
        <h4>In flight</h4>
        <span>3 projects · 4 trackers · 9 open</span>
      </div>
      <div className="shot-scroll">
        <table className="tbl">
          <thead>
            <tr>
              <th>Key</th>
              <th>Task</th>
              <th>Project</th>
              <th>Source</th>
              <th>State</th>
              <th>Runs</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([key, title, project, source, state, runs]) => (
              <tr key={`${key}-${title}`}>
                <td className="k">{key}</td>
                <td className="ttl">{title}</td>
                <td>{project}</td>
                <td>{source}</td>
                <td>
                  <span className={`chip${state === 'in run' ? ' act' : ''}`}>{state}</span>
                </td>
                <td className="n">{runs}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="kpi">
        {[
          ['Projects', '3', 'one register'],
          ['Trackers behind them', '4', 'native · app server · tracker'],
          ['Runs this week', '38', '31 scored'],
          ['Below frontier', '24', 'cheap or local workers'],
        ].map(([label, value, sub]) => (
          <div key={label}>
            <span className="eyebrow">{label}</span>
            <b>{value}</b>
            <span className="oc-sub">{sub}</span>
          </div>
        ))}
      </div>
      <div className="shot-foot">
        <span>Every row carries its key into the branch, the commit and the run.</span>
        <span>Illustrated.</span>
      </div>
    </div>
  )
}
