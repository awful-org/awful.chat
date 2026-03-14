<script lang="ts">
	import { restore, identityStore } from "$lib/identity.svelte";
	import { createIdentity } from "$lib/identity";
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
	import type { KeypairRecord } from "$lib/identity";

	type Step = "entry" | "create-password" | "mnemonic" | "restore";

	let step = $state<Step>("entry");

	let password = $state("");
	let passwordConfirm = $state("");
	let mnemonic = $state<string | null>(null);
	let pendingKeypair = $state<KeypairRecord | null>(null);
	let mnemonicConfirmed = $state(false);
	let loading = $state(false);
	let error = $state<string | null>(null);

	let restoreMnemonic = $state("");
	let restorePassword = $state("");
	let restorePasswordConfirm = $state("");

	const passwordMismatch = $derived(
		passwordConfirm.length > 0 && password !== passwordConfirm,
	);
	const canCreate = $derived(
		password.length >= 8 && password === passwordConfirm && !loading,
	);

	const restorePasswordMismatch = $derived(
		restorePasswordConfirm.length > 0 && restorePassword !== restorePasswordConfirm,
	);
	const canRestore = $derived(
		restoreMnemonic.trim().split(/\s+/).length === 12 &&
			restorePassword.length >= 8 &&
			restorePassword === restorePasswordConfirm &&
			!identityStore.loading,
	);

	const mnemonicWords = $derived(mnemonic ? mnemonic.split(" ") : []);

	// Create the identity and store the mnemonic locally — do NOT unlock the
	// store yet so App.svelte doesn't navigate away before the user writes down
	// their words. We unlock only when they click "I'm ready".
	async function handleCreate() {
		loading = true;
		error = null;
		try {
			const result = await createIdentity(password);
			mnemonic = result.mnemonic;
			pendingKeypair = result.keypair;
			step = "mnemonic";
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		} finally {
			loading = false;
		}
	}

	// Called after the user confirms they've saved their words.
	// Now we can update the store so App.svelte transitions to the chat UI.
	function handleConfirmed() {
		if (!pendingKeypair || !mnemonicConfirmed) return;
		identityStore.isUnlocked = true;
		identityStore.did = pendingKeypair.did;
		identityStore.publicKey = pendingKeypair.publicKey;
		identityStore.keypair = pendingKeypair;
		identityStore.error = null;
		mnemonic = null;
	}

	async function handleRestore() {
		await restore(restoreMnemonic.trim(), restorePassword);
	}

	function copyMnemonic() {
		if (mnemonic) navigator.clipboard.writeText(mnemonic);
	}
</script>

<div class="min-h-screen bg-zinc-950 text-zinc-100 flex items-center justify-center p-4 font-mono">
	{#if step === "entry"}
		<Card class="w-full max-w-sm bg-zinc-900 border-zinc-800 text-zinc-100">
			<CardHeader class="pb-4">
				<div class="flex items-center gap-2 mb-1">
					<div class="w-2 h-2 rounded-full bg-zinc-600"></div>
					<span class="text-xs text-zinc-500 tracking-widest uppercase">mesh chat</span>
				</div>
				<CardTitle class="text-lg font-mono font-semibold text-zinc-100">
					no identity found
				</CardTitle>
				<CardDescription class="text-zinc-500 text-xs font-mono">
					create a new identity or restore from a recovery phrase
				</CardDescription>
			</CardHeader>
			<CardFooter class="flex flex-col gap-2 pt-0">
				<Button
					onclick={() => (step = "create-password")}
					class="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-mono"
				>
					create new identity
				</Button>
				<Button
					onclick={() => (step = "restore")}
					variant="outline"
					class="w-full border-zinc-700 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 hover:border-zinc-600 font-mono"
				>
					restore from phrase
				</Button>
			</CardFooter>
		</Card>

	{:else if step === "create-password"}
		<Card class="w-full max-w-sm bg-zinc-900 border-zinc-800 text-zinc-100">
			<CardHeader class="pb-4">
				<button
					onclick={() => { step = "entry"; password = ""; passwordConfirm = ""; }}
					class="text-xs text-zinc-600 hover:text-zinc-400 font-mono mb-2 text-left transition-colors"
				>
					← back
				</button>
				<CardTitle class="text-lg font-mono font-semibold text-zinc-100">
					choose a password
				</CardTitle>
				<CardDescription class="text-zinc-500 text-xs font-mono">
					encrypts your recovery phrase on this device · min 8 characters
				</CardDescription>
			</CardHeader>
			<CardContent class="flex flex-col gap-3">
				<Input
					type="password"
					bind:value={password}
					placeholder="password"
					class="bg-zinc-950 border-zinc-700 text-zinc-100 placeholder:text-zinc-600 font-mono focus-visible:ring-emerald-500"
				/>
				<div class="flex flex-col gap-1">
					<Input
						type="password"
						bind:value={passwordConfirm}
						placeholder="confirm password"
						class="bg-zinc-950 border-zinc-700 text-zinc-100 placeholder:text-zinc-600 font-mono focus-visible:ring-emerald-500
							{passwordMismatch ? 'border-red-700 focus-visible:ring-red-500' : ''}"
					/>
					{#if passwordMismatch}
						<p class="text-xs text-red-500 font-mono">passwords do not match</p>
					{/if}
				</div>
				{#if error}
					<p class="text-xs text-red-500 font-mono">{error}</p>
				{/if}
			</CardContent>
			<CardFooter>
				<Button
					onclick={handleCreate}
					disabled={!canCreate}
					class="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-mono disabled:opacity-40"
				>
					{loading ? "creating..." : "create identity"}
				</Button>
			</CardFooter>
		</Card>

	{:else if step === "mnemonic"}
		<Card class="w-full max-w-md bg-zinc-900 border-zinc-800 text-zinc-100">
			<CardHeader class="pb-4">
				<CardTitle class="text-lg font-mono font-semibold text-zinc-100">
					write down your recovery phrase
				</CardTitle>
				<CardDescription class="text-zinc-500 text-xs font-mono">
					these 12 words are the only way to recover your identity · store them somewhere safe · they will not be shown again
				</CardDescription>
			</CardHeader>
			<CardContent class="flex flex-col gap-4">
				<!-- word grid -->
				<div class="grid grid-cols-3 gap-2">
					{#each mnemonicWords as word, i}
						<div class="flex items-center gap-1.5 bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5">
							<span class="text-zinc-600 text-xs w-4 text-right shrink-0">{i + 1}</span>
							<span class="text-zinc-100 text-sm font-mono">{word}</span>
						</div>
					{/each}
				</div>

				<Button
					onclick={copyMnemonic}
					variant="outline"
					size="sm"
					class="border-zinc-700 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 hover:border-zinc-600 font-mono text-xs"
				>
					copy to clipboard
				</Button>

				<!-- confirmation checkbox -->
				<label class="flex items-start gap-2.5 cursor-pointer group">
					<input
						type="checkbox"
						bind:checked={mnemonicConfirmed}
						class="mt-0.5 w-4 h-4 rounded border-zinc-700 bg-zinc-950 accent-emerald-500 cursor-pointer"
					/>
					<span class="text-xs text-zinc-400 group-hover:text-zinc-300 transition-colors font-mono leading-relaxed">
						i have written down my recovery phrase and stored it safely
					</span>
				</label>
			</CardContent>
			<CardFooter>
				<Button
					onclick={handleConfirmed}
					disabled={!mnemonicConfirmed}
					class="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-mono disabled:opacity-40"
				>
					i'm ready
				</Button>
			</CardFooter>
		</Card>

	{:else if step === "restore"}
		<Card class="w-full max-w-sm bg-zinc-900 border-zinc-800 text-zinc-100">
			<CardHeader class="pb-4">
				<button
					onclick={() => { step = "entry"; restoreMnemonic = ""; restorePassword = ""; restorePasswordConfirm = ""; }}
					class="text-xs text-zinc-600 hover:text-zinc-400 font-mono mb-2 text-left transition-colors"
				>
					← back
				</button>
				<CardTitle class="text-lg font-mono font-semibold text-zinc-100">
					restore identity
				</CardTitle>
				<CardDescription class="text-zinc-500 text-xs font-mono">
					enter your 12-word recovery phrase and choose a new password
				</CardDescription>
			</CardHeader>
			<CardContent class="flex flex-col gap-3">
				<textarea
					bind:value={restoreMnemonic}
					placeholder="word1 word2 word3 ..."
					rows={3}
					class="w-full bg-zinc-950 border border-zinc-700 rounded-md px-3 py-2 text-zinc-100 placeholder:text-zinc-600 font-mono text-sm resize-none focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent"
				></textarea>
				<Input
					type="password"
					bind:value={restorePassword}
					placeholder="new password"
					class="bg-zinc-950 border-zinc-700 text-zinc-100 placeholder:text-zinc-600 font-mono focus-visible:ring-emerald-500"
				/>
				<div class="flex flex-col gap-1">
					<Input
						type="password"
						bind:value={restorePasswordConfirm}
						placeholder="confirm password"
						class="bg-zinc-950 border-zinc-700 text-zinc-100 placeholder:text-zinc-600 font-mono focus-visible:ring-emerald-500
							{restorePasswordMismatch ? 'border-red-700 focus-visible:ring-red-500' : ''}"
					/>
					{#if restorePasswordMismatch}
						<p class="text-xs text-red-500 font-mono">passwords do not match</p>
					{/if}
				</div>
				{#if identityStore.error}
					<p class="text-xs text-red-500 font-mono">{identityStore.error}</p>
				{/if}
			</CardContent>
			<CardFooter>
				<Button
					onclick={handleRestore}
					disabled={!canRestore}
					class="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-mono disabled:opacity-40"
				>
					{identityStore.loading ? "restoring..." : "restore identity"}
				</Button>
			</CardFooter>
		</Card>
	{/if}
</div>
