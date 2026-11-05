---
version: alpha
name: Review platform
description: Warm, flat, hairline-bordered operations workbench. Cream canvas, near-black text, a single mustard accent. Visual language adapted from the OpenHands documentation site (Mintlify "mint" theme); no OpenHands name, logo or proprietary font is used.
colors:
  # ── Light (default) ────────────────────────────────────────────
  primary: "#99873c"
  on-primary: "#000000"
  primary-ink: "#6b5c22"
  primary-soft: "#eee8dc"
  background: "#f7f3ee"
  surface: "#ffffff"
  on-surface: "#374151"
  heading: "#111827"
  secondary-text: "#54544f"
  muted-text: "#747471"
  border: "#e3e2e0"
  border-strong: "#d2d2cf"
  hover-fill: "#efece6"
  code-surface: "#ffffff"
  on-code-surface: "#1f2328"
  info-soft: "#eff6ff"
  info-border: "#bfdbfe"
  on-info-soft: "#1e40af"
  success-soft: "#f0fdf4"
  success-border: "#bbf7d0"
  on-success-soft: "#166534"
  warning-soft: "#fefce8"
  warning-border: "#fef08a"
  on-warning-soft: "#854d0e"
  danger-soft: "#fef2f2"
  danger-border: "#fecaca"
  on-danger-soft: "#991b1b"
  danger: "#b91c1c"
  on-danger: "#ffffff"
  # ── Dark (applied via the `.dark` / prefers-color-scheme override, see Colors) ──
  primary-dark: "#ffe165"
  on-primary-dark: "#000000"
  primary-soft-dark: "#232217"
  background-dark: "#0b0d0e"
  surface-dark: "#0b0d0e"
  on-surface-dark: "#d1d5db"
  heading-dark: "#ffffff"
  secondary-text-dark: "#a3a2a0"
  border-dark: "#25272a"
  hover-fill-dark: "#17191b"
  code-surface-dark: "#0b0c0e"
  on-code-surface-dark: "#d4d4d4"
  info-soft-dark: "#101e3a"
  on-info-soft-dark: "#93c5fd"
  success-soft-dark: "#0d2b1a"
  on-success-soft-dark: "#86efac"
  warning-soft-dark: "#3b330f"
  on-warning-soft-dark: "#fde047"
  danger-soft-dark: "#351213"
  on-danger-soft-dark: "#fca5a5"
typography:
  headline-lg:
    fontFamily: Inter Variable
    fontSize: 36px
    fontWeight: 600
    lineHeight: 40px
    letterSpacing: -0.025em
    fontFeature: "'cv02', 'cv03', 'cv04', 'cv11'"
  headline-md:
    fontFamily: Inter Variable
    fontSize: 24px
    fontWeight: 600
    lineHeight: 32px
    fontFeature: "'cv02', 'cv03', 'cv04', 'cv11'"
  headline-sm:
    fontFamily: Inter Variable
    fontSize: 20px
    fontWeight: 600
    lineHeight: 28px
    fontFeature: "'cv02', 'cv03', 'cv04', 'cv11'"
  title-md:
    fontFamily: Inter Variable
    fontSize: 16px
    fontWeight: 600
    lineHeight: 24px
    fontFeature: "'cv02', 'cv03', 'cv04', 'cv11'"
  body-md:
    fontFamily: Inter Variable
    fontSize: 16px
    fontWeight: 400
    lineHeight: 28px
    fontFeature: "'cv02', 'cv03', 'cv04', 'cv11'"
  body-sm:
    fontFamily: Inter Variable
    fontSize: 14px
    fontWeight: 400
    lineHeight: 24px
    fontFeature: "'cv02', 'cv03', 'cv04', 'cv11'"
  label-md:
    fontFamily: Inter Variable
    fontSize: 14px
    fontWeight: 500
    lineHeight: 20px
    fontFeature: "'cv02', 'cv03', 'cv04', 'cv11'"
  label-sm:
    fontFamily: Inter Variable
    fontSize: 12px
    fontWeight: 500
    lineHeight: 16px
    fontFeature: "'cv02', 'cv03', 'cv04', 'cv11'"
  code-md:
    fontFamily: JetBrains Mono Variable
    fontSize: 14px
    fontWeight: 400
    lineHeight: 22px
  code-inline:
    fontFamily: JetBrains Mono Variable
    fontSize: 14px
    fontWeight: 600
    lineHeight: 20px
rounded:
  none: 0px
  sm: 6px
  md: 12px
  lg: 16px
  full: 9999px
spacing:
  unit: 4px
  control-sm: 32px
  control-md: 36px
  control-lg: 44px
  card-padding-x: 24px
  card-padding-y: 20px
  callout-padding-x: 20px
  callout-padding-y: 16px
  topbar-height: 64px
  sidebar-width: 264px
  content-max-width: 1472px
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.label-md}"
    rounded: "{rounded.md}"
    height: "{spacing.control-md}"
    padding: 0 16px
  button-primary-dark:
    backgroundColor: "{colors.primary-dark}"
    textColor: "{colors.on-primary-dark}"
  button-secondary:
    backgroundColor: "{colors.background}"
    textColor: "{colors.heading}"
    typography: "{typography.label-md}"
    rounded: "{rounded.md}"
    height: "{spacing.control-md}"
    padding: 0 12px
  button-secondary-hover:
    backgroundColor: "{colors.hover-fill}"
    textColor: "{colors.heading}"
  button-ghost-hover:
    backgroundColor: "{colors.hover-fill}"
    textColor: "{colors.heading}"
  button-danger:
    backgroundColor: "{colors.danger}"
    textColor: "{colors.on-danger}"
    typography: "{typography.label-md}"
    rounded: "{rounded.md}"
    height: "{spacing.control-md}"
  input-field:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.heading}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.md}"
    height: "{spacing.control-md}"
    padding: 0 12px
  card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.on-surface}"
    rounded: "{rounded.lg}"
    padding: 20px 24px
  card-dark:
    backgroundColor: "{colors.surface-dark}"
    textColor: "{colors.on-surface-dark}"
  page:
    backgroundColor: "{colors.background}"
    textColor: "{colors.on-surface}"
    typography: "{typography.body-md}"
  page-dark:
    backgroundColor: "{colors.background-dark}"
    textColor: "{colors.on-surface-dark}"
  heading-text:
    backgroundColor: "{colors.background}"
    textColor: "{colors.heading}"
    typography: "{typography.headline-md}"
  heading-text-dark:
    backgroundColor: "{colors.background-dark}"
    textColor: "{colors.heading-dark}"
  secondary-text:
    backgroundColor: "{colors.background}"
    textColor: "{colors.secondary-text}"
    typography: "{typography.body-sm}"
  secondary-text-dark:
    backgroundColor: "{colors.background-dark}"
    textColor: "{colors.secondary-text-dark}"
  nav-item:
    textColor: "{colors.secondary-text}"
    typography: "{typography.label-md}"
    rounded: "{rounded.md}"
    padding: 6px 12px
  nav-item-hover:
    backgroundColor: "{colors.hover-fill}"
    textColor: "{colors.heading}"
  nav-item-active:
    backgroundColor: "{colors.primary-soft}"
    textColor: "{colors.primary-ink}"
  nav-item-active-dark:
    backgroundColor: "{colors.primary-soft-dark}"
    textColor: "{colors.primary-dark}"
  callout-info:
    backgroundColor: "{colors.info-soft}"
    textColor: "{colors.on-info-soft}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.lg}"
    padding: 16px 20px
  callout-info-dark:
    backgroundColor: "{colors.info-soft-dark}"
    textColor: "{colors.on-info-soft-dark}"
  callout-success:
    backgroundColor: "{colors.success-soft}"
    textColor: "{colors.on-success-soft}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.lg}"
    padding: 16px 20px
  callout-success-dark:
    backgroundColor: "{colors.success-soft-dark}"
    textColor: "{colors.on-success-soft-dark}"
  callout-warning:
    backgroundColor: "{colors.warning-soft}"
    textColor: "{colors.on-warning-soft}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.lg}"
    padding: 16px 20px
  callout-warning-dark:
    backgroundColor: "{colors.warning-soft-dark}"
    textColor: "{colors.on-warning-soft-dark}"
  callout-danger:
    backgroundColor: "{colors.danger-soft}"
    textColor: "{colors.on-danger-soft}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.lg}"
    padding: 16px 20px
  callout-danger-dark:
    backgroundColor: "{colors.danger-soft-dark}"
    textColor: "{colors.on-danger-soft-dark}"
  tag:
    backgroundColor: "{colors.primary-soft}"
    textColor: "{colors.primary-ink}"
    typography: "{typography.label-sm}"
    rounded: "{rounded.full}"
    padding: 2px 8px
  code-block:
    backgroundColor: "{colors.code-surface}"
    textColor: "{colors.on-code-surface}"
    typography: "{typography.code-md}"
    rounded: "{rounded.lg}"
    padding: 16px
  code-block-dark:
    backgroundColor: "{colors.code-surface-dark}"
    textColor: "{colors.on-code-surface-dark}"
  code-inline:
    textColor: "{colors.heading}"
    typography: "{typography.code-inline}"
  dialog:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.on-surface}"
    rounded: "{rounded.lg}"
    padding: 24px
  dialog-dark:
    backgroundColor: "{colors.surface-dark}"
    textColor: "{colors.on-surface-dark}"
  toast:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.heading}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.md}"
    padding: 12px 16px
  skeleton:
    backgroundColor: "{colors.border}"
    rounded: "{rounded.sm}"
  # Hairlines are modelled as 1px fills; the spec has no borderColor property.
  hairline:
    backgroundColor: "{colors.border}"
    height: 1px
  hairline-strong:
    backgroundColor: "{colors.border-strong}"
    height: 1px
  hairline-dark:
    backgroundColor: "{colors.border-dark}"
    height: 1px
  callout-info-hairline:
    backgroundColor: "{colors.info-border}"
    height: 1px
  callout-success-hairline:
    backgroundColor: "{colors.success-border}"
    height: 1px
  callout-warning-hairline:
    backgroundColor: "{colors.warning-border}"
    height: 1px
  callout-danger-hairline:
    backgroundColor: "{colors.danger-border}"
    height: 1px
  input-placeholder:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.muted-text}"
    typography: "{typography.body-sm}"
  button-ghost-hover-dark:
    backgroundColor: "{colors.hover-fill-dark}"
    textColor: "{colors.heading-dark}"
---

# Review platform Design System

This file is read by humans and coding agents. The YAML front matter is the **normative** token set. The prose explains intent and how to apply it. Code-level rules (how to write a styled component) live in [docs/styling.md](docs/styling.md), and the two documents never restate each other.

## Overview

Review platform is a single-user operations workbench. It covers PR review and shipping, with PR review requests taken from Slack. The interface has to make dense, consequential information (P0 findings, merge decisions, review status) easy to scan, without visual noise.

The visual language is adapted from the OpenHands documentation site:

- **Warm.** A cream canvas and a warm-tinted gray scale, never a cold blue-gray.
- **Flat.** Depth comes from 1px hairlines, not shadows.
- **Restrained.** There is a single mustard/yellow accent. It marks _where you are_ (active nav, focus, the one primary action) and is never used decoratively.
- **Rounded.** Corners are a consistent 12–16px on containers and 6px on small affordances.
- **High-contrast text.** Body copy is near-black on cream, or near-white on black in dark mode.

The docs site is airy, but this is a tool, so it is denser. Lists and tables use 8–12px vertical rhythm. 24–32px gaps are reserved for page-level separation.

## Colors

**Roles.** `background` is the page canvas. `surface` holds content that needs to stand apart, such as cards, inputs, dialogs and code. `on-surface` is body text and `heading` is titles and emphasised values. `secondary-text` is metadata (authors, timestamps, counts). `muted-text` is **only** for placeholders, disabled states and decorative glyphs. It passes on `surface` (4.7:1, so input placeholders are fine) but fails on `background` (4.24:1), so it must never carry information on the page canvas.

**Accent.**

- `primary` (#99873c) is a _fill_ colour. Use it for the primary button and focus rings, and always pair it with `on-primary` (black, 5.9:1). White on `primary` fails contrast and is forbidden.
- `primary` must not be used as text on light backgrounds (3.2:1). Use `primary-ink` (#6b5c22, 6.0:1 on `background`, 5.4:1 on `primary-soft`) for accent text, such as the active nav item and tags.
- In dark mode the accent is `primary-dark` (#ffe165), which is bright enough to be used as text directly (15:1).

**Status.** Info, success, warning and danger each have a `*-soft` fill, a `*-border` hairline and an `on-*-soft` text colour. Alerts, callouts and toasts use these pairs as-is. `danger` is the solid fill for destructive buttons only, such as Merge without review and Force approve.

**Dark mode.** The spec has no theme mechanism, so the dark palette is given as `*-dark` tokens. `src/styles/app.css` maps each light token's CSS variable to its `*-dark` counterpart under `:root.dark`, and under `@media (prefers-color-scheme: dark)` unless the user has explicitly chosen light. A light token without a `-dark` sibling keeps its value in dark mode only if it still meets contrast. The two exceptions are borders and hover fills, which have dark variants: `border-dark` is white at about 11% over the canvas (1.3:1), written as an opaque hex so tools can evaluate it.

**Contrast budget.** Every text/background pair, whether or not a component in the front matter declares it, must be at least 4.5:1. Text 18px or larger, or 14px bold, may drop to 3:1, but body text never does. Hairlines are decorative and are exempt; `border` is 1.17:1 and `border-dark` 1.3:1.

- The `@google/design.md` 0.4.0 linter did **not** report contrast findings for this file, so do not rely on it.
- Contrast is enforced by the token test in `src/styles/` (see styling.md §0). It computes WCAG ratios for every component pair and for the pairs named in this section.

## Typography

- **Families.** Inter (variable, `@fontsource-variable/inter`) for everything, with the OpenType features `cv02 cv03 cv04 cv11` enabled globally to get the single-storey _a_, the open digits and the flat-top _l_. Monospace is JetBrains Mono Variable. The source site uses a proprietary mono face, which we do not ship.
- **Hierarchy.** It comes from weight and size, never colour:
  - 600 for every heading and title level
  - 500 for labels, buttons, tabs and nav
  - 400 for body text
- **Line height.** Body text is set loosely (28px on 16px) for prose such as review findings. Tables and lists use `body-sm`.
- **Tracking.** `headline-lg` alone has negative tracking.
- **Inline code.** Use `code-inline`: weight 600 and the heading colour, with **no** background chip. This matches the source site and keeps dense review text calm.
- **Numbers.** Counts, durations and SHAs in tables use tabular figures (`font-variant-numeric: tabular-nums`).
- **In code.** Each typography token becomes one Tailwind `text-<name>` utility that carries size, line-height, weight and tracking, through the `--text-<name>--line-height`, `--text-<name>--font-weight` and `--text-<name>--letter-spacing` sub-variables. Families are wired once, as `--font-sans` and `--font-mono`.
  - Do **not** use the `css-tailwind` exporter's output verbatim. It emits a `--font-<name>` family variable and a `--font-weight-<name>` variable for every token, which produces two conflicting `font-<name>` utilities, and it drops `fontFeature`.

## Layout

- **Base unit.** 4px. Every padding, gap and size is a multiple of 4. This equals Tailwind's default `--spacing` (0.25rem), so the generic scale is just `p-1`…`p-8`, and only _semantic_ spacing (controls, cards, callouts, frame) is tokenised here. Generic `xs`…`2xl` names are deliberately absent, because `--spacing-xl` would shadow Tailwind's `max-w-xl` container sizes.
- **Radii.** `rounded.sm`/`md`/`lg` intentionally **override** Tailwind's defaults (6/12/16px instead of 4/6/8px), so `rounded-md` everywhere means this system's control radius.
- **App frame.** A sticky top bar (`topbar-height`, 64px) on the `background` colour with a hairline bottom border. Below it sit a left sidebar (`sidebar-width`) and the content area, centred up to `content-max-width`.
- **Cards.** Padding is `card-padding-y`/`card-padding-x` (20/24px). Gaps between cards are 16px (`gap-4`).
- **Lists and table rows.** Vertical padding is 8–12px (`py-2`–`py-3`). Density beats air in operational views.
- **Controls.** Heights are `control-sm`/`md`/`lg` (32/36/44px). `md` is the default and the minimum touch target on mobile is `lg`.
- **Small screens.** Below 768px the sidebar collapses into a top-bar menu, cards go full width with a 16px gutter, and there is no horizontal page scroll. Wide tables scroll inside their own container.

## Elevation & Depth

The system is **flat**. Surfaces are separated by:

1. **Fill change.** A `surface` (white) card sits on the `background` (cream) page.
2. **Hairline.** A 1px `border`, or `border-dark` in dark mode, on every card, input, dialog and code block. Hover may strengthen it to `border-strong`, and an interactive card's border turns `primary` on hover.
3. **Rings.** Focus is shown with a 2px `primary` ring at 2px offset, never by changing the shadow.

The only shadow allowed is `0 1px 2px rgb(0 0 0 / 5%)`, and only on small floating chips. Dialogs and popovers sit on a `rgb(0 0 0 / 40%)` backdrop (60% in dark mode) instead of using a shadow.

## Shapes

- **Radii.**
  - `lg` (16px): cards, callouts/alerts, dialogs and code blocks.
  - `md` (12px): buttons, inputs, selects, nav items, toasts and search.
  - `sm` (6px): small icon buttons, the copy-to-clipboard button and skeleton bars.
  - `full`: tags, badges, avatars and the status dot.
- **Borders.** Always 1px.
- **Icons.** Line icons with a stroke width of 1.5–2 and rounded caps (Lucide, via `unplugin-icons`; see styling.md §8). The default size is 16px in text and controls and 20–24px in cards and empty states. Icons take `currentColor`.

## Components

**Buttons.** There are four variants, and each screen has **one** primary action at most.

- `primary` is a solid `primary` fill with black text.
- `secondary` uses the page fill, a hairline border and `heading` text, and its fill becomes `hover-fill` on hover.
- `ghost` has no border until hovered, and is used for toolbar actions.
- `danger` is a solid `danger` fill and is reserved for irreversible GitHub writes (merge without review, force approve). It always sits behind a confirmation dialog.
- While a button is `loading` it keeps its width, shows a spinner and sets `aria-busy`.

**Inputs and selects.** A `surface` fill, a hairline border and `md` radius. On focus they get the 2px `primary` ring. Error state uses a `danger-border` hairline plus `on-danger-soft` helper text below the field, never a red fill.

**Navigation.** Sidebar items use `nav-item`.

- On hover they get the `hover-fill` background.
- The active item uses `primary-soft` with `primary-ink` text and a 500 weight. In dark mode it uses `primary-soft-dark` with `primary-dark`.

**Cards.** A `surface` fill, a hairline and `lg` radius, with padding 20/24. Clickable cards turn their border `primary` on hover and show a focus ring. Card titles are `title-md` and card metadata is `secondary-text`.

**Callouts and alerts.** These use the status `*-soft` / `*-border` / `on-*-soft` triples, `lg` radius, padding 16/20 and a 16px icon on the leading edge. Links and code inside a callout inherit its text colour. Danger and warning use `role="alert"`; info and success use `role="status"`.

**Review findings.** Severity is shown by a tag plus position (P0 first), and never by colour alone. P0 uses the danger triple, P1 the warning triple and P2/P3 the neutral tag.

**Tags.** These are `full` radius and `label-sm`. The neutral tag is `primary-soft` / `primary-ink`, and status tags use the status triples.

**Code.** Blocks use `code-block` (white in light mode, near-black in dark), a hairline, `lg` radius and a copy button at the top right (`sm` radius, 26px). Inline code follows Typography.

**Tables.** No zebra striping. Every row has a 1px `border` bottom hairline. The header is `label-md` in `secondary-text`. Numeric columns are right-aligned and use tabular figures.

**Dialogs.** A `surface` fill, `lg` radius, 24px padding, a title in `headline-sm` and a footer with actions right-aligned (primary last). They close on Escape unless an operation is in flight.

**Toasts.** These are `md` radius and `body-sm`, sit top-centre, and auto-dismiss after 4 seconds unless they report an error. Error toasts stay until dismissed.

**Skeletons.** Bars use the `border` colour and `sm` radius, with a `motion-safe` pulse.

**Login and setup.** `/login` and `/setup` sit outside the app frame: one centred card on the `background` canvas, no sidebar. The login card has a single token input (`type="password"`, so the value is masked) and one primary **Sign in** button. The `/setup` card shows a step indicator (login token, AI, GitHub, Slack) with the current step in `primary-ink`. Under it, one muted line says the values stay in the page until **完成** and that a reload starts over. Step 1 has the token input twice. Steps 2–4 have their own fields and an outlined check button (**测试连接**, or **验证并加载仓库** on GitHub) whose result shows inline; a section with stored values shows an **已配置** tag. The footer has a ghost **上一步** (from step 2), a secondary **稍后配置** (**稍后配置并完成** on step 4) and a primary **下一步** (**完成** on step 4). An error from **完成** shows inline on its step's field. A 409 shows a warning alert, "系统已初始化", with a **前往登录** button.

## Iconography & Motion

- **Icon sources.** Icons come from the `lucide` set. Brand marks come from `simple-icons` (Slack, GitHub). Animated icons come from `line-md` and `svg-spinners`, always paired with a static fallback. See styling.md §8–9 for the import and pairing rules.
- **Transitions.**
  - Colour, background and border use 150ms `cubic-bezier(0.4, 0, 0.2, 1)`.
  - The top-bar background on scroll uses 500ms.
  - Nothing animates layout (width, height, position) except a dialog's entry: 150ms opacity plus a 4px translate.
- **Reduced motion.** Every animation is gated by `motion-safe:`. Under `prefers-reduced-motion` the interface must remain fully usable, and state must never be conveyed by motion alone.

## Do's and Don'ts

- Do use exactly one `primary` button per view, and use `secondary` or `ghost` for everything else.
- Do pair `primary` fills with black text (`on-primary`); never put white text on the mustard.
- Do use `primary-ink`, not `primary`, whenever the accent is text on a light background.
- Do separate surfaces with a 1px hairline and a fill change, not a shadow.
- Do show severity and status with text or icon plus position, with colour only as reinforcement.
- Do keep `muted-text` for placeholders and disabled states only.
- Do put every destructive GitHub action (merge without review, force approve) behind a `danger` button and a confirmation dialog.
- Don't introduce a second accent hue. Status colours are for status only, never for decoration or branding.
- Don't use the OpenHands name, logo or proprietary fonts. Only the visual style is borrowed.
- Don't add shadows to cards, buttons or inputs.
- Don't hard-code hex values in components. Use a token, or add one here first.
- Don't animate without `motion-safe:`, and don't rely on animation to communicate state.
