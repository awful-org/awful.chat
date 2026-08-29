# Plugin Card Loading
> Runtime mirror is distinct from plugin-card payload parsing

Entry: `frontend/src/lib/components/MsgRender.svelte` (L113-158)

External source: `../awfully-awesome/plugins/<id>/`
Runtime mirror: `frontend/plugins/<id>/` — intentionally untracked; `frontend/scripts/fetch-plugins.mjs` owns production fetches.

Registry: `frontend/src/lib/plugins/registry.ts` — eager manifest glob, lazy `index.ts` glob.

Gotcha: `MsgRender.svelte` parses `message.content` before `getPlugin()`. Empty or malformed historical card content reports `Failed to load plugin card: JSON.parse...` even when the runtime mirror is valid.

Updated: 2026-08-28
