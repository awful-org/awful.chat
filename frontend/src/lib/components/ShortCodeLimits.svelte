<script lang="ts" module>
  // The last limits chosen, kept for the page: picking 10 people / 10 min,
  // then going back or letting the code run out, should not mean entering
  // them again.
  let lastPeople = 1;
  let lastMinutes = 5;
</script>

<script lang="ts">
  /**
   * The limits a short code is made with: how many people may join with it
   * and how long it lives. One panel for the invite dialog and the "Room
   * created" card, so the two cannot drift. The relay holds the code to the
   * same limits whatever this asks (relay/pairing.go).
   */
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { PAIRING_MAX_USES, pairingLimits } from "$lib/room-security/invitation-pairing";

  interface Props {
    busy?: boolean;
    onSubmit: (limits: { uses: number; ttlMs: number }) => void;
    onBack: () => void;
  }
  let { busy = false, onSubmit, onBack }: Props = $props();

  let people = $state<number | null>(lastPeople);
  let minutes = $state(lastMinutes);
  const PEOPLE_PICKS = [1, 5, 10, 20];
  const MINUTE_PICKS = [1, 5, 10];
  const peopleId = $props.id();

  /** The typed number, whole and within 1..25 (an empty field is one person). */
  function peopleCount(): number {
    return pairingLimits({ uses: people ?? 1 }).uses;
  }

  function submit(): void {
    people = lastPeople = peopleCount();
    lastMinutes = minutes;
    onSubmit({ uses: people, ttlMs: minutes * 60_000 });
  }
</script>

<div class="space-y-3 rounded-lg border border-border p-3 font-mono">
  <div class="space-y-1.5">
    <label for={peopleId} class="block text-xs text-foreground">People who can join</label>
    <Input
      id={peopleId}
      type="number"
      inputmode="numeric"
      min="1"
      max={PAIRING_MAX_USES}
      step="1"
      bind:value={people}
      onblur={() => (people = peopleCount())}
      class="h-8 font-mono"
    />
    <div class="flex gap-1">
      {#each PEOPLE_PICKS as n (n)}
        <button
          type="button"
          aria-pressed={people === n}
          onclick={() => (people = n)}
          class="flex-1 cursor-pointer rounded-md border px-2 py-1 text-xs transition-colors {people === n
            ? 'border-primary bg-primary/15 text-primary'
            : 'border-border text-muted-foreground hover:text-foreground'}">{n}</button
        >
      {/each}
    </div>
  </div>
  <div class="space-y-1.5">
    <span class="block text-xs text-foreground">Valid for</span>
    <div class="flex gap-1" role="group" aria-label="Valid for">
      {#each MINUTE_PICKS as m (m)}
        <button
          type="button"
          aria-pressed={minutes === m}
          onclick={() => (minutes = m)}
          class="flex-1 cursor-pointer rounded-md border px-2 py-1 text-xs transition-colors {minutes === m
            ? 'border-primary bg-primary/15 text-primary'
            : 'border-border text-muted-foreground hover:text-foreground'}">{m} min</button
        >
      {/each}
    </div>
  </div>
  <div class="flex gap-2">
    <Button variant="ghost" size="sm" class="font-mono text-xs cursor-pointer" onclick={onBack}>Back</Button>
    <Button size="sm" class="flex-1 font-mono text-xs cursor-pointer" disabled={busy} onclick={submit}>
      {busy ? "Getting a code..." : "Get code"}
    </Button>
  </div>
</div>
