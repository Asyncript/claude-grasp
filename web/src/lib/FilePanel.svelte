<script lang="ts">
  import Badge from './Badge.svelte';
  import Info from './Info.svelte';
  import { api, host, pct, relTime, type Contribution, type FileDetail } from './api';

  let { detail, quizEnabled }: { detail: FileDetail; quizEnabled: boolean } = $props();

  const f = $derived(detail.file);
  const c = $derived(detail.config);
  let open = $state<Record<string, boolean>>({});
  const sign = (n: number) => (n > 0 ? `+${n}` : `${n}`);
  const clamped = $derived(f.raw !== f.score);
  const by = (key: string) => f.contributions.find((x) => x.key === key);
  const n = (key: string) => by(key)?.evidence.length ?? 0;
  const times = (k: number, one: string, many: string) => (k === 1 ? one : `${k} ${many}`);

  const POSITIVE = new Set(['plan', 'question', 'correction', 'reference', 'humanCommit', 'externalEdit', 'quizPass']);
  const SETTING: Record<string, string> = { bareApproval: 'penalties.bareApproval', autoAccept: 'penalties.autoAccept', volume: 'penalties.codeVolume', quizFail: 'penalties.failedQuiz', unattended: 'penalties.unattended' };
  const positives = $derived(f.contributions.filter((x) => POSITIVE.has(x.key)));
  const penalties = $derived(f.contributions.filter((x) => !POSITIVE.has(x.key) && x.key !== 'decay'));
  const decay = $derived(by('decay'));

  /** One plain sentence: what you did, and what pulls the score down. */
  const summary = $derived.by(() => {
    const did: string[] = [];
    if (n('plan')) did.push('planned it with Claude');
    if (n('question')) did.push(`asked ${times(n('question'), 'a question', 'questions')}`);
    if (n('correction')) did.push(`corrected Claude ${times(n('correction'), 'once', 'times')}`);
    if (n('reference')) did.push(`pointed Claude at it ${times(n('reference'), 'once', 'times')}`);
    if (n('humanCommit')) did.push(`committed changes yourself ${times(n('humanCommit'), 'once', 'times')}`);
    if (n('quizPass')) did.push('explained it back in the quiz');
    const head = did.length
      ? `You ${did.length > 1 ? did.slice(0, -1).join(', ') + ' and ' + did.at(-1) : did[0]}.`
      : 'Claude wrote this and nothing shows that you engaged with it yet.';
    const down: string[] = [];
    if (f.stats.unattendedShare) down.push(`${pct(f.stats.unattendedShare)} of it was written by unattended claude -p runs`);
    if ((decay?.points ?? 0) <= -3) down.push(`older evidence has faded (−${-decay!.points})`);
    for (const p of penalties) if (p.key !== 'unattended' && p.points <= -3) down.push(`${p.label.toLowerCase()} (${p.points})`);
    return down.length ? `${head} Pulling it down: ${down.join('; ')}.` : head;
  });

  const reviewDue = $derived(!f.stats.lastReview || (!!f.stats.lastEdit && f.stats.lastEdit > f.stats.lastReview));
  let reviewError = $state('');
  const review = () => api.markReviewed(detail.repo.id, f.path).then(() => (reviewError = ''), (e: Error) => (reviewError = e.message));

  /** What would add points from here, given what is already counted against each cap. */
  const toGreen = $derived.by(() => {
    const need = c.buckets.green - f.score;
    if (need <= 0) return null;
    const room = (key: keyof typeof c.positive) => {
      const used = (by(key)?.evidence ?? []).reduce((a, e) => a + e.points, 0);
      return Math.max(0, Math.round(c.positive[key].cap - used));
    };
    const tips = [
      { key: 'plan' as const, text: 'Plan the next change to it with Claude (plan mode) and add your own input', each: c.positive.plan.points },
      { key: 'question' as const, text: 'Ask Claude why or how while it works on this file', each: c.positive.question.points },
      { key: 'humanCommit' as const, text: 'Change it yourself and commit (no Claude trailer)', each: c.positive.humanCommit.points },
      { key: 'quizPass' as const, text: quizEnabled ? 'Explain it back in the daily quiz' : 'Explain it back in the quiz (turn the quiz on in Settings)', each: c.positive.quizPass.points },
      { key: 'reference' as const, text: 'Name the file or one of its functions in your prompts', each: c.positive.reference.points },
      { key: 'correction' as const, text: 'Correct or reject Claude when an edit to it is wrong', each: c.positive.correction.points },
      ...(reviewDue ? [{ key: 'reviewed' as const, text: "Read Claude's latest changes and mark it reviewed", each: c.positive.reviewed.points }] : []),
    ]
      .map((t) => ({ ...t, room: room(t.key) }))
      .filter((t) => t.room > 0);
    return { need, tips };
  });

  const offText = (x: Contribution) => (x.off ? 'Off' : sign(x.points));
</script>

<div class="space-y-4">
  <div>
    <div class="flex items-start justify-between gap-2">
      <div class="mono text-sm break-all">{f.path}</div>
      <button class="btn shrink-0" onclick={() => host.openFile(detail.repo.path, f.path)}>Open file</button>
    </div>
    <div class="mt-1 flex items-center gap-2">
      <Badge bucket={f.bucket} score={f.score} />
      {#if f.neverUnderstood}<span class="crit text-sm">Never looked at</span>{/if}
      {#if reviewDue}
        <button class="btn ml-auto" title="You read Claude's latest changes to this file" onclick={review}>Mark as reviewed</button>
      {:else}
        <span class="muted ml-auto text-xs">Reviewed {relTime(f.stats.lastReview)}</span>
      {/if}
    </div>
    {#if reviewError}<p class="crit mt-1 text-xs">{reviewError}</p>{/if}
    <p class="summary mt-2 text-sm">{summary}</p>
    <div class="muted mt-1 text-xs">
      {f.stats.linesChanged} lines in {f.stats.edits} edits · first {relTime(f.stats.firstEdit)} · last {relTime(f.stats.lastEdit)}
    </div>
  </div>

  {#if toGreen}
    <div class="green-box">
      <h3 class="text-sm font-semibold">
        How to make this green
        <Info label="How to make this green">
          A file turns green at {c.buckets.green}. These actions add points the next time Claude works on the file. Each kind of evidence has a cap; the
          list only shows what still has room. Evidence fades: it loses half its value every {c.halfLifeDays} days, down to {Math.round(c.decayFloor * 100)}%.
        </Info>
      </h3>
      <p class="secondary text-xs">{toGreen.need} more point{toGreen.need === 1 ? '' : 's'} needed.</p>
      <ul class="mt-1 space-y-1 text-sm">
        {#each toGreen.tips as t (t.key)}
          <li class="flex justify-between gap-2"><span>{t.text}</span><span class="good shrink-0">+{t.each} each, up to +{t.room}</span></li>
        {/each}
      </ul>
    </div>
  {/if}

  <div>
    <h3 class="mb-1 text-sm font-semibold">
      Why this score
      <Info label="Why this score">
        Every file starts at {f.base}. What you did adds points, penalties take points away, and old evidence fades. The rows always add up to the
        score (clamped to 0–100). Click a count to see the exact prompts, commits or answers behind it.
      </Info>
    </h3>
    <table class="w-full text-sm">
      <tbody>
        <tr class="row">
          <td class="pts">{f.base}</td>
          <td>Starting point <span class="muted">— every file starts here</span></td>
        </tr>
        {#each [...positives, ...(decay ? [decay] : []), ...penalties] as x (x.key)}
          <tr class="row" class:zero={x.points === 0}>
            <td class="pts" class:pos={x.points > 0} class:neg={x.points < 0}>{offText(x)}</td>
            <td>
              <div>
                {x.label}
                {#if x.off}
                  <button class="link" onclick={() => host.openSettings(SETTING[x.key])}>turn on in Settings</button>
                {:else if x.evidence.length}
                  <button class="link" onclick={() => (open[x.key] = !open[x.key])}>
                    {open[x.key] ? 'hide' : `${x.evidence.length} item${x.evidence.length > 1 ? 's' : ''}`}
                  </button>
                {/if}
              </div>
              <div class="muted text-xs">{x.off ? 'Off by default, because workflows differ. Nothing is counted.' : x.detail}</div>
              {#if open[x.key] && !x.off}
                <ul class="evidence">
                  {#each x.evidence as e, i (i)}
                    <li>
                      <span class="muted">{new Date(e.ts).toLocaleDateString()}</span>
                      {#if e.points}<span class="mono">{sign(Math.round(e.points * 10) / 10)}</span>{/if}
                      {e.text}
                      {#if e.sha}<span class="mono muted">{e.sha.slice(0, 7)}</span>{/if}
                    </li>
                  {/each}
                </ul>
              {/if}
            </td>
          </tr>
        {/each}
        <tr class="total">
          <td class="pts">{f.score}</td>
          <td>
            Score
            {#if clamped}<span class="muted text-xs">— the sum is {f.raw}, clamped to 0–100</span>{/if}
          </td>
        </tr>
      </tbody>
    </table>
  </div>

  {#if detail.accounts.length}
    <div>
      <h3 class="mb-1 text-sm font-semibold">Claude accounts</h3>
      <ul class="text-sm">
        {#each detail.accounts as d (d.dir)}
          <li><b>{d.name}</b> <span class="mono muted text-xs">{d.dir}</span> <span class="muted">· {d.lines} lines</span></li>
        {/each}
      </ul>
    </div>
  {/if}

  <div>
    <h3 class="mb-1 text-sm font-semibold">Sessions</h3>
    {#if detail.sessions.length}
      <ul class="space-y-1 text-sm">
        {#each detail.sessions as s (s.id)}
          <li>
            <div>{s.title || s.id.slice(0, 8)}{#if s.headless}<span class="tag">unattended</span>{/if}</div>
            <div class="muted text-xs">{relTime(s.started_at)} · {s.edits} edits · <span class="mono">{s.id.slice(0, 8)}</span></div>
          </li>
        {/each}
      </ul>
    {:else}
      <p class="muted text-sm">No sessions.</p>
    {/if}
  </div>
</div>

<style>
  .summary {
    line-height: 1.5;
  }
  .green-box {
    border: 1px dashed var(--axis);
    border-radius: 10px;
    padding: 0.6rem 0.75rem;
  }
  .row td,
  .total td {
    padding: 0.35rem 0;
    vertical-align: top;
    border-top: 1px solid var(--border);
  }
  .total td {
    font-weight: 600;
    border-top: 2px solid var(--axis);
  }
  .pts {
    width: 3.5rem;
    font-variant-numeric: tabular-nums;
    font-weight: 600;
  }
  .pos,
  .good {
    color: var(--good-text);
  }
  .neg,
  .crit {
    color: var(--critical-text);
  }
  .zero {
    color: var(--text-muted);
  }
  .link {
    color: var(--accent);
    font-size: 0.75rem;
    margin-left: 0.25rem;
  }
  .evidence {
    margin-top: 0.25rem;
    font-size: 0.78rem;
    display: grid;
    gap: 0.2rem;
  }
  .evidence li {
    padding-left: 0.5rem;
    border-left: 2px solid var(--grid);
  }
  .tag {
    margin-left: 0.4rem;
    font-size: 0.7rem;
    padding: 0 0.35rem;
    border-radius: 4px;
    background: var(--surface-2);
    color: var(--text-secondary);
  }
</style>
