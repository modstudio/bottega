import { Cards, PageHero, Section } from './shared'

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
        intro="Design and judgment are worth a frontier model. Reading files, writing the obvious implementation, searching the repository and summarizing a diff are not — and they are most of the volume."
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
              text: 'Design the change · rule on the forks · read the diff · score it. The four acts that are actually judgment.',
            },
            { eyebrow: 'Frontier tokens', title: 'Spec & diff', text: 'The rest runs below.' },
          ]}
        />
      </Section>
      <Section
        eyebrow="Retrieval"
        title="Find the three files. Skip the other four hundred."
        intro="An agent that greps its way through a repository burns paid context before it writes a line. Ask where a behavior lives and get a short, ranked set of code, docs, project rules and relevant past runs — handed to the worker before it starts exploring."
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
