<script lang="ts">
  import type { Snippet } from 'svelte';

  let { label, children, align = 'left' }: { label: string; children: Snippet; align?: 'left' | 'right' } = $props();
  let open = $state(false);
  let root: HTMLSpanElement;

  function outside(e: MouseEvent) {
    if (open && !root.contains(e.target as Node)) open = false;
  }
</script>

<svelte:window onclick={outside} onkeydown={(e) => e.key === 'Escape' && (open = false)} />

<span class="info" bind:this={root}>
  <button class="i" aria-label="What is {label}?" aria-expanded={open} onclick={() => (open = !open)}>i</button>
  {#if open}
    <span class="pop card" class:right={align === 'right'} role="note">
      <b class="block">{label}</b>
      {@render children()}
    </span>
  {/if}
</span>

<style>
  .info {
    position: relative;
    display: inline-block;
    vertical-align: middle;
  }
  .i {
    width: 1.05rem;
    height: 1.05rem;
    border-radius: 999px;
    border: 1px solid var(--axis);
    color: var(--text-muted);
    font: italic 600 0.68rem/1 Georgia, serif;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    margin-left: 0.3rem;
  }
  .i:hover,
  .i[aria-expanded='true'] {
    color: var(--accent);
    border-color: var(--accent);
  }
  .pop {
    position: absolute;
    z-index: 20;
    top: 1.5rem;
    left: -0.5rem;
    width: min(20rem, 80vw);
    padding: 0.7rem 0.8rem;
    font-size: 0.8rem;
    font-weight: 400;
    line-height: 1.45;
    color: var(--text-secondary);
    box-shadow: 0 8px 24px var(--shadow);
    text-align: left;
    white-space: normal;
  }
  .pop.right {
    left: auto;
    right: -0.5rem;
  }
  .pop b {
    color: var(--text-primary);
    margin-bottom: 0.2rem;
  }
</style>
