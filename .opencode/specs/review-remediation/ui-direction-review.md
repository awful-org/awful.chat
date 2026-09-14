# Frontend UI-direction audit — Astra

## Implementation update — 2026-09-14

U1–U6 implemented after user approval: settings surface tracks the visual viewport
with independently scrollable content/navigation; floating panels use viewport
gutters and matching drag widths; call actions wrap into touch-sized rows;
settings controls have accessible names and selected states, including slider
thumbs; hover contrast, camera pending feedback, destructive leave treatment,
and landing secondary-copy contrast corrected. U7 (reduced motion) explicitly
excluded by the user. Original evidence below is retained as audit history.

Frontend check and tests pass. A desktop browser is still not connected, so live
rendering/keyboard checks are not claimed.

Read-only review, 2026-09-11. **The existing direction is coherent; the priority is making shared surfaces behave consistently, especially settings and floating panels.** No broad redesign is warranted.

## Direction and evidence

- `README.md:7–20,53–64,72–83`: private, local-first, recoverable identity; honest disclosure of transport limitations; installable mobile app.
- `frontend/README.md:1–24`, `docs/spec.md` (including the PWA section), and `docs/call-pip.md:92–109,157–158`: existing component structure, compact floating call surface and mobile sizing intentions. The call-PiP document includes historical/planned behavior, so differences from it alone are not treated as bugs.
- `frontend/src/app.css:6–96`: near-black dark background, neutral elevated surfaces, bright green primary/accent with **dark** foreground, modest radii. `frontend/index.html:2` selects dark mode. Shared Button/Input/Dialog/Drawer/Switch/Slider/Tip sources establish focus, state and spacing patterns.
- Examined `frontend/public/screenshot-wide.png` and `screenshot-narrow.png`: compact mono-led chrome, restrained borders, green selection, readable message hierarchy, sidebar replaced by a mobile menu. These are repository assets of unknown capture date, **not current runtime validation**.
- Representative sources: Landing, IdentitySetup, UnlockIdentity, RoomCreateJoin, AppView, ChatView, FloatingDmPanel, VoiceVideoCallView, CallPipPanel, SettingsDialog, App/Audio settings, TransportStatus and AppNotices.

**Limits:** no connected browser, live rendering, keyboard/screen-reader run or device test. Findings below are source-demonstrable conflicts; runtime consequences are predictions where stated. Line numbers describe the files when read; the implementation coordinator is editing overlapping files. Only this report was written; no production/test files changed and no agents spawned.

## Prioritized demonstrable findings

### U1 · P1 — Settings sizing defeats its own viewport/scroll model

**Evidence:** `frontend/src/lib/components/SettingsDialog.svelte:355–364` applies `min-h-200` (800px at the default scale) alongside 550/600px breakpoint heights. The shared centered dialog has no height cap (`ui/dialog/dialog-content.svelte:28–34`). Mobile settings places `use:viewportHeight` on its *inner* body (`SettingsDialog.svelte:317–325`), while the drawer caps itself at `80vh` (`ui/drawer/drawer-content.svelte:26–28`); the action sets both height and minimum height to the *entire* visual viewport (`frontend/src/lib/actions/viewport-height.ts:23–25`).

**Impact:** the desktop minimum overrides the intended heights, putting the header/close control outside short laptop or landscape viewports. On mobile, a full-viewport minimum body plus header/handle cannot fit an 80vh drawer; scrolling is sized to the wrong box. This undermines access to all settings, not one tab.

**Adjustment:** cap the outer settings surface to the visible viewport, remove the contradictory minimum, and let a `min-h-0` flex body consume the remaining height and scroll internally. `VoiceVideoCallView.svelte:2713–2724` already supplies a closer pattern: height-capped dialog with scrollable body. Verify 1366×768, short landscape and software-keyboard-open states. **Overlap:** adjacent to the approved mobile/form usability work, but this settings sizing issue is not explicitly covered by requirements.

### U2 · P1 — Floating panels have incompatible mobile width budgets

**Evidence:** call panel width is `min(280px, 45vw)` (`frontend/src/lib/call-pip.svelte.ts:50–52`). Its single-row toolbar contains seven non-shrinking 24px buttons, seven 4px gaps and 16px horizontal padding (`CallPipPanel.svelte:102–134,145–238`): approximately **212px before any room name**. At 390px viewport width the panel is only 175.5px, with `overflow-hidden`. The DM panel has a fixed 340px width (`frontend/src/lib/dm-panel.svelte.ts:39–40`; `FloatingDmPanel.svelte:120–133`); its clamp cannot fit it into a 320px viewport (`FloatingDmPanel.svelte:65–68`). Call profile actions open that panel without a mobile alternative (`VoiceVideoCallView.svelte:2703–2706`).

**Impact:** call controls at the toolbar's right end, including return/leave, are clipped on common phones; narrow-screen DM content extends outside the viewport. The normal call stage deliberately uses 44px mobile controls (`VoiceVideoCallView.svelte:2044–2052`), whereas these panels retain 24px targets.

**Adjustment:** retain compact floating panels, but fit controls as well as the media: keep essential call actions visible and place secondary actions in the existing menu pattern, or use a second toolbar row. Bound DM width to viewport minus gutters and share that actual width with drag/clamp calculations. Increase touch hit areas without shrinking icons further. **Overlap:** `FloatingDmPanel` is being changed for send preservation (#7); coordinate later layout changes with its owner.

### U3 · P2 — Repeated settings controls expose state without a useful name

**Evidence:** App settings places visible text in sibling spans but passes neither a label association nor accessible name to switches (`settings/AppSettings.svelte:139–150,167–178,210–237,252–277,489–514,529–540`). The shared Switch forwards attributes but does not create a name (`ui/switch/switch.svelte:16–29`). Audio's screen-share switch repeats this (`settings/AudioSettings.svelte:584–595`). Slider labels are also unassociated (`settings/AppSettings.svelte:345–360`; `settings/AudioSettings.svelte:459–479,559–576`), and the shared Slider renders thumbs without per-thumb naming (`ui/slider/slider.svelte:44–49`). Settings navigation and font-choice chips indicate selection only through classes (`SettingsDialog.svelte:144–159`; `settings/AppSettings.svelte:370–382`).

**Impact:** visually readable settings become ambiguous in an accessibility tree; selected sections/font choices cannot be distinguished programmatically. This is a repeated primitive-usage gap, not a preference about appearance.

**Adjustment:** associate visible labels and explanatory text with each control; ensure slider names reach the focusable thumb. Expose selected state on navigation/choice controls using semantics appropriate to the current interaction (a full tab pattern only if its keyboard behavior is implemented). Preserve current layouts and mono labels. **Overlap:** approved persistent labels concern setup/unlock/room entry; extend the same convention to settings. Coordinate the new privacy switch (#4) in this file rather than duplicating its work.

### U4 · P2 — Floating-toolbar hover states use the wrong foreground token

**Evidence:** all seven call-panel buttons use `hover:bg-accent hover:text-foreground` (`CallPipPanel.svelte:134,153,172,193,208,223,238`), repeated by all three DM-panel header controls (`FloatingDmPanel.svelte:146,159,172`) and the “Use here” notice action (`AppNotices.svelte:199`). Dark tokens specify a bright green accent and near-white foreground, but a dark `accent-foreground` (`frontend/src/app.css:38,49–50`). The shared Button correctly pairs accent with accent foreground (`ui/button/button.svelte:14–16`).

**Impact:** hover makes icons/text much harder to distinguish, precisely when a user targets them. Source-color calculation gives approximately 1.3:1 near-white on the green accent in clipped sRGB; this is not a screenshot measurement.

**Adjustment:** use `hover:text-accent-foreground` with the solid accent, or the existing neutral muted hover treatment. Apply the correction to the repeated pattern, retaining green and current compact geometry. **Overlap:** DM-panel production edits are in progress; this token issue is separate from #7.

### U5 · P2 — Floating call camera loses the stage's pending-state feedback

**Evidence:** stage camera controls disable while `cameraPending`, expose `aria-busy` and pulse (`VoiceVideoCallView.svelte:2091–2102`, repeated at `2272–2283`). The panel calls the same toggle but has no pending/disabled state (`CallPipPanel.svelte:145–159`). Its leave control also uses the same neutral treatment as ordinary toolbar controls (`230–240`), unlike the prominent red stage hang-up (`VoiceVideoCallView.svelte:2143–2152`).

**Impact:** navigating away from the call removes confirmation that a device action is underway; repeated presses appear available even during acquisition. Destructive exit becomes visually indistinguishable among tightly packed actions. The transport's handling of duplicate requests was not audited here.

**Adjustment:** carry the existing `cameraPending` disabled/busy presentation into the panel and reuse the stage's destructive color meaning for leave, at panel scale. Avoid a new spinner/state system. **Overlap:** SFU authentication (#2) may alter connection behavior, but this local camera/panel presentation is distinct.

### U6 · P2 — Landing's secondary copy is substantially dimmer than app copy

**Evidence:** `frontend/src/Landing.svelte:714–717,768–769,855–865` uses `#666` for secondary text over `#09090b`, including 12px section labels and 18px descriptions. The source colors yield approximately **3.46:1** contrast before scanline/noise overlays. App secondary text instead uses the brighter semantic `--muted-foreground` (`frontend/src/app.css:48`).

**Impact:** repeated explanatory copy is harder to read than the authenticated app's equivalent copy. This affects comprehension of the product's unusual trust/recovery model; it is not an objection to the large marketing typography.

**Adjustment:** brighten the scoped landing muted color to a normal-body-readable level, ideally the established muted foreground or a tested landing-specific equivalent. Retain the dark palette, display headings, terminal motifs and generous marketing spacing. No live contrast sampling was possible.

### U7 · P2 — Reduced-motion behavior stops at profile names

**Evidence:** `frontend/src/app.css:245–250` disables shimmer/rainbow name effects for reduced motion. Landing keeps infinite hover glitch, scroll pulse and moving marquee (`frontend/src/Landing.svelte:791–792,977–982,1007–1009`) with no reduced-motion override in that component. The global rule only targets the two name-effect classes.

**Impact:** the same motion preference is honored inside chat but ignored on the entry page, where decorative movement is most prominent.

**Adjustment:** add a scoped reduced-motion treatment that stops these decorative animations while retaining their static content. Keep functional loading feedback, expressed without unnecessary motion. No live motion validation performed.

## Already assigned — consolidate, do not duplicate

`requirements.md:9–20` already covers the following source observations. They are **overlap evidence, not additional implementation requests or claims that pending fixes failed**:

| Active scope | Observed source before remediation | Consolidation check |
| --- | --- | --- |
| First-run overload, persistent labels and associated errors | `IdentitySetup.svelte:198–226` auto-opens Quirks; `UnlockIdentity.svelte:184–199` has placeholder-only password/error text; `RoomCreateJoin.svelte:267–308` has placeholder-only name/code controls | Preserve short recovery/trust essentials and accessible detailed explanation; confirm labels/error association across branches. |
| #5 remembered password vs biometrics | `UnlockIdentity.svelte:168–205`; `IdentitySetup.svelte:299–309` | UI wording and controls should match the new protection semantics. |
| #7 oversized text and failed sends | `FloatingDmPanel.svelte:85–97` clears the draft before awaiting send, with no visible error branch | Confirm panel, room/DM, reply and staged-file failures use the approved preservation/feedback behavior. Its existing history loading state is only a pulsing dot (`186–189`); add a named status when that block is touched. |
| #8/#9 invite parsing/expiry | `RoomCreateJoin.svelte:115–126,159–171` caches aliases and parses only the clipboard-button path | Confirm all paste methods and expired-code outcomes use the shared behavior, including persistent readable feedback. |
| #4 external-media privacy | `RoomCreateJoin.svelte:249–254` directly renders the avatar; related profile/media sources are in the coordinator's scope | Check blocked-media placeholders and the new setting follow existing muted cards, clear labels and accessible controls (U3). |

AppNotices already separates essential warnings from optional debug chrome and supplies `role="alert"`/`role="status"` (`AppNotices.svelte:9–23,164–185`); retain that direction. Do not replace it with generic disappearing error toasts.

## Subjective suggestions, not defects

- Typography: landing display sans, app mono chrome and user-configurable chat fonts serve different roles. The DM panel already carries chat family/size preferences (`FloatingDmPanel.svelte:117–122,181–184`). Uniformly replacing these fonts would contradict existing direction; no general font-family rewrite is justified.
- Spacing/color: settings' colored section markers and the stage's video-safe black/white overlays need not be flattened into identical cards. A future cosmetic pass could standardize section padding or tiny metadata text, but no documented scale makes every 10/11/12px difference a defect. U1/U2 concern actual fit; U4/U6 concern actual color pairings.

**Suggested order:** resolve U1/U2 first, then U3–U5 across shared interactions, then U6/U7. Recheck touched line anchors after the active remediation lands. Browser verification should target the specific viewport, focus, accessible-name, contrast and pending-state cases above rather than a broad redesign review.
