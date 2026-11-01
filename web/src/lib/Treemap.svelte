<script lang="ts">
  import { hierarchy, treemap, treemapSquarify } from 'd3-hierarchy';
  import { BUCKET_LABEL, pct, type FileRow } from './api';

  let { files, selected, onselect }: { files: FileRow[]; selected: string | null; onselect: (path: string) => void } = $props();

  let width = $state(800);
  const height = 420;
  let hover = $state<{ f: FileRow; x: number; y: number } | null>(null);

  // Area is lines changed: the bigger the block, the more AI-written code it holds.
  const tiles = $derived.by(() => {
    if (!files.length || width < 10) return [];
    const root = hierarchy<{ children?: FileRow[] } | FileRow>({ children: files }, (d) => ('children' in d ? d.children : undefined))
      .sum((d) => ('lines' in d ? Math.max(1, d.lines) : 0))
      .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
    treemap<{ children?: FileRow[] } | FileRow>().tile(treemapSquarify).size([width, height]).paddingInner(2).round(true)(root);
    return root.leaves().map((l) => {
      const n = l as typeof l & { x0: number; x1: number; y0: number; y1: number };
      return { f: l.data as FileRow, x: n.x0, y: n.y0, w: n.x1 - n.x0, h: n.y1 - n.y0 };
    });
  });

  const base = (p: string) => p.split('/').pop() ?? p;
</script>

<div class="wrap" bind:clientWidth={width} role="presentation" onmouseleave={() => (hover = null)}>
  <svg {width} {height} role="img" aria-label="Files sized by lines changed, colored by comprehension score">
    {#each tiles as t (t.f.path)}
      <g
        transform="translate({t.x},{t.y})"
        role="button"
        tabindex="0"
        aria-label="{t.f.path}: {t.f.score}, {BUCKET_LABEL[t.f.bucket]}"
        onclick={() => onselect(t.f.path)}
        onkeydown={(e) => (e.key === 'Enter' || e.key === ' ') && onselect(t.f.path)}
        onmousemove={(e) => (hover = { f: t.f, x: e.offsetX, y: e.offsetY })}
      >
        <rect width={t.w} height={t.h} rx="3" class="tile {t.f.bucket}" class:sel={selected === t.f.path} />
        {#if t.w > 56 && t.h > 30}
          <text x="6" y="16" class="label {t.f.bucket}">{base(t.f.path).slice(0, Math.floor(t.w / 7))}</text>
          <text x="6" y="31" class="value {t.f.bucket}">{t.f.score}</text>
        {/if}
      </g>
    {/each}
  </svg>
  {#if hover}
    <div class="tip card" style="left:{Math.min(hover.x + 12, width - 260)}px; top:{hover.y + 12}px">
      <div class="mono path">{hover.f.path}</div>
      <div><b>{hover.f.score}</b> · {BUCKET_LABEL[hover.f.bucket]}</div>
      <div class="secondary">{hover.f.lines} lines · {hover.f.edits} edits{hover.f.unattendedShare ? ` · ${pct(hover.f.unattendedShare)} unattended` : ''}</div>
      {#if hover.f.neverUnderstood}<div class="crit">Never looked at</div>{/if}
    </div>
  {/if}
</div>

<style>
  .wrap {
    position: relative;
  }
  svg {
    display: block;
  }
  g {
    cursor: pointer;
    outline: none;
  }
  .tile.green {
    fill: var(--familiar);
  }
  .tile.yellow {
    fill: var(--partial);
  }
  .tile.red {
    fill: var(--unfamiliar);
    stroke: var(--axis);
    stroke-width: 1;
  }
  .tile:hover,
  g:focus-visible .tile {
    opacity: 0.85;
  }
  .tile.sel {
    stroke: var(--text-primary);
    stroke-width: 3;
  }
  text {
    font-size: 12px;
    pointer-events: none;
  }
  .value {
    font-weight: 600;
  }
  .green {
    fill: var(--on-familiar);
  }
  .yellow {
    fill: var(--on-partial);
  }
  .red {
    fill: var(--on-unfamiliar);
  }
  .tip {
    position: absolute;
    pointer-events: none;
    padding: 0.5rem 0.65rem;
    font-size: 0.8rem;
    width: 250px;
    box-shadow: 0 4px 16px var(--shadow);
  }
  .path {
    word-break: break-all;
    font-size: 0.75rem;
  }
  .crit {
    color: var(--critical-text);
  }
</style>
