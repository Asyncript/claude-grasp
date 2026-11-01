<script lang="ts">
  import { host, type Settings } from './api';

  let { settings }: { settings: Settings } = $props();
  const c = $derived(settings.scoring);
  const p = $derived(c.positive);

  const penalties = $derived([
    { name: 'Unattended edits', setting: 'penalties.unattended', now: c.negative.unattended, strict: 35, what: 'Lines written by headless claude -p runs that nobody watched.' },
    { name: 'Bare approvals', setting: 'penalties.bareApproval', now: c.negative.bareApproval, strict: 20, what: 'Turns that changed the file started with only "ok", "continue", "yes".' },
    { name: 'Accepted without you', setting: 'penalties.autoAccept', now: c.negative.autoAccept, strict: 10, what: 'Lines accepted by auto-accept, allow rules or bypass mode.' },
    { name: 'Code volume vs. your words', setting: 'penalties.codeVolume', now: c.negative.volume.points, strict: 15, what: `Lots of code for few words: none up to ${c.negative.volume.freeLinesPerWord} lines per word, all at ${c.negative.volume.fullLinesPerWord}.` },
    { name: 'Failed quiz answer', setting: 'penalties.failedQuiz', now: c.negative.quizFail.points, strict: 10, what: `Per answer graded below ${Math.round(c.quizPassGrade * 100)}%. Skipping never counts.` },
  ]);
</script>

<div class="guide space-y-6">
  <section>
    <h2>What Claude Grasp tells you</h2>
    <p>
      Claude Code writes a lot of code quickly. Claude Grasp estimates how well <b>you</b> understand each file it wrote, from what you actually did:
      the plans you shaped, the questions you asked, the corrections you made, the commits you wrote yourself. Every file gets a score from 0 to 100.
    </p>
    <div class="buckets mt-3">
      <div><span class="dot green"></span><b>{c.buckets.green}–100 Understood.</b> You clearly engaged with this code.</div>
      <div><span class="dot yellow"></span><b>{c.buckets.yellow}–{c.buckets.green - 1} Partial.</b> Some engagement; worth a closer look before you change it.</div>
      <div><span class="dot red"></span><b>0–{c.buckets.yellow - 1} At risk.</b> Claude wrote it and little shows that you know how it works.</div>
    </div>
  </section>

  <section>
    <h2>Reading the dashboard</h2>
    <ul>
      <li><b>Project score</b>: the average of its files, with bigger files counting more.</li>
      <li><b>File map</b>: one block per file. Bigger block = more lines Claude changed. Color = score. Click a block for the reasons.</li>
      <li><b>Never looked at</b>: files with no sign of your involvement at all. Start reviewing here.</li>
      <li><b>Trend</b>: the project score over time (daily for new projects, weekly later).</li>
      <li><b>Why this score</b>: every point, where it came from, and what would make the file green.</li>
      <li>In the editor: the <b>Explorer badge</b> and the <b>status bar</b> show the score of each file Claude touched.</li>
    </ul>
  </section>

  <section>
    <h2>What raises a score</h2>
    <p class="muted">Every file starts at {c.base}. Each kind of evidence adds points up to a cap, and loses half its value every {c.halfLifeDays} days.</p>
    <table>
      <thead><tr><th>You…</th><th>Points</th><th>Up to</th></tr></thead>
      <tbody>
        <tr><td>Approved a plan you shaped (edited it, wrote {c.plan.minWords}+ words, or answered/asked questions)</td><td>+{p.plan.points}</td><td>{p.plan.cap}</td></tr>
        <tr><td>Asked why / how / what if while Claude worked on the file</td><td>+{p.question.points}</td><td>{p.question.cap}</td></tr>
        <tr><td>Corrected or rejected Claude, or interrupted it</td><td>+{p.correction.points}</td><td>{p.correction.cap}</td></tr>
        <tr><td>Named the file or one of its functions, or had it open in the IDE</td><td>+{p.reference.points}</td><td>{p.reference.cap}</td></tr>
        <tr><td>Changed and committed it yourself</td><td>+{p.humanCommit.points}</td><td>{p.humanCommit.cap}</td></tr>
        <tr><td>Changed it outside Claude (weak signal)</td><td>+{p.externalEdit.points}</td><td>{p.externalEdit.cap}</td></tr>
        <tr><td>Explained it back in the quiz (scaled by the grade)</td><td>+{p.quizPass.points}</td><td>{p.quizPass.cap}</td></tr>
      </tbody>
    </table>
  </section>

  <section>
    <h2>Penalties: you decide</h2>
    <p>
      Everyone works differently. Many people keep auto-accept on and type "continue" all day, and that doesn't mean they don't understand the code.
      So every penalty except unattended edits is <b>off by default</b>. Turn on the ones that match how you want to be measured.
    </p>
    <table>
      <thead><tr><th>Penalty</th><th>Now</th><th>Strict</th><th></th></tr></thead>
      <tbody>
        {#each penalties as x (x.setting)}
          <tr>
            <td><b>{x.name}</b><div class="muted text-xs">{x.what}</div></td>
            <td>{x.now ? `−${x.now}` : 'Off'}</td>
            <td class="muted">−{x.strict}</td>
            <td><button class="link" onclick={() => host.openSettings(x.setting)}>Change</button></td>
          </tr>
        {/each}
      </tbody>
    </table>
  </section>

  <section>
    <h2>Suggested settings</h2>
    <div class="grid gap-3 sm:grid-cols-2">
      <div class="card p-3">
        <b>Fast flow</b> <span class="muted text-xs">(the default)</span>
        <p>Auto-accept on, lots of "continue". Keep every penalty off except unattended edits. Scores rise from questions, plans, corrections and your own commits.</p>
      </div>
      <div class="card p-3">
        <b>Careful reviewer</b>
        <p>You read every diff. Turn on <i>Bare approvals</i> (20) and <i>Accepted without you</i> (10) so rubber-stamped changes show up.</p>
      </div>
      <div class="card p-3">
        <b>Learning a codebase</b>
        <p>Turn the quiz on with 1–3 questions a day, plus <i>Failed quiz answer</i> (10) and <i>Code volume</i> (15) if you want honest pressure.</p>
      </div>
      <div class="card p-3">
        <b>Lots of automation</b>
        <p>If headless runs go through a review you trust (e.g. PRs), lower <i>Unattended edits</i> to 10–20; set 0 to ignore them.</p>
      </div>
    </div>
    <button class="btn mt-3" onclick={() => host.openSettings()}>Open Claude Grasp settings</button>
  </section>

  <section>
    <h2>How the quiz is graded</h2>
    <p>
      The quiz is off by default. When on, Claude Grasp picks one of today's files, favouring big changes and low scores, and your own <span class="mono">claude -p</span>
      writes a why/how question about that diff, along with key points a good answer should cover (hidden until you answer). Your answer, the question,
      the key points and the diff go back to <span class="mono">claude -p</span>, which grades it 0–100% with a line of feedback. {Math.round(c.quizPassGrade * 100)}%
      or more counts as a pass. Skipping is always free.
    </p>
  </section>

  <section>
    <h2>Privacy</h2>
    <p>
      Everything stays on your machine. Claude Grasp only reads your Claude Code sessions (<span class="mono">~/.claude*</span>) and your git history, and
      never changes them. The only thing that leaves your computer is the quiz, through your own <span class="mono">claude -p</span>, under the same Claude
      account that wrote the code. No telemetry.
    </p>
  </section>
</div>

<style>
  .guide {
    max-width: 52rem;
    font-size: 0.9rem;
    line-height: 1.55;
  }
  h2 {
    font-size: 1.05rem;
    font-weight: 600;
    margin-bottom: 0.35rem;
  }
  ul {
    list-style: disc;
    padding-left: 1.2rem;
    display: grid;
    gap: 0.2rem;
  }
  p + table {
    margin-top: 0.5rem;
  }
  table {
    width: 100%;
    margin-top: 0.5rem;
    font-size: 0.85rem;
  }
  th {
    text-align: left;
    font-weight: 500;
    color: var(--text-muted);
    font-size: 0.75rem;
  }
  td,
  th {
    padding: 0.35rem 0.5rem 0.35rem 0;
    border-top: 1px solid var(--border);
    vertical-align: top;
  }
  .buckets {
    display: grid;
    gap: 0.3rem;
  }
  .dot {
    display: inline-block;
    width: 0.7rem;
    height: 0.7rem;
    border-radius: 999px;
    margin-right: 0.45rem;
  }
  .dot.green {
    background: var(--good);
  }
  .dot.yellow {
    background: var(--warning);
  }
  .dot.red {
    background: var(--critical);
  }
  .link {
    color: var(--accent);
  }
  .card p {
    margin-top: 0.25rem;
    color: var(--text-secondary);
  }
</style>
