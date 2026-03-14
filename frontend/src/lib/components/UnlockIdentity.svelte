<script lang="ts">
	import { unlock, identityStore } from "$lib/identity.svelte";
	import { Button } from "$lib/components/ui/button";
	import { Input } from "$lib/components/ui/input";
	import {
		Card,
		CardContent,
		CardDescription,
		CardFooter,
		CardHeader,
		CardTitle,
	} from "$lib/components/ui/card";

	let password = $state("");

	const canUnlock = $derived(password.length > 0 && !identityStore.loading);

	async function handleUnlock() {
		try {
			await unlock(password);
			// identityStore.isUnlocked flips → App.svelte switches to main UI
		} catch {
			password = "";
		}
	}

	function onKeydown(e: KeyboardEvent) {
		if (e.key === "Enter" && canUnlock) handleUnlock();
	}
</script>

<div class="min-h-screen bg-zinc-950 text-zinc-100 flex items-center justify-center p-4 font-mono">
	<Card class="w-full max-w-sm bg-zinc-900 border-zinc-800 text-zinc-100">
		<CardHeader class="pb-4">
			<div class="flex items-center gap-2 mb-1">
				<div class="w-2 h-2 rounded-full bg-zinc-600"></div>
				<span class="text-xs text-zinc-500 tracking-widest uppercase">mesh chat</span>
			</div>
			<CardTitle class="text-lg font-mono font-semibold text-zinc-100">
				welcome back
			</CardTitle>
			<CardDescription class="text-zinc-500 text-xs font-mono">
				enter your password to unlock your identity
				{#if identityStore.keypair?.did}
					<span class="block mt-1 text-zinc-600 truncate">
						{identityStore.keypair.did.slice(0, 24)}…
					</span>
				{/if}
			</CardDescription>
		</CardHeader>
		<CardContent class="flex flex-col gap-3">
			<Input
				type="password"
				bind:value={password}
				onkeydown={onKeydown}
				placeholder="password"
				autofocus
				class="bg-zinc-950 border-zinc-700 text-zinc-100 placeholder:text-zinc-600 font-mono focus-visible:ring-emerald-500
					{identityStore.error ? 'border-red-700 focus-visible:ring-red-500' : ''}"
			/>
			{#if identityStore.error}
				<p class="text-xs text-red-500 font-mono">{identityStore.error}</p>
			{/if}
		</CardContent>
		<CardFooter>
			<Button
				onclick={handleUnlock}
				disabled={!canUnlock}
				class="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-mono disabled:opacity-40"
			>
				{identityStore.loading ? "unlocking..." : "unlock"}
			</Button>
		</CardFooter>
	</Card>
</div>
