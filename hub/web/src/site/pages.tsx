import { Link } from '@tanstack/react-router'

const installCommand =
  'curl -fsSL https://raw.githubusercontent.com/modstudio/bottega/main/install.sh | sh'

function Actions({ secondary }: { secondary?: [string, string] }) {
  return (
    <div className="site-actions">
      <Link className="site-button" to="/docs">
        Install Bottega
      </Link>
      {secondary ? (
        <Link className="site-button site-button-secondary" to={secondary[0]}>
          {secondary[1]}
        </Link>
      ) : null}
    </div>
  )
}

function Section({
  eyebrow,
  title,
  intro,
  children,
}: {
  eyebrow?: string
  title: string
  intro?: string
  children: React.ReactNode
}) {
  return (
    <section className="site-section">
      <div className="site-wrap">
        <div className="site-section-head">
          {eyebrow ? <span className="site-eyebrow">{eyebrow}</span> : null}
          <h2>{title}</h2>
          {intro ? <p>{intro}</p> : null}
        </div>
        {children}
      </div>
    </section>
  )
}

function Cards({
  items,
  two = false,
}: {
  items: { eyebrow?: string; title: string; text: string; bullets?: string[]; to?: string }[]
  two?: boolean
}) {
  return (
    <div className={`site-grid${two ? ' two' : ''}`}>
      {items.map((item) => {
        const body = (
          <>
            <span className="site-eyebrow">{item.eyebrow}</span>
            <h3>{item.title}</h3>
            <p>{item.text}</p>
            {item.bullets ? (
              <ul>
                {item.bullets.map((bullet) => (
                  <li key={bullet}>{bullet}</li>
                ))}
              </ul>
            ) : null}
          </>
        )
        return item.to ? (
          <Link className="site-card" to={item.to} key={item.title}>
            {body}
          </Link>
        ) : (
          <div className="site-card" key={item.title}>
            {body}
          </div>
        )
      })}
    </div>
  )
}

function PageHero({
  crumb,
  title,
  muted,
  copy,
  actions,
}: {
  crumb: string
  title: string
  muted: string
  copy: string
  actions?: [string, string][]
}) {
  return (
    <div className="site-wrap site-page-hero">
      <div className="site-eyebrow">Bottega / {crumb}</div>
      <h1>
        {title}
        <br />
        <em>{muted}</em>
      </h1>
      <p>{copy}</p>
      {actions ? (
        <div className="site-actions">
          {actions.map(([to, label], index) => (
            <Link
              key={to}
              className={`site-button${index ? ' site-button-secondary' : ''}`}
              to={to}
            >
              {label}
            </Link>
          ))}
        </div>
      ) : null}
    </div>
  )
}

function Cta({ title, copy }: { title: React.ReactNode; copy?: string }) {
  return (
    <div className="site-wrap">
      <div className="site-cta">
        <h2>{title}</h2>
        {copy ? <p>{copy}</p> : null}
        <Actions />
      </div>
    </div>
  )
}

export function HomePage() {
  return (
    <main className="site-page">
      <div className="site-wrap site-hero">
        <span className="site-pill">Not another coding agent. The workshop that runs them.</span>
        <h1>
          You keep every decision.
          <br />
          <em>Workers do the rest.</em>
        </h1>
        <p className="site-lede">
          You design the change, rule on the forks and read the diff. Cloud and local workers do the
          typing — under contract, in disposable worktrees, never guessing. Everything else a team
          needs comes with it.
        </p>
        <Actions secondary={['/product/orchestration', 'See how it works']} />
        <p className="site-micro">
          Runs on your machine · Frontier tokens for the spec and the diff · Everything else cheap
          or local
        </p>
        <div className="site-runners">
          <span>Claude Code</span>
          <span>Codex</span>
          <span>Grok</span>
          <span>Ollama</span>
          <span>vLLM</span>
          <span>LM Studio</span>
          <span>llama.cpp</span>
        </div>
      </div>
      <RunShowcase />
      <Section
        title="How the work gets done, and where it lives"
        intro="Every run, task, document and decision is one record — not an orchestration tool with a board bolted on."
      >
        <Cards
          two
          items={[
            {
              eyebrow: 'Orchestration',
              title: 'How the work gets done',
              text: 'A worker builds from your spec in a disposable worktree, stops at every judgement call and never pushes. You rule, read the diff and score it — and the score decides who gets the next job of that shape.',
              bullets: [
                'Worker contracts and escalation',
                'Cloud agents or models on your own GPU',
                'Multi-lens review on a budget that ends',
                'Evidence-based routing',
                'Workflows for the whole task lifecycle',
                'Local retrieval that feeds every run',
              ],
              to: '/product/orchestration',
            },
            {
              eyebrow: 'Workspace',
              title: 'Where the work lives',
              text: 'Every project on one board, whatever tracker each one actually runs. Tasks, documentation, decisions and cost in the same system as the runs — so a change is already attributed before you score it.',
              bullets: [
                'One board across every project',
                'Docs your team and your models both read',
                'Task plans, handoffs and resume briefs',
                'A suggestion box that never spams the board',
                'Cost and time per change',
                'All of it reachable over MCP',
              ],
              to: '/product/board',
            },
          ]}
        />
      </Section>
      <hr className="site-divider" />
      <Section
        eyebrow="The lifecycle"
        title="Every task takes the same ten steps"
        intro="Workflows run the whole life of a task — plan, build, review, gate, land, close. Each step declares the job that runs it, whether it may proceed alone, and the evidence it must leave behind, composed from your project's own trunk, tracker, gate and release rules."
      >
        <div className="site-panel site-code">
          Plan → Dispatch → Rule → Review → Triage → Gate → Land → Close
        </div>
        <Cards
          two
          items={[
            {
              eyebrow: 'Workflows',
              title: 'Declared steps, composed per project',
              text: 'Auto where it is safe, ask where it is a decision. A step has not completed because an agent says so — it completes when its evidence floor is met.',
              to: '/product/workflows',
            },
            {
              eyebrow: 'Review',
              title: 'Multi-lens, multi-round, and it ends',
              text: "The change's tier fixes how many lenses run and how many rounds they may take. Lenses are measured on what survives triage, so an unproductive one is retired on evidence.",
              to: '/product/review',
            },
          ]}
        />
      </Section>
      <Section
        eyebrow="Fits your stack"
        title="Works with the agents and models you already run"
        intro="Swap the harness and the record stays. Bottega keeps the task, the contract, the evidence and the score independent of whoever does the work."
      >
        <div className="site-runners">
          <span>Claude Code</span>
          <span>Codex</span>
          <span>Grok</span>
          <span>Ollama</span>
          <span>vLLM</span>
          <span>LM Studio</span>
          <span>llama.cpp</span>
          <span>MCP</span>
          <span>Git worktrees</span>
          <span>GitHub</span>
        </div>
      </Section>
      <Cta
        title={
          <>
            Install it.
            <br />
            Keep your harness.
          </>
        }
        copy="Bottega runs beside the agent you already use. Bring your own models."
      />
      <p className="site-code site-micro site-wrap" style={{ textAlign: 'center' }}>
        {installCommand}
      </p>
    </main>
  )
}

function RunShowcase() {
  return (
    <div className="site-showcase">
      <div className="site-window">
        <div className="site-window-bar">bottega — orch board</div>
        <div className="site-window-body">
          <h2>Runs</h2>
          <table className="site-table">
            <thead>
              <tr>
                <th>Run</th>
                <th>Job</th>
                <th>Agent</th>
                <th>Task</th>
                <th>State</th>
                <th>Fidelity</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>r-4f19</td>
                <td>implement</td>
                <td>codex</td>
                <td>ATL-412 webhook retries</td>
                <td>running</td>
                <td>—</td>
              </tr>
              <tr>
                <td>r-4f17</td>
                <td>implement</td>
                <td>qwen3-32b · local</td>
                <td>HBR-208 tenant cache</td>
                <td>asking</td>
                <td>—</td>
              </tr>
              <tr>
                <td>r-4f12</td>
                <td>review · lens</td>
                <td>claude</td>
                <td>MER-117 duplicate records</td>
                <td>accepted</td>
                <td>4 / 4</td>
              </tr>
            </tbody>
          </table>
          <p>
            <strong>r-4f17 stopped and asked.</strong> “The spec says retry on a 5xx. Two existing
            callers also retry on a 429. Do I change them too, or scope the retry to the new path?”
            — waiting on your ruling, nothing guessed.
          </p>
        </div>
      </div>
    </div>
  )
}

const mechanism = [
  {
    eyebrow: 'Stop',
    title: 'A question suspends the run',
    text: 'A worker that reaches a judgement call it was not given stops there. The run is preserved, not restarted, so asking costs almost nothing.',
  },
  {
    eyebrow: 'Score',
    title: 'Asking is faithful',
    text: 'A worker that stopped is never marked down for stopping. Penalise the question and workers learn to guess instead — which is the failure the contract exists to prevent.',
  },
  {
    eyebrow: 'Judge',
    title: 'Fidelity is scored apart',
    text: 'Correct, tested code that solved a different problem is still a failure. That axis is judged on its own, on the four writing jobs.',
  },
  {
    eyebrow: 'Isolation',
    title: 'One worktree per run',
    text: 'A disposable checkout bounds what an agent can touch, and the run that provisions it releases it.',
  },
  {
    eyebrow: 'Review',
    title: 'Review is one question at a time',
    text: 'Each pass answers one named question. How many passes run is fixed up front, so review cannot balloon.',
  },
  {
    eyebrow: 'Recovery',
    title: 'Nothing runs unwatched',
    text: 'A heartbeat reports blocked, waiting or clear, so a stalled run is never mistaken for a working one.',
  },
]

export function OrchestrationPage() {
  return (
    <main className="site-page">
      <PageHero
        crumb="Orchestration"
        title="Delegate the execution."
        muted="Never the judgement."
        copy="A change is decisions plus typing. The architect owns what the change means, which ambiguity resolves which way, and what must stay true. A worker owns the typing — and is contractually forbidden from deciding anything it was not given."
        actions={[
          ['/docs', 'Run your first job'],
          ['/product/workers', 'See the hierarchy'],
        ]}
      />
      <Section title="Spec, build, rule, judge">
        <Cards
          items={[
            {
              eyebrow: '01',
              title: 'You write the spec',
              text: "The architect designs the change and rules on what it means. Your project rules, the job contract and the retrieval context are compiled into the worker's prompt automatically.",
            },
            {
              eyebrow: '02',
              title: 'A worker builds it',
              text: 'One disposable worktree per run. The worker cannot push, cannot widen scope, and cannot resolve an ambiguity — it stops and asks. Asking is not a failure; it is how a worker stays faithful.',
            },
            {
              eyebrow: '03',
              title: 'You rule, it resumes',
              text: 'Answer the question and the run continues from where it stopped, with your ruling in hand.',
            },
            {
              eyebrow: '04',
              title: 'You judge, routing learns',
              text: 'Read the diff and score it — correctness separately from fidelity. After enough scored runs the job routes by measured success on your repositories, not by reputation.',
            },
          ]}
        />
      </Section>
      <hr className="site-divider" />
      <Section
        eyebrow="The mechanism"
        title="Why a worker never guesses"
        intro="Three parts carry the load. Remove any one and delegation starts costing more than it saves."
      >
        <Cards items={mechanism} />
      </Section>
      <Cta
        title={
          <>
            Your first run
            <br />
            takes one command.
          </>
        }
      />
    </main>
  )
}

export function WorkersPage() {
  return (
    <main className="site-page">
      <PageHero
        crumb="Workers & models"
        title="A frontier model on top."
        muted="Whatever you like underneath."
        copy="The architect is the only seat that needs to be brilliant — and the only one billed like it. Below it the work is bounded enough that a cheap cloud agent or a model on your own GPU can do it, and a scored run tells you which ones actually can."
      />
      <Section title="The architect decides. The worker executes. Retrieval serves both.">
        <div className="site-panel">
          <pre>{`             A R C H I T E C T\n        designs · rules · judges\n                    │\n     worker ─ worker ─ worker ─ worker\n                    │\n              R E T R I E V A L\n       code · docs · rules · past runs`}</pre>
        </div>
      </Section>
      <Section
        eyebrow="The economics"
        title="Stop paying frontier prices for work a worker can finish"
        intro="Design and judgement are worth a frontier model. Reading files, writing the obvious implementation, searching the repository and summarising a diff are not — and they are most of the volume."
      >
        <Cards
          items={[
            {
              title: 'Reading code to answer a question',
              text: 'Surveys come back as a conclusion with citations, not as forty files billed into your context.',
            },
            {
              title: 'Semantic search over the repo',
              text: 'Embedding and reranking run on hardware you already own. No per-token cost to find a file.',
            },
            {
              title: 'Deciding who should do the job',
              text: 'Scored runs show which jobs a cheap local model finishes acceptably — and which ones it cannot.',
            },
            {
              title: 'What you still do',
              text: 'Design the change · rule on the forks · read the diff · score it. The four acts that are actually judgement.',
            },
            { eyebrow: 'Frontier tokens', title: 'Spec & diff', text: 'The rest runs below.' },
          ]}
        />
      </Section>
      <Section
        eyebrow="Retrieval"
        title="Find the three files. Skip the other four hundred."
        intro="An agent that greps its way through a repository burns paid context before it writes a line. Ask where a behaviour lives and get a short, ranked set of code, docs, project rules and relevant past runs — handed to the worker before it starts exploring."
      >
        <Cards
          two
          items={[
            {
              title: 'Local search',
              text: 'Embedding and reranking are local model work — they cost GPU seconds, not tokens.',
              bullets: [
                'Indexes source, docs, project rules and transcripts of past runs together.',
                'The reranker puts the part worth reading at the top.',
              ],
            },
            {
              title: 'Smaller context',
              text: 'A worker that can find three files does not need a huge context window — or a huge model.',
            },
          ]}
        />
      </Section>
    </main>
  )
}

export function BoardPage() {
  return (
    <main className="site-page">
      <PageHero
        crumb="Board"
        title="Every project on one board."
        muted="Whatever runs them."
        copy="Each project keeps the tracker it already has — its own database, its own MCP server, its own conventions. Bottega speaks to each one over MCP and aggregates the result: one board, one cost view, one place where a run is already attributed to the task that caused it."
        actions={[['/docs', 'Connect a project']]}
      />
      <Section title="In flight" intro="Three projects · four trackers · nine open">
        <RunShowcase />
      </Section>
      <Section
        eyebrow="Aggregation"
        title="One board without migrating anything"
        intro="A project that already has a tracker does not need a second one. Bottega reads and writes each project's own system over MCP, and keeps the register of which project owns what."
      >
        <Cards
          items={[
            {
              eyebrow: 'Register',
              title: 'Each project declares itself',
              text: 'Task-key prefix, landing branch, which concerns it keeps, and how to provision a worktree. The register is the authority — not a guess in a prompt.',
            },
            {
              eyebrow: 'Provider-agnostic',
              title: 'Whatever is behind it',
              text: "A project's own database, an app's task tables, a hosted issue tracker, or Bottega's native store. The board does not care which.",
            },
            {
              eyebrow: 'Two directions',
              title: 'Read and write',
              text: 'Statuses, comments and new tasks go back to the system of record. The aggregate view never becomes a second source of truth.',
            },
            {
              eyebrow: 'Attribution',
              title: 'Cost per change, per project',
              text: 'Runs, tokens and time roll up to the task and to the project, so you can see what a feature cost and where the spend concentrated.',
            },
            {
              eyebrow: 'Docs',
              title: 'A store, not a folder',
              text: 'Plans, briefs and project rules live in one queryable store and hydrate into the tree, so a prompt cites a source instead of copying it.',
            },
            {
              eyebrow: 'Notes',
              title: 'Observations, not a backlog',
              text: 'One line, anchored to a file, run and commit. Repeat sightings are the promotion signal; nothing becomes a task by itself.',
            },
          ]}
        />
      </Section>
      <Section
        eyebrow="Suggestion box"
        title="Agents find things. The board should not drown in them."
        intro="A note is the third option: one line, filed in a second, that never reaches the board on its own."
      >
        <Cards
          items={[
            {
              title: 'Anchored automatically',
              text: 'Project, run, branch, session, commit and file anchor are derived when it is filed.',
            },
            {
              title: 'Repeated, not duplicated',
              text: 'A repeat finding adds a sighting. Repetition with cost is the promotion signal.',
            },
            {
              title: 'Promoted by a person',
              text: 'Scheduled work never promotes, so the board never grows by itself.',
            },
          ]}
        />
      </Section>
      <Cta
        title={
          <>
            Connect a project
            <br />
            without moving its tasks.
          </>
        }
      />
    </main>
  )
}

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
      <Section
        eyebrow="The tier"
        title="The change decides how much review it gets"
        intro="Not your mood, and not the agent's enthusiasm. The tier is computed from the diff before the first lens runs, and it fixes both the number of lenses and a hard ceiling on rounds."
      >
        <Cards
          items={[
            {
              eyebrow: 'Risk',
              title: 'Where the change landed',
              text: 'Paths carry a risk level. Schema and migrations, landing safety, worktree lifecycle, run execution, repository hooks and cross-concern shared code sit at the top.',
            },
            {
              eyebrow: 'Size',
              title: 'How much of it there is',
              text: 'Product lines changed, with a bump when the change is spread across many product files — breadth is its own kind of risk.',
            },
            { eyebrow: 'Tier 0', title: 'No lenses', text: 'Docs, tests and config only.' },
            {
              eyebrow: 'Tier 1',
              title: 'One lens, one round',
              text: 'A surface change with little blast radius.',
            },
            { eyebrow: 'Tier 2', title: 'Two rounds', text: 'Ordinary product source.' },
            {
              eyebrow: 'Tier 3',
              title: 'Three rounds',
              text: 'The paths where a mistake is expensive and quiet.',
            },
          ]}
        />
      </Section>
      <Section
        eyebrow="Multi-lens"
        title="One question each, asked independently"
        intro="A lens is a named viewpoint with a stable identity, one question and explicit exclusions."
      >
        <Cards
          items={[
            {
              title: 'The same lens over time',
              text: 'A lens keeps its id across runs, so its findings accumulate into a record.',
            },
            {
              title: 'No shared anchor',
              text: "Lenses do not see each other's findings. Agreement means they arrived separately.",
            },
            {
              title: 'What it will not say',
              text: 'Each lens names what is out of scope, so the same nit does not arrive from five directions.',
            },
          ]}
        />
      </Section>
      <Section
        eyebrow="Multi-round"
        title="A ladder that ends"
        intro="The first review is the only full one. After a fix round you read the fix and land it. Re-lensing happens only at the top tier, only when the fix touched a top-tier path, and only with the lenses whose dimension the fix actually touched."
      >
        <Cards
          items={[
            {
              title: 'Fix real findings',
              text: 'Real findings are fixed in the round that raised them.',
            },
            {
              title: 'Drop speculation',
              text: 'Speculation is dropped in triage, not carried into a fix.',
            },
            {
              title: 'Stop',
              text: 'A clean round ends the ladder immediately. At the ceiling it stops and asks you.',
            },
          ]}
        />
      </Section>
      <Section eyebrow="It measures itself" title="Lenses earn their place, or lose it">
        <Cards
          items={[
            {
              eyebrow: 'Yield',
              title: 'What a lens actually finds',
              text: 'How many findings survive triage, over time.',
            },
            {
              eyebrow: 'Calibration',
              title: 'How much to trust a reviewer',
              text: "An agent's accepted-versus-rejected record on a lens travels with it into routing.",
            },
            {
              eyebrow: 'Coverage',
              title: 'Whether the diff was looked at',
              text: 'An audit of what the lenses actually reached.',
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
      />
    </main>
  )
}

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
      <Section
        eyebrow="Why it is predictable"
        title="The step declares what it needs, not how you feel about it"
        intro="Three declarations per step remove the guesswork that makes agent workflows drift: what runs it, whether it may proceed alone, and what it must leave behind."
      >
        <Cards
          items={[
            {
              eyebrow: 'Job',
              title: 'Who does the work',
              text: 'A step either names an orch job and routes by scored evidence, or it is a plain command the step runs itself.',
            },
            {
              eyebrow: 'Autonomy',
              title: 'Whether it may proceed',
              text: 'Auto runs and continues. Ask stops and waits for you. Triage, applying findings, opening, merging and promoting all stop — because each is a decision.',
            },
            {
              eyebrow: 'Evidence floor',
              title: 'What it must leave behind',
              text: 'A command exit, a recorded artifact, a human ruling, or a tracker transition.',
            },
          ]}
        />
      </Section>
      <Section
        eyebrow="Composition"
        title="The same workflow, correct in every project"
        intro="A workflow is composed on request: the steps come from the catalogue, and the project register supplies the facts — which branch is trunk, which tracker holds the task, which gate proves a commit, how releases merge."
      >
        <Cards
          items={[
            { title: 'One catalogue', text: 'Versioned and shared by every project.' },
            {
              title: 'Project facts',
              text: 'Resolved at compose time, never hardcoded in a prompt.',
            },
            {
              title: 'Modes',
              text: 'Select how far to go — plan only, review only, ship and promote.',
            },
          ]}
        />
      </Section>
      <Section eyebrow="The catalogue" title="A workflow for each shape of work">
        <Cards
          items={[
            {
              eyebrow: 'Before',
              title: 'Plan a task',
              text: 'Turn an intent into a specification a worker could build against.',
            },
            {
              eyebrow: 'During',
              title: 'Fix a defect',
              text: 'Diagnose first, then change one thing.',
            },
            {
              eyebrow: 'During',
              title: 'Review code',
              text: 'Independent lenses under a fixed round budget.',
            },
            {
              eyebrow: 'After',
              title: 'Ship a task',
              text: 'Rebase, review, triage, gate, open, merge, promote, close.',
            },
            {
              eyebrow: 'Anytime',
              title: 'Report an issue',
              text: 'File a defect with reproduction, environment and what is not established.',
            },
            {
              eyebrow: 'Upkeep',
              title: 'Sync the docs',
              text: 'Bring the doc store and the tree back into agreement.',
            },
          ]}
        />
      </Section>
      <Cta
        title={
          <>
            Same lifecycle.
            <br />
            Every repository.
          </>
        }
      />
    </main>
  )
}

export function DocStorePage() {
  return (
    <main className="site-page">
      <PageHero
        crumb="Doc store"
        title="One source of truth"
        muted="for the team and the models."
        copy="Your technical documentation lives in a store that people read and agents query — the same text, the same version, at the same moment. Nobody maintains a second copy for the machines, and no worker builds against a document that stopped being true last month."
        actions={[
          ['/docs', 'Read the docs guide'],
          ['/product/workflows', 'See workflows'],
        ]}
      />
      <Section
        eyebrow="The problem it removes"
        title="Documentation written twice is documentation wrong once"
      >
        <Cards
          two
          items={[
            {
              title: 'One store',
              text: 'Written once. Read by people in the dashboard and by agents over MCP.',
              bullets: [
                'Revisions are kept, so you can see what a worker was actually given.',
                'Cited by source in a prompt, never pasted into one.',
                'Agents write back too — a docs workflow reconciles the store with the code.',
              ],
            },
            {
              title: 'Same store, two readers',
              text: 'People browse and edit. Agents list documents, fetch a named subject and read the project brief.',
            },
          ]}
        />
      </Section>
      <Section
        eyebrow="Scopes"
        title="A worker is given what applies, and nothing else"
        intro="Scope is what keeps a prompt small without keeping it ignorant. The pack compiled for a run carries the documents that bear on it."
      >
        <Cards
          items={[
            {
              eyebrow: 'global',
              title: 'True everywhere',
              text: 'Standards that hold across every project.',
            },
            {
              eyebrow: 'stack',
              title: 'True of this runtime',
              text: 'What applies because of the language, framework or toolchain.',
            },
            {
              eyebrow: 'project',
              title: 'True here',
              text: "This repository's architecture, conventions and domain knowledge.",
            },
            {
              eyebrow: 'Into the tree',
              title: 'Rules written from the store',
              text: 'Rules agents read as files are written into the worktree from the store.',
            },
            {
              eyebrow: 'Revisions',
              title: 'What was true then',
              text: 'A run records the document revisions it was given.',
            },
            {
              eyebrow: 'Search',
              title: 'Indexed with the code',
              text: 'Docs sit in the same retrieval index as source and past runs.',
            },
          ]}
        />
      </Section>
      <Cta
        title={
          <>
            Write it once.
            <br />
            Everyone reads the same thing.
          </>
        }
      />
    </main>
  )
}

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
