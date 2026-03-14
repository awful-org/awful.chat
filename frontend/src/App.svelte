<script lang="ts">
	import {
		connect,
		disconnect,
		send,
		seedFile,
		peers,
		messages,
		transfers,
		myId,
	} from "$lib/peers.svelte";
	import { Button } from "$lib/components/ui/button";
	import { Input } from "$lib/components/ui/input";
	import { Badge } from "$lib/components/ui/badge";
	import { Separator } from "$lib/components/ui/separator";
	import { File } from "@lucide/svelte";
	import { identityStore, init, lock } from "$lib/identity.svelte";
	import IdentitySetup from "$lib/components/IdentitySetup.svelte";
	import UnlockIdentity from "$lib/components/UnlockIdentity.svelte";

	// initialise identity on mount — reads keypair from IndexedDB (no password needed)
	$effect(() => {
		init();
	});

	let roomId = $state("test-room");
	let input = $state("");
	let joined = $state(false);
	let messagesEl = $state<HTMLDivElement | null>(null);

	const connectedCount = $derived(peers.length);

	function join() {
		connect(roomId);
		joined = true;
	}
	function leave() {
		disconnect();
		joined = false;
	}

	function onKeydown(e: KeyboardEvent) {
		if (e.key === "Enter" && input.trim()) {
			send(input.trim());
			input = "";
		}
	}

	function onFileChange(e: Event) {
		const file = (e.target as HTMLInputElement).files?.[0];
		if (file) seedFile(file);
		(e.target as HTMLInputElement).value = "";
	}

	$effect(() => {
		messages.length;
		setTimeout(() => {
			if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight;
		}, 0);
	});

	function formatTime(ts: number) {
		return new Date(ts).toLocaleTimeString([], {
			hour: "2-digit",
			minute: "2-digit",
		});
	}

	function formatBytes(b: number) {
		if (b < 1024) return `${b} B`;
		if (b < 1024 ** 2) return `${(b / 1024).toFixed(1)} KB`;
		return `${(b / 1024 ** 2).toFixed(1)} MB`;
	}

	function transferProgress(t: { received: number; fileSize: number }) {
		if (t.fileSize === 0) return 0;
		return Math.min(1, t.received / t.fileSize);
	}
</script>

<!-- identity loading splash -->
{#if identityStore.loading && !identityStore.keypair}
	<div class="min-h-screen bg-zinc-950 flex items-center justify-center">
		<div class="w-2 h-2 rounded-full bg-zinc-600 animate-pulse"></div>
	</div>

<!-- no identity yet → setup wizard -->
{:else if !identityStore.keypair}
	<IdentitySetup />

<!-- identity exists but locked → unlock screen -->
{:else if !identityStore.isUnlocked}
	<UnlockIdentity />

<!-- unlocked → main chat UI -->
{:else}
<div
	class="min-h-screen bg-zinc-950 text-zinc-100 flex items-center justify-center p-4 font-mono"
>
	<div class="w-full max-w-2xl flex flex-col gap-4">
		<!-- header -->
		<div class="flex items-center justify-between">
			<div class="flex items-center gap-3">
				<div
					class="w-2 h-2 rounded-full {joined
						? 'bg-emerald-400 shadow-[0_0_6px_#34d399]'
						: 'bg-zinc-600'}"
				></div>
				<span class="text-xs text-zinc-400 tracking-widest uppercase"
					>mesh chat</span
				>
			</div>
			<div class="flex items-center gap-3">
				<span class="text-xs text-zinc-600"
					>id: <span class="text-zinc-400">{myId}</span></span
				>
				<Button
					onclick={lock}
					variant="ghost"
					size="sm"
					class="text-zinc-600 hover:text-zinc-400 hover:bg-zinc-900 font-mono text-xs h-6 px-2"
				>
					lock
				</Button>
			</div>
		</div>

		<Separator class="bg-zinc-800" />

		{#if !joined}
			<div class="flex flex-col gap-6 py-12 items-center">
				<div class="text-center">
					<p class="text-zinc-300 text-sm mb-1">enter a room to connect</p>
					<p class="text-zinc-600 text-xs">
						peers in the same room connect directly
					</p>
				</div>
				<div class="flex gap-2 w-full max-w-sm">
					<Input
						bind:value={roomId}
						placeholder="room id"
						class="bg-zinc-900 border-zinc-700 text-zinc-100 placeholder:text-zinc-600 font-mono focus-visible:ring-emerald-500"
					/>
					<Button
						onclick={join}
						class="bg-emerald-600 hover:bg-emerald-500 text-white font-mono"
					>
						join
					</Button>
				</div>
			</div>
		{:else}
			<div class="flex flex-col gap-3">
				<!-- peers bar -->
				<div class="flex items-center gap-2 flex-wrap">
					<span class="text-xs text-zinc-500 uppercase tracking-widest"
						>peers</span
					>
					{#each peers as peer}
						<Badge
							variant="outline"
							class="font-mono text-xs border-zinc-700 gap-1.5 {peer.connected
								? 'text-emerald-400 border-emerald-800'
								: 'text-zinc-500'}"
						>
							<span
								class="w-1.5 h-1.5 rounded-full {peer.connected
									? 'bg-emerald-400'
									: 'bg-zinc-600'}"
							></span>
							{peer.id}
						</Badge>
					{:else}
						<span class="text-xs text-zinc-600 italic"
							>waiting for peers...</span
						>
					{/each}
					<div class="ml-auto">
						<Button
							onclick={leave}
							variant="ghost"
							size="sm"
							class="text-zinc-500 hover:text-red-400 hover:bg-red-950 font-mono text-xs"
						>
							leave
						</Button>
					</div>
				</div>

				<Separator class="bg-zinc-800" />

				<!-- messages -->
				<div
					bind:this={messagesEl}
					class="h-72 overflow-y-auto flex flex-col gap-1 pr-1"
				>
					{#if messages.length === 0}
						<div class="flex-1 flex items-center justify-center h-full">
							<p class="text-zinc-700 text-xs italic">no messages yet</p>
						</div>
					{:else}
						{#each messages as msg}
							<div
								class="flex gap-3 items-baseline px-2 py-1 rounded {msg.from ===
								myId
									? 'bg-zinc-900'
									: ''}"
							>
								<span
									class="text-xs shrink-0 w-16 truncate {msg.from === myId
										? 'text-emerald-500'
										: 'text-sky-500'}"
								>
									{msg.from === myId ? "you" : msg.from}
								</span>

								{#if msg.kind === "file"}
									<span
										class="text-sm flex-1 flex items-center gap-2 text-zinc-400"
									>
										<span>📎</span>
										<span class="text-zinc-300">{msg.fileName}</span>
										{#if msg.fileSize}
											<span class="text-zinc-600 text-xs"
												>{formatBytes(msg.fileSize)}</span
											>
										{/if}
									</span>
								{:else}
									<span class="text-zinc-200 text-sm flex-1 break-all"
										>{msg.text}</span
									>
								{/if}

								<span class="text-zinc-700 text-xs shrink-0"
									>{formatTime(msg.ts)}</span
								>
							</div>
						{/each}
					{/if}
				</div>

				<!-- transfers -->
				{#if transfers.length > 0}
					<Separator class="bg-zinc-800" />
					<div class="flex flex-col gap-1">
						<span class="text-xs text-zinc-500 uppercase tracking-widest"
							>transfers</span
						>
						{#each transfers as t}
							<div
								class="flex items-center gap-3 px-2 py-1.5 rounded bg-zinc-900 text-xs"
							>
								<span class="text-zinc-500">{t.seeding ? "↑" : "↓"}</span>
								<span class="text-zinc-300 flex-1 truncate">{t.fileName}</span>
								<span class="text-zinc-600">{formatBytes(t.fileSize)}</span>

								{#if t.done && t.blobURL}
									<a
										href={t.blobURL}
										download={t.fileName}
										class="text-emerald-400 hover:text-emerald-300 underline"
									>
										save
									</a>
								{:else if t.done && t.seeding}
									<span class="text-zinc-500">sent</span>
								{:else}
									<div
										class="w-16 h-1 bg-zinc-700 rounded-full overflow-hidden"
									>
										<div
											class="h-full bg-emerald-500 rounded-full transition-all"
											style="width: {(transferProgress(t) * 100).toFixed(1)}%"
										></div>
									</div>
									<span class="text-zinc-600 w-8 text-right">
										{(transferProgress(t) * 100).toFixed(0)}%
									</span>
								{/if}
							</div>
						{/each}
					</div>
				{/if}

				<Separator class="bg-zinc-800" />

				<!-- input row -->
				<div class="flex gap-2">
					<Input
						bind:value={input}
						onkeydown={onKeydown}
						placeholder="type and press enter..."
						disabled={connectedCount === 0}
						class="bg-zinc-900 border-zinc-700 text-zinc-100 placeholder:text-zinc-600 font-mono focus-visible:ring-emerald-500 disabled:opacity-30"
					/>
					<Button
						onclick={() => {
							if (input.trim()) {
								send(input.trim());
								input = "";
							}
						}}
						disabled={connectedCount === 0 || !input.trim()}
						class="bg-emerald-600 hover:bg-emerald-500 text-white font-mono disabled:opacity-30"
					>
						send
					</Button>

					<label class="cursor-pointer">
						<input
							type="file"
							class="hidden"
							disabled={connectedCount === 0}
							onchange={onFileChange}
						/>
						<div
							class="h-9 px-3 flex items-center justify-center rounded-md border border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:border-zinc-500 transition-colors {connectedCount ===
							0
								? 'opacity-30 pointer-events-none'
								: ''}"
						>
							<File />
						</div>
					</label>
				</div>

				<p class="text-xs text-zinc-700 text-center">
					room: <span class="text-zinc-500">{roomId}</span>
					· {connectedCount} connected
				</p>
			</div>
		{/if}
	</div>
</div>
{/if}
