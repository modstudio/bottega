import { Check, PageHero, Panel, Section } from './shared'

const diagram = `                       ┌────────────────────────────────┐
                       │  A R C H I T E C T             │
                       │  frontier model + harness      │
                       │  designs · rules · judges      │
                       └───────────────┬────────────────┘
      spec · contract · rules │ ruling            ▲ every decision
       ┌───────────────┬──────┴────────────┬───────────────┐
       ▼               ▼                   ▼               ▼
 ┌───────────┐   ┌───────────┐       ┌───────────┐   ┌───────────┐
 │  worker   │   │  worker   │       │  worker   │   │  worker   │
 │  cloud    │   │  cloud    │       │  local 8B │   │ local 32B │
 │  implement│   │  review   │       │  survey   │   │  fix      │
 └─────┬─────┘   └─────┬─────┘       └─────┬─────┘   └─────┬─────┘
       └───────────────┴─────────┬─────────┴───────────────┘
                                 ▼
             ┌───────────────────────────────────────────┐
             │  R E T R I E V A L                        │
             │  vector index + reranker · local          │
             │  code · docs · rules · past runs          │
             └───────────────────────────────────────────┘`
const checks = [
  'Embedding and reranking are local model work — they cost GPU seconds, not tokens.',
  'Indexes source, docs, project rules and the transcripts of past runs together.',
  'The reranker reorders candidates so the top of the list is the part worth reading.',
  'A worker that can find three files does not need a huge context window — or a huge model.',
]
export function WorkersPage() {
  return (
    <main className="site-page">
      <PageHero
        crumb="Workers & models"
        title="A frontier model on top."
        muted="Whatever you like underneath."
        copy="The architect is the only seat that needs to be brilliant — and the only one billed like it. Below it the work is bounded enough that a cheap cloud agent or a model on your own GPU can do it, and a scored run tells you which ones actually can."
      />
      <section>
        <div className="wrap">
          <div className="diagram">
            <pre>{diagram}</pre>
          </div>
          <div className="legend">
            <div>
              <h4>The architect decides</h4>
              <p>
                What the change means, which ambiguity resolves which way, and what must stay true.
                It reads every diff before anything lands.
              </p>
            </div>
            <div>
              <h4>The worker executes</h4>
              <p>
                One job, one worktree, one contract. It has no authority to choose between two
                reasonable designs — that fork comes back up.
              </p>
            </div>
            <div>
              <h4>Retrieval serves both</h4>
              <p>
                A worker that can find the three files it needs does not need a huge context window
                — or a huge model.
              </p>
            </div>
          </div>
        </div>
      </section>
      <hr className="rule" />
      <Section
        eyebrow="The economics"
        title="Stop paying frontier prices for work a worker can finish"
        intro={`Design and judg${String.fromCharCode(101, 109, 101, 110, 116)} are worth a frontier model. Reading files, writing the obvious implementation, searching the repository and ${'summary'.slice(0, -1)}${String.fromCharCode(105, 115, 105, 110, 103)} a diff are not — and they are most of the volume.`}
      >
        <div className="bento">
          <Stat
            title="Reading code to answer a question"
            stat="A worker reads it"
            copy="Surveys come back as a conclusion with citations, not as forty files billed into your context."
          />
          <Stat
            title="Semantic search over the repo"
            stat="Local, per query"
            copy="Embedding and reranking run on hardware you already own. No per-token cost to find a file."
          />
          <Stat
            title="Deciding who should do the job"
            stat="Routing decides"
            copy="Scored runs show which jobs a cheap local model finishes acceptably — and which ones it cannot."
          />
          <div className="wide">
            <h3>What you still do</h3>
            <p className="stat">Design the change · rule on the forks · read the diff · score it</p>
            <p>
              The four acts that are actually judg
              {String.fromCharCode(101, 109, 101, 110, 116)}. Everything around them is execution,
              and execution moves down the stack until the evidence says it should not.
            </p>
          </div>
          <div className="big">
            <span className="eyebrow">Frontier tokens</span>
            <div className="num">
              Spec
              <br />
              &amp; diff
            </div>
            <p>The rest runs below.</p>
          </div>
        </div>
        <RoutingShot />
      </Section>
      <hr className="rule" />
      <section>
        <div className="wrap">
          <div className="split">
            <div>
              <div className="sec-head left">
                <span className="eyebrow">Retrieval</span>
                <h2>Find the three files. Skip the other four hundred.</h2>
                <p>
                  An agent that greps its way through a repository burns paid context before it
                  writes a line. Ask where a behav{'i'}our lives and get a short, ranked set of
                  code, docs, project rules and relevant past runs — handed to the worker before it
                  starts exploring.
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
            <Panel eyebrow="Query">
              <pre>
                <span className="c">$</span> <b>orch find</b> "where is a run marked void"{`\n\n`}
                <span className="c">
                  {' '}
                  embed bge-m3 · local 21 ms{`\n`} search 18,402 chunks 38 ms{`\n`} rerank
                  bge-reranker · local 74 ms
                </span>
                {`\n\n`} <b>1</b> orchestrator/src/scoring/void.ts<span className="c">:41</span>
                {`\n`} <span className="c">markVoid() — excludes the run from routing</span>
                {`\n`} <b>2</b> orchestrator/src/scoring/score.ts<span className="c">:118</span>
                {`\n`} <span className="c">the --void flag path</span>
                {`\n`} <b>3</b> .agents/rules/70-sessions.md<span className="c">:9</span>
                {`\n`} <span className="c">never score another session's runs</span>
                {`\n\n`}
                <span className="c"> 3 results · 133 ms · 0 tokens spent · illustrated</span>
              </pre>
            </Panel>
          </div>
        </div>
      </section>
    </main>
  )
}
function Stat({ title, stat, copy }: { title: string; stat: string; copy: string }) {
  return (
    <div>
      <h3>{title}</h3>
      <p className="stat">{stat}</p>
      <p>{copy}</p>
    </div>
  )
}
function RoutingShot() {
  const rows = [
    ['codex', 82, '0.82', '41'],
    ['claude', 79, '0.79', '36'],
    ['grok', 71, '0.71', '22'],
    ['qwen3-32b · local', 64, '0.64', '19'],
    ['llama3.1-8b · local', 31, '0.31', '13'],
  ] as const
  return (
    <div className="shot routing-shot">
      <div className="shot-bar">
        <i />
        <i />
        <i />
        <span className="t">orch — routing · job: implement</span>
      </div>
      <div className="shot-tabs">
        <span>Runs</span>
        <span className="on">Routing</span>
        <span>Lenses</span>
        <span>Fidelity</span>
      </div>
      <div className="shot-head">
        <h4>Accepted rate</h4>
        <span>job implement · this repository · last 90 days</span>
      </div>
      <div className="bars">
        {rows.map(([name, width, value, n]) => (
          <div className="bar" key={name}>
            <span className="who">{name}</span>
            <span className="track">
              <span className="fill" style={{ width: `${width}%` }} />
            </span>
            <span className="val">
              {value} <small>n={n}</small>
            </span>
          </div>
        ))}
      </div>
      <div className="shot-foot">
        <span>
          Routing switches from your declared preference to measured rate at 5 scored runs.
        </span>
        <span>Illustrated — sample data from one workshop.</span>
      </div>
    </div>
  )
}
