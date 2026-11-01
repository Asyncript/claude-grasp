<script lang="ts">
  import Badge from './Badge.svelte';
  import Info from './Info.svelte';
  import { api, host, type TodaySummary } from './api';

  let { onchange, onopen, version = 0 }: { onchange: () => void; onopen: (repo: number, path: string) => void; version?: number } = $props();

  let today = $state<(TodaySummary & { quizEnabled: boolean }) | null>(null);
  let error = $state('');
  let busy = $state(false);
  let drafts = $state<Record<number, string>>({});
  let working = $state<Record<number, boolean>>({});

  async function load() {
    try {
      today = await api.today();
      error = '';
    } catch (e) {
      error = (e as Error).message;
    }
  }

  async function makeQuiz() {
    busy = true;
    error = '';
    try {
      await api.makeQuiz();
      await load();
    } catch (e) {
      error = (e as Error).message;
    } finally {
      busy = false;
    }
  }

  async function act(id: number, fn: () => Promise<unknown>) {
    working[id] = true;
    try {
      await fn();
      await load();
      onchange();
    } catch (e) {
      error = (e as Error).message;
    } finally {
      working[id] = false;
    }
  }

  const answer = (id: number) => {
    const text = drafts[id]?.trim();
    if (text) void act(id, () => api.answer(id, text));
  };

  $effect(() => {
    void version;
    void load();
  });
</script>

{#if error}<p class="crit text-sm">{error}</p>{/if}
{#if today}
  {@const t = today.totals}
  <div class="space-y-5">
    <div>
      <h2 class="text-lg font-semibold">
        {today.dataDay === today.day ? 'Today' : `Nothing yet today — showing ${today.dataDay}`}
      </h2>
      {#if t.files}
        <p class="secondary text-sm">
          Claude changed <b>{t.lines}</b> lines in <b>{t.files}</b> files over {t.sessions} session{t.sessions === 1 ? '' : 's'}.
          You sent {t.prompts} prompts, with {t.questions} question{t.questions === 1 ? '' : 's'} and {t.corrections} correction{t.corrections === 1 ? '' : 's'}.
          {#if t.unattendedEdits}<b>{t.unattendedEdits}</b> edits ran unattended.{/if}
        </p>
      {:else}
        <p class="secondary text-sm">No Claude edits in the last week.</p>
      {/if}
    </div>

    {#if today.files.length}
      <table class="w-full text-sm">
        <thead class="muted text-left text-xs">
          <tr><th class="py-1">File</th><th class="w-32">Lines</th><th class="w-32">Score</th></tr>
        </thead>
        <tbody>
          {#each today.files as f (f.repoId + f.path)}
            <tr class="border-t" style="border-color: var(--border)">
              <td class="py-1"><button class="file text-left" onclick={() => onopen(f.repoId, f.path)}><span class="muted">{f.repo}/</span><span class="mono">{f.path}</span></button></td>
              <td>{f.lines}{#if f.unattendedLines}<span class="muted"> ({f.unattendedLines} unattended)</span>{/if}</td>
              <td>{#if f.bucket && f.score !== null}<Badge bucket={f.bucket} score={f.score} />{/if}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}

    <div class="card p-4">
      <h2 class="text-lg font-semibold">
        Explain it back
        <Info label="The explain-back quiz">
          Optional. Once a day Claude Grasp picks a file Claude changed a lot that you may not know well, and your own <span class="mono">claude -p</span>
          writes a short why/how question about that diff. You answer in a sentence or two; <span class="mono">claude -p</span> compares it with the
          diff and hidden key points and grades it 0–100%. 60% or more adds up to +25 to that file. A low grade or a skip costs nothing (unless you turn
          that penalty on). Code only goes to the same Claude account that wrote it.
        </Info>
      </h2>
      {#if !today.quizEnabled}
        <p class="secondary mt-1 text-sm">The quiz is off. When it's on you get one short question a day about code Claude wrote, and a good answer raises that file's score. Skipping is always fine.</p>
        <button class="btn primary mt-2" onclick={() => host.openSettings('quiz.enabled')}>Turn on in Settings</button>
      {:else}
        {#if today.explainBackDisabled.length}
          <p class="muted text-xs">The quiz is off for {today.explainBackDisabled.join(', ')}; their files are left out.</p>
        {/if}
        {#if !today.quiz}
          <p class="secondary mb-2 text-sm">A short question about today's changes, written and graded by your local <span class="mono">claude -p</span>. Takes a minute; skip it any time.</p>
          <button class="btn primary" onclick={makeQuiz} disabled={busy || !t.files}>{busy ? 'Writing the question…' : 'Get today’s question'}</button>
        {:else}
          <ol class="mt-2 space-y-4">
            {#each today.quiz.questions as q, i (q.id)}
              <li class="q p-3">
                <div class="muted text-xs">{today.quiz.questions.length > 1 ? `Q${i + 1} · ` : ''}<span class="mono">{q.path}</span></div>
                <div class="mt-1">{q.question}</div>
                {#if q.score === null && !q.skipped}
                  <textarea class="mt-2 w-full p-2 text-sm" rows="3" placeholder="A sentence or two in your own words…" bind:value={drafts[q.id]}></textarea>
                  <div class="mt-1 flex gap-2">
                    <button class="btn primary" onclick={() => answer(q.id)} disabled={working[q.id] || !drafts[q.id]?.trim()}>{working[q.id] ? 'Grading…' : 'Submit'}</button>
                    <button class="btn" onclick={() => act(q.id, () => api.skip(q.id))} disabled={working[q.id]}>Skip</button>
                  </div>
                {:else if q.score === null}
                  <div class="muted mt-2 text-sm">Skipped — no effect on the score.</div>
                {:else}
                  <div class="secondary mt-2 text-sm italic">“{q.answer}”</div>
                  <div class="mt-2 text-sm">
                    <b class={q.score >= 0.6 ? 'good' : 'crit'}>{Math.round(q.score * 100)}% · {q.score >= 0.6 ? 'Pass' : 'Not yet'}</b>
                    — {q.feedback}
                  </div>
                  {#if q.expected}<div class="muted mt-1 text-xs">A good answer covers: {q.expected}</div>{/if}
                {/if}
              </li>
            {/each}
          </ol>
        {/if}
      {/if}
    </div>
  </div>
{/if}

<style>
  .crit {
    color: var(--critical-text);
  }
  .good {
    color: var(--good-text);
  }
  .q {
    border: 1px solid var(--border);
    border-radius: 10px;
  }
  .file:hover .mono {
    text-decoration: underline;
  }
</style>
