<script lang="ts">
  import { Button } from "$lib/components/ui/button";
  import type { Message } from "$lib/transport/transport.svelte";
  import type { HostApi } from "$lib/plugins/api";

  interface Props {
    card: Message;
    cardState: unknown;
    host: HostApi;
  }

  let { card, cardState, host }: Props = $props();

  // $derived, never a plain const: a const captures the prop ONCE at mount,
  // so every vote folded after that - yours included - rendered nowhere
  // until a refresh remounted the card.
  const pollState = $derived(
    cardState as {
      question: string;
      options: string[];
      votes: Map<string, { did: string; name: string; vote: number }>;
    }
  );

  let voting = $state(false);

  async function handleVote(optionIndex: number) {
    if (voting) return;
    voting = true;

    try {
      await host.sendUpdate(card.id, { action: "vote", vote: optionIndex });
    } catch (err) {
      console.error("[poll] failed to vote:", err);
    } finally {
      voting = false;
    }
  }

  // Calculate vote counts
  const voteCounts = $derived.by(() => {
    const counts = new Array(pollState.options.length).fill(0);
    for (const { vote } of pollState.votes.values()) {
      counts[vote]++;
    }
    return counts;
  });

  const totalVotes = $derived(pollState.votes.size);
  /** The option I voted for, or null. */
  const myVote = $derived(pollState.votes.get(host.selfDid())?.vote ?? null);
</script>

<!-- w-full: the host frame sets the default card size; the poll fills it. -->
<div class="flex w-full flex-col gap-4">
  <div class="font-mono font-semibold text-sm">{pollState.question}</div>

  {#if pollState.options.length === 0}
    <div class="text-xs text-muted-foreground">No options configured</div>
  {:else}
    <div class="flex flex-col gap-3">
      {#each pollState.options as option, i (i)}
        {@const voteCount = voteCounts[i]}
        {@const percentage = totalVotes > 0 ? (voteCount / totalVotes) * 100 : 0}

        {@const mine = myVote === i}
        <div class="flex flex-col gap-1">
          <div class="flex items-center justify-between text-xs">
            <span class="font-mono {mine ? 'text-primary font-semibold' : ''}">
              {option}{#if mine}
                <span class="ml-1" aria-label="Your vote">✓</span>
              {/if}
            </span>
            <span class="text-muted-foreground">
              {voteCount} {voteCount === 1 ? "vote" : "votes"}
            </span>
          </div>
          <Button
            variant="outline"
            class="h-10 relative overflow-hidden {mine
              ? 'ring-1 ring-primary border-primary/60'
              : ''}"
            onclick={() => handleVote(i)}
            disabled={voting || mine}
          >
            <div
              class="absolute inset-0 bg-primary/20 transition-all"
              style="width: {percentage}%"></div>
            <div class="relative z-10 w-full text-left text-xs">
              {#if percentage > 0}
                {Math.round(percentage)}%
              {:else}
                Vote
              {/if}
            </div>
          </Button>
        </div>
      {/each}
    </div>

    {#if totalVotes > 0}
      <div class="text-xs text-muted-foreground space-y-1 mt-4 pt-4 border-t border-border/50">
        <div class="font-mono font-semibold mb-2">Voters:</div>
        <div class="space-y-1">
          {#each Array.from(pollState.votes.values()) as voter (voter.did)}
            <div class="flex items-center justify-between">
              <span class="truncate text-xs">{voter.name}</span>
              <span class="text-xs text-muted-foreground"
                >{pollState.options[voter.vote]}</span
              >
            </div>
          {/each}
        </div>
      </div>
    {/if}
  {/if}
</div>
