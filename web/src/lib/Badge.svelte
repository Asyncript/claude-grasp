<script lang="ts">
  import { BUCKET_LABEL, type Bucket } from './api';

  let { bucket, score }: { bucket: Bucket; score?: number } = $props();
</script>

<!-- Color always comes with the score and a word, never alone. -->
<span class="badge {bucket}">
  {#if score !== undefined}<b>{score}</b>{/if}
  {BUCKET_LABEL[bucket]}
</span>

<style>
  .badge {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.05rem 0.5rem;
    border-radius: 999px;
    font-size: 0.75rem;
    white-space: nowrap;
  }
  .green {
    background: var(--familiar);
    color: var(--on-familiar);
  }
  .yellow {
    background: var(--partial);
    color: var(--on-partial);
  }
  .red {
    background: var(--unfamiliar);
    color: var(--on-unfamiliar);
  }
</style>
