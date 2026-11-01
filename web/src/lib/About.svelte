<script lang="ts">
  import { MARKETPLACE, type Settings } from './api';

  let { settings }: { settings: Settings } = $props();
</script>

<div class="about space-y-5">
  <section>
    <h2>Claude Grasp <span class="muted text-sm font-normal">v{settings.version}</span></h2>
    <p>
      How well do you understand the code Claude Code wrote for you? Claude Grasp reads your Claude Code sessions and your git history, scores every
      file Claude touched from 0 to 100 for how much you engaged with it, and shows exactly why. An optional daily question helps you close the gaps.
    </p>
  </section>

  <section class="card p-4">
    <div class="muted text-xs uppercase">Built by</div>
    <div class="mt-1 text-lg font-semibold">Asyncript</div>
    <p class="secondary text-sm">Claude Grasp is a project of Asyncript.</p>
    <div class="mt-3 flex flex-wrap gap-2">
      <a class="btn" href={MARKETPLACE.publisher}>Asyncript on the VS Code Marketplace</a>
      <a class="btn" href={MARKETPLACE.listing}>Rate or review Claude Grasp</a>
    </div>
  </section>

  <section>
    <h3>Your data</h3>
    <ul>
      <li>Read-only: your Claude Code sessions (<span class="mono">~/.claude*</span>) and your repositories' git history are never modified.</li>
      <li>Scores are kept in VS Code's storage for this extension, on your machine.</li>
      <li>No telemetry and no network calls, except the optional quiz through your own <span class="mono">claude -p</span>.</li>
      <li>When the quiz runs, Claude Code itself adds an empty <span class="mono">memory/</span> folder for Claude Grasp's workdir in that account.</li>
    </ul>
  </section>

  <section>
    <h3>Not affiliated</h3>
    <p class="secondary text-sm">Claude Grasp is an independent tool that works with Claude Code. It is not made or endorsed by Anthropic.</p>
  </section>
</div>

<style>
  .about {
    max-width: 44rem;
    font-size: 0.9rem;
    line-height: 1.55;
  }
  h2 {
    font-size: 1.15rem;
    font-weight: 600;
    margin-bottom: 0.35rem;
  }
  h3 {
    font-weight: 600;
    margin-bottom: 0.25rem;
  }
  ul {
    list-style: disc;
    padding-left: 1.2rem;
    display: grid;
    gap: 0.2rem;
  }
  a.btn {
    display: inline-block;
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 0.35rem 0.8rem;
    font-size: 0.85rem;
    color: var(--accent);
  }
  a.btn:hover {
    background: var(--surface-2);
  }
</style>
