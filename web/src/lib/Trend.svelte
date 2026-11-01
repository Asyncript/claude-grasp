<script lang="ts">
  import type { TrendPoint } from './api';

  let { points, green, yellow, daily = false }: { points: TrendPoint[]; green: number; yellow: number; daily?: boolean } = $props();

  let width = $state(600);
  const height = 200;
  const m = { top: 12, right: 12, bottom: 24, left: 32 };
  let hover = $state<number | null>(null);

  const iw = $derived(Math.max(10, width - m.left - m.right));
  const ih = height - m.top - m.bottom;
  const x = (i: number) => m.left + (points.length > 1 ? (i / (points.length - 1)) * iw : iw / 2);
  const y = (v: number) => m.top + ih - (v / 100) * ih;
  const path = $derived(points.map((p, i) => `${i ? 'L' : 'M'}${x(i)},${y(p.score)}`).join(''));
  const fmt = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

  function move(e: MouseEvent) {
    if (!points.length) return;
    const i = Math.round(((e.offsetX - m.left) / iw) * (points.length - 1));
    hover = Math.max(0, Math.min(points.length - 1, i));
  }
</script>

<div bind:clientWidth={width} class="wrap">
  {#if points.length < 2}
    <p class="muted text-sm">Not enough history for a trend yet.</p>
  {:else}
    <svg {width} {height} role="img" aria-label="Repo score over the last {points.length} {daily ? 'days' : 'weeks'}" onmousemove={move} onmouseleave={() => (hover = null)}>
      {#each [0, yellow, green, 100] as t (t)}
        <line x1={m.left} x2={m.left + iw} y1={y(t)} y2={y(t)} class="grid" />
        <text x={m.left - 6} y={y(t) + 4} text-anchor="end" class="tick">{t}</text>
      {/each}
      {#each points as p, i (p.at)}
        {#if i === 0 || i === points.length - 1 || i % (daily ? 7 : 4) === 0}
          <text x={x(i)} y={height - 6} text-anchor={i === points.length - 1 ? 'end' : 'middle'} class="tick">{fmt(p.at)}</text>
        {/if}
      {/each}
      <path d={path} class="line" />
      {#if hover !== null}
        {@const p = points[hover]!}
        <line x1={x(hover)} x2={x(hover)} y1={m.top} y2={m.top + ih} class="cross" />
        <circle cx={x(hover)} cy={y(p.score)} r="4" class="dot" />
      {/if}
    </svg>
    {#if hover !== null}
      {@const p = points[hover]!}
      <div class="tip card" style="left:{Math.min(x(hover) + 10, width - 190)}px">
        <div class="secondary">{daily ? fmt(p.at) : `Week ending ${fmt(p.at)}`}</div>
        <div><b>{p.score}</b> across {p.files} files</div>
        <div class="secondary">{p.green} familiar · {p.yellow} partial · {p.red} unfamiliar</div>
      </div>
    {/if}
  {/if}
</div>

<style>
  .wrap {
    position: relative;
  }
  svg {
    display: block;
  }
  .grid {
    stroke: var(--grid);
  }
  .tick {
    fill: var(--text-muted);
    font-size: 11px;
  }
  .line {
    fill: none;
    stroke: var(--accent);
    stroke-width: 2;
  }
  .cross {
    stroke: var(--axis);
  }
  .dot {
    fill: var(--accent);
    stroke: var(--surface-1);
    stroke-width: 2;
  }
  .tip {
    position: absolute;
    top: 8px;
    pointer-events: none;
    padding: 0.4rem 0.6rem;
    font-size: 0.8rem;
    width: 180px;
  }
</style>
