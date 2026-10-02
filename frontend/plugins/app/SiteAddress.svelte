<script lang="ts">
  /**
   * An app's address, drawn so the part that names the site is the part that
   * stays. A host is read from the right - attacker.net in
   * awful.chat.<padding>.attacker.net - so when it does not fit, it loses its
   * START, never its end: "…padding.attacker.net", where a plain ellipsis
   * showed "awful.chat.…" and passed for this instance. The box is laid out
   * right to left to put the ellipsis there; the name inside is an LTR
   * isolate, so its dots stay where they are.
   *
   * With `path`, the rest of the URL follows, and it is what gives way first:
   * a long query string cannot squeeze the host out either.
   */
  let {
    url,
    path = false,
    class: className = "",
  }: { url: string; path?: boolean; class?: string } = $props();

  const parsed = $derived.by(() => {
    try {
      return new URL(url);
    } catch {
      return null;
    }
  });
  const host = $derived(parsed?.host ?? "");
  const rest = $derived(parsed ? `${parsed.pathname}${parsed.search}${parsed.hash}` : "");
</script>

<span class={["flex min-w-0", className]} title={url}>
  <span dir="rtl" class="min-w-0 truncate"><bdi dir="ltr">{host}</bdi></span>
  {#if path && rest}
    <span class="min-w-0 truncate" style="flex-shrink: 1000">{rest}</span>
  {/if}
</span>
