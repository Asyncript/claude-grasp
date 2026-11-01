<script lang="ts">
  import About from './lib/About.svelte';
  import Badge from './lib/Badge.svelte';
  import FilePanel from './lib/FilePanel.svelte';
  import Guide from './lib/Guide.svelte';
  import Info from './lib/Info.svelte';
  import Today from './lib/Today.svelte';
  import Treemap from './lib/Treemap.svelte';
  import Trend from './lib/Trend.svelte';
  import { api, BUCKET_LABEL, inVsCode, onHostMessage, pct, prefs, relTime, type Bucket, type FileDetail, type FilesResponse, type ProjectsResponse, type ScoresResponse } from './lib/api';

  // Routes: #/today, #/guide, #/about, #/repo/<id>, #/repo/<id>/<file path>. Kept in state rather
  // than location.hash, because VS Code webviews swallow clicks on # links.
  const initial = document.getElementById('app')?.dataset.route || (inVsCode ? '' : location.hash) || prefs.get('route', '');
  let hash = $state(initial);
  const route = $derived.by(() => {
    const m = hash.match(/^#\/repo\/(\d+)(?:\/(.+))?$/);
    if (m) return { view: 'repo' as const, repo: Number(m[1]), path: m[2] ? decodeURIComponent(m[2]) : null };
    const view = ({ '#/today': 'today', '#/guide': 'guide', '#/about': 'about' } as const)[hash] ?? 'home';
    return { view, repo: null, path: null };
  });
  function go(h: string) {
    hash = h;
    prefs.set('route', h);
    if (!inVsCode) history.replaceState(null, '', h || '#/');
  }

  // Theme: Auto follows VS Code's theme (or the system's, in the preview).
  let theme = $state<'auto' | 'light' | 'dark'>(prefs.get('theme', 'auto'));
  let editorDark = $state(false);
  function readEditorTheme() {
    const cl = document.body.classList;
    if (cl.contains('vscode-light') || cl.contains('vscode-high-contrast-light')) editorDark = false;
    else if (cl.contains('vscode-dark') || cl.contains('vscode-high-contrast')) editorDark = true;
    else editorDark = matchMedia('(prefers-color-scheme: dark)').matches;
  }
  readEditorTheme();
  new MutationObserver(readEditorTheme).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', readEditorTheme);
  $effect(() => {
    document.documentElement.dataset.theme = theme === 'auto' ? (editorDark ? 'dark' : 'light') : theme;
    prefs.set('theme', theme);
  });

  let account = $state<string>(prefs.get('account', ''));
  let projects = $state<ProjectsResponse | null>(null);
  let files = $state<FilesResponse | null>(null);
  let scores = $state<ScoresResponse | null>(null);
  let detail = $state<FileDetail | null>(null);
  let error = $state('');
  let refreshing = $state(false);
  let version = $state(0);
  let sortBy = $state<'score' | 'lines' | 'recent'>('score');
  let bucket = $state<Bucket | null>(null);
  let search = $state('');
  let showIntro = $state(!prefs.get('introDismissed', false));

  async function loadProjects() {
    try {
      projects = await api.projects(account || undefined);
      error = '';
    } catch (e) {
      error = (e as Error).message;
    }
  }

  async function refresh() {
    refreshing = true;
    try {
      await api.ingest();
      version++;
    } catch (e) {
      error = (e as Error).message;
    } finally {
      refreshing = false;
    }
  }

  onHostMessage((m) => {
    if (m.type === 'changed') version++;
    if (m.type === 'navigate' && typeof m.route === 'string') go(m.route);
  });

  $effect(() => {
    void version;
    prefs.set('account', account);
    void loadProjects();
  });

  // Without a project (or with one the account filter hides), open the one with the most AI-written lines.
  $effect(() => {
    if (!projects?.projects.length) return;
    const missing = route.view === 'repo' && !projects.projects.some((p) => p.id === route.repo);
    if (route.view === 'home' || missing) {
      const top = [...projects.projects].sort((a, b) => b.summary.linesChanged - a.summary.linesChanged)[0]!;
      go(`#/repo/${top.id}`);
    }
  });

  $effect(() => {
    const repo = route.repo;
    const acc = account || undefined;
    void version;
    if (repo === null) return;
    Promise.all([api.files(repo, acc), api.scores(repo, acc)])
      .then(([f, s]) => {
        files = f;
        scores = s;
      })
      .catch((e: Error) => (error = e.message));
  });

  $effect(() => {
    const { repo, path } = route;
    void version;
    if (repo === null || !path) {
      detail = null;
      return;
    }
    api.file(repo, path).then((d) => (detail = d)).catch(() => (detail = null));
  });

  const visible = $derived.by(() => {
    const q = search.trim().toLowerCase();
    return (files?.files ?? []).filter((f) => (!bucket || f.bucket === bucket) && (!q || f.path.toLowerCase().includes(q)));
  });
  const sorted = $derived.by(() => {
    const list = [...visible];
    if (sortBy === 'score') list.sort((a, b) => a.score - b.score || b.lines - a.lines);
    if (sortBy === 'lines') list.sort((a, b) => b.lines - a.lines);
    if (sortBy === 'recent') list.sort((a, b) => (b.lastEdit ?? '').localeCompare(a.lastEdit ?? ''));
    return list;
  });
  const current = $derived(projects?.projects.find((p) => p.id === route.repo) ?? null);
  const settings = $derived(projects?.settings ?? null);
  const fileHref = (path: string) => `#/repo/${route.repo}/${encodeURIComponent(path)}`;
  const toggleBucket = (b: Bucket) => (bucket = bucket === b ? null : b);
  const fmtDate = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
  const tabs = [
    { view: 'repo', label: 'Overview' },
    { view: 'today', label: 'Today' },
    { view: 'guide', label: 'Guide' },
    { view: 'about', label: 'About' },
  ] as const;
  const tabHref = (v: (typeof tabs)[number]['view']) => (v === 'repo' ? (current ? `#/repo/${current.id}` : '') : `#/${v}`);
  const isTab = (v: (typeof tabs)[number]['view']) => (v === 'repo' ? route.view === 'repo' || route.view === 'home' : route.view === v);
</script>

<header class="border-b" style="border-color: var(--border); background: var(--surface-1)">
  <div class="mx-auto flex max-w-7xl flex-wrap items-center gap-3 px-4 py-3">
    <span class="text-lg font-semibold">Claude Grasp</span>
    {#if settings?.demo}<span class="demo" title="Sample data, not your sessions">Demo data</span>{/if}
    <nav class="flex gap-1 text-sm" aria-label="Sections">
      {#each tabs as t (t.view)}
        <button class="tab" class:active={isTab(t.view)} onclick={() => go(tabHref(t.view))}>{t.label}</button>
      {/each}
    </nav>
    <div class="ml-auto flex flex-wrap items-center gap-2">
      {#if projects && projects.accounts.length > 1}
        <select class="px-2 py-1 text-sm" bind:value={account} aria-label="Claude account">
          <option value="">All accounts</option>
          {#each projects.accounts as a (a.dir)}
            <option value={a.dir}>{a.name} account</option>
          {/each}
        </select>
      {/if}
      <select class="px-2 py-1 text-sm" bind:value={theme} aria-label="Theme">
        <option value="auto">Theme: Auto</option>
        <option value="light">Theme: Light</option>
        <option value="dark">Theme: Dark</option>
      </select>
      <button class="btn" onclick={refresh} disabled={refreshing} title="Read new Claude Code sessions and commits">{refreshing ? 'Reading…' : 'Refresh'}</button>
    </div>
  </div>
</header>

<main class="mx-auto max-w-7xl px-4 py-5">
  {#if error}<p class="crit mb-3 text-sm">{error}</p>{/if}

  {#if route.view === 'today'}
    <div class="max-w-3xl"><Today {version} onchange={() => version++} onopen={(repo, path) => go(`#/repo/${repo}/${encodeURIComponent(path)}`)} /></div>
  {:else if route.view === 'guide'}
    {#if settings}<Guide {settings} />{/if}
  {:else if route.view === 'about'}
    {#if settings}<About {settings} />{/if}
  {:else if projects && !projects.projects.length}
    <div class="card max-w-2xl p-5">
      <h2 class="font-semibold">No files edited by Claude Code yet</h2>
      <p class="secondary mt-1 text-sm">
        Looked in: <span class="mono">{projects.roots.join(', ') || 'no Claude config folders found'}</span>. Once Claude Code edits files in a git repository,
        they show up here. To look around first, run <b>Claude Grasp: Open Demo</b> from the Command Palette.
      </p>
    </div>
  {:else if current && files && scores}
    {#if showIntro}
      <section class="intro card mb-4 p-4">
        <div class="flex items-start justify-between gap-3">
          <h2 class="font-semibold">How to read this</h2>
          <button class="btn" onclick={() => ((showIntro = false), prefs.set('introDismissed', true))}>Got it</button>
        </div>
        <ul class="mt-1 text-sm">
          <li>Each file Claude Code changed gets a score from 0 to 100: <b>how well you understand it</b>, judged from what you did, not from the code.</li>
          <li>
            <span class="good">■</span> <b>{scores.config.buckets.green}+ Understood</b> · <span class="warn">■</span> <b>{scores.config.buckets.yellow}–{scores.config.buckets.green - 1} Partial</b> ·
            <span class="crit">■</span> <b>under {scores.config.buckets.yellow} At risk</b>. A file goes green when you plan with Claude, ask why/how, correct it, or commit changes yourself.
          </li>
          <li>Click any file to see every point behind its score and <b>what would make it green</b>. The <b>i</b> buttons explain each part.</li>
          <li>Penalties for auto-accept, "continue" and similar are off unless you turn them on in <b>Settings</b>. See the <button class="link" onclick={() => go('#/guide')}>Guide</button>.</li>
        </ul>
      </section>
    {/if}

    <section class="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
      <select class="px-2 py-1 text-base font-semibold" value={route.repo ?? ''} onchange={(e) => go(`#/repo/${e.currentTarget.value}`)} aria-label="Project">
        {#each projects?.projects ?? [] as p (p.id)}
          <option value={p.id}>{p.name} — {p.summary.score}</option>
        {/each}
      </select>
      <span class="mono muted truncate" title={current.path}>{current.path}</span>
      <span class="secondary">Accounts: {current.accounts.map((a) => a.name).join(', ')}</span>
      <span class="secondary">{current.sessions} sessions · {current.summary.linesChanged} lines by Claude</span>
      <span class="secondary">Claude here since {fmtDate(current.firstEdit)}, last {relTime(current.lastEdit)}</span>
    </section>

    <section class="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <div class="card p-4">
        <div class="label">How well you know this project <Info label="Project score">The average score of all files Claude changed here, with bigger files counting more. Green means you clearly engaged with most of the code.</Info></div>
        <div class="mt-1 flex items-baseline gap-2"><span class="text-3xl font-semibold">{scores.summary.score}</span><Badge bucket={scores.summary.bucket} /></div>
        <div class="muted mt-1 text-xs">out of 100</div>
      </div>
      <div class="card p-4">
        <div class="label">Files Claude changed <Info label="Files by score">Click a color to show only those files in the map and the list. Click it again to show all.</Info></div>
        <div class="mt-1 text-3xl font-semibold">{scores.summary.files}</div>
        <div class="mt-1 flex flex-wrap gap-1 text-xs">
          {#each ['green', 'yellow', 'red'] as const as b (b)}
            <button class="chip {b}" class:on={bucket === b} aria-pressed={bucket === b} onclick={() => toggleBucket(b)}>{scores.summary.buckets[b]} {BUCKET_LABEL[b].toLowerCase()}</button>
          {/each}
        </div>
      </div>
      <div class="card p-4">
        <div class="label">Never looked at <Info label="Never looked at">Files with no sign of you at all: no plan, question, correction, mention, own commit or quiz answer. The best place to start reviewing.</Info></div>
        <div class="mt-1 text-3xl font-semibold">{scores.summary.neverUnderstood}</div>
        <div class="muted mt-1 text-xs">files with no sign of you</div>
      </div>
      <div class="card p-4">
        <div class="label">Written unattended <Info label="Unattended" align="right">Share of changed lines written by headless <span class="mono">claude -p</span> runs that nobody watched (scripts, CI, automations). These lines lose points unless you turn that penalty off.</Info></div>
        <div class="mt-1 text-3xl font-semibold">{pct(scores.summary.unattendedShare)}</div>
        <div class="muted mt-1 text-xs">of lines, by headless runs</div>
      </div>
    </section>

    <div class="grid gap-4 lg:grid-cols-[minmax(0,1fr)_400px]">
      <div class="min-w-0 space-y-4">
        <section class="card p-4">
          <div class="mb-2 flex flex-wrap items-baseline justify-between gap-2">
            <h2 class="font-semibold">File map <Info label="File map">One block per file. A bigger block means Claude changed more lines in it; the color is its score. Hover for details, click for the reasons.</Info></h2>
            <span class="muted text-xs">{bucket ? `Showing ${BUCKET_LABEL[bucket].toLowerCase()} files · ` : ''}size = lines changed · color = score</span>
          </div>
          {#if visible.length}
            <Treemap files={visible} selected={route.path} onselect={(p) => go(fileHref(p))} />
          {:else}
            <p class="muted text-sm">No files match.</p>
          {/if}
        </section>

        <section class="card p-4">
          <h2 class="mb-2 font-semibold">
            Trend <Info label="Trend">The project score over time ({scores.trendStepDays === 1 ? 'daily, since the project is new' : 'weekly'}). It rises as you engage with the code and slowly falls as old evidence fades.</Info>
          </h2>
          <Trend points={scores.trend} daily={scores.trendStepDays === 1} green={scores.config.buckets.green} yellow={scores.config.buckets.yellow} />
        </section>

        {#if scores.neverUnderstood.length && !bucket}
          <section class="card p-4">
            <h2 class="font-semibold">Start here: never looked at</h2>
            <p class="muted mb-2 text-xs">Claude wrote these and nothing shows you engaged with them. Biggest first.</p>
            <ul class="text-sm">
              {#each scores.neverUnderstood.slice(0, 8) as n (n.path)}
                <li class="flex justify-between gap-2 border-t py-1" style="border-color: var(--border)">
                  <button class="mono file truncate text-left" onclick={() => go(fileHref(n.path))}>{n.path}</button>
                  <span class="muted shrink-0">{n.lines} lines{n.unattendedShare ? ` · ${pct(n.unattendedShare)} unattended` : ''} · {relTime(n.lastEdit)}</span>
                </li>
              {/each}
            </ul>
          </section>
        {/if}

        <section class="card p-4">
          <div class="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h2 class="font-semibold">All files <span class="muted text-sm font-normal">({visible.length})</span></h2>
            <div class="flex gap-2">
              <input class="px-2 py-1 text-xs" type="search" placeholder="Filter by name…" bind:value={search} aria-label="Filter files" />
              <select class="px-2 py-1 text-xs" bind:value={sortBy} aria-label="Sort files">
                <option value="score">Lowest score</option>
                <option value="lines">Most lines</option>
                <option value="recent">Most recent</option>
              </select>
            </div>
          </div>
          <table class="w-full table-fixed text-sm">
            <thead class="muted text-left text-xs">
              <tr><th class="py-1">File</th><th class="w-32">Score</th><th class="w-16 text-right">Lines</th><th class="w-24 text-right">Unattended</th><th class="w-24 text-right">Last edit</th></tr>
            </thead>
            <tbody>
              {#each sorted as f (f.path)}
                <tr class="border-t" style="border-color: var(--border)" class:sel={route.path === f.path}>
                  <td class="truncate py-1 pr-2" title={f.path}><button class="mono file text-left" onclick={() => go(fileHref(f.path))}>{f.path}</button></td>
                  <td><Badge bucket={f.bucket} score={f.score} /></td>
                  <td class="text-right">{f.lines}</td>
                  <td class="text-right">{f.unattendedShare ? pct(f.unattendedShare) : '—'}</td>
                  <td class="muted text-right">{relTime(f.lastEdit)}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </section>
      </div>

      <aside class="card h-fit p-4 lg:sticky lg:top-4">
        {#if detail}
          <FilePanel {detail} quizEnabled={settings?.quizEnabled ?? false} />
        {:else}
          <h2 class="font-semibold">Pick a file</h2>
          <p class="muted mt-1 text-sm">Click a block in the map or a row in the list to see exactly which signals produced its score, and what would make it green.</p>
          <div class="mt-4 text-sm">
            <div class="secondary text-xs">Claude accounts in this project</div>
            {#each current.accounts as a (a.dir)}
              <div><b>{a.name}</b> <span class="mono muted text-xs">{a.dir}</span> <span class="muted">· {a.sessions} sessions</span></div>
            {/each}
          </div>
        {/if}
      </aside>
    </div>
  {:else if !error}
    <p class="muted text-sm">Loading…</p>
  {/if}
</main>

<style>
  .demo {
    font-size: 0.75rem;
    padding: 0.1rem 0.5rem;
    border-radius: 999px;
    background: var(--warning);
    color: var(--on-warning);
  }
  .tab {
    padding: 0.25rem 0.65rem;
    border-radius: 6px;
    color: var(--text-secondary);
  }
  .tab:hover {
    color: var(--text-primary);
  }
  .tab.active {
    background: var(--surface-2);
    color: var(--text-primary);
  }
  .label {
    font-size: 0.78rem;
    color: var(--text-secondary);
  }
  .chip {
    padding: 0.1rem 0.5rem;
    border-radius: 999px;
    border: 1px solid var(--border);
    color: var(--text-secondary);
  }
  .chip::before {
    content: '';
    display: inline-block;
    width: 0.55rem;
    height: 0.55rem;
    border-radius: 999px;
    margin-right: 0.3rem;
  }
  .chip.green::before {
    background: var(--good);
  }
  .chip.yellow::before {
    background: var(--warning);
  }
  .chip.red::before {
    background: var(--critical);
  }
  .chip:hover,
  .chip.on {
    border-color: var(--accent);
    color: var(--text-primary);
  }
  .chip.on {
    background: var(--surface-2);
  }
  .intro ul {
    list-style: disc;
    padding-left: 1.2rem;
    display: grid;
    gap: 0.25rem;
    color: var(--text-secondary);
  }
  .link {
    color: var(--accent);
  }
  button.file:hover {
    text-decoration: underline;
  }
  tr.sel {
    background: var(--surface-2);
  }
  .crit {
    color: var(--critical-text);
  }
  .good {
    color: var(--good);
  }
  .warn {
    color: var(--warning);
  }
  input[type='search'] {
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: 8px;
    color: var(--text-primary);
  }
</style>
