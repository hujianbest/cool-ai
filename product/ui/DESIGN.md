---
version: alpha
name: Cool-AI-warm-terracotta
description: A local-first multi-agent cockpit on warm parchment. Four columns — dark rail, conversation directory, project group chat, and a mission board — share one sage accent, terracotta-ink type, and paper surfaces. Chrome stays flat; elevation is reserved for composer and approval overlays.

colors:
  primary: "#3E6B5E"
  accent: "#3E6B5E"
  primary-focus: "#2F5A4E"
  primary-on-dark: "#82B8A5"
  ink: "#2B251F"
  body: "#2B251F"
  body-on-dark: "#EDE5D8"
  body-muted: "#A99D8C"
  ink-muted-80: "#6F665A"
  muted: "#6F665A"
  ink-muted-48: "#9C9182"
  faint: "#9C9182"
  divider-soft: "#DEDAD1"
  hairline: "#BDB8B0"
  canvas: "#F4EFE5"
  canvas-parchment: "#FBF7EE"
  panel: "#FBF7EE"
  surface-pearl: "#FFFCF4"
  card: "#FFFCF4"
  card-strong: "#FFFFFF"
  surface-tile-1: "#15110D"
  surface-tile-2: "#1C1712"
  surface-tile-3: "#251F18"
  surface-black: "#0D0B08"
  surface-chip-translucent: "#DEDAD1"
  on-primary: "#FFFFFF"
  on-dark: "#EDE5D8"
  rail: "#241F18"
  rail-ink: "#EDE5D8"
  amber: "#96691C"
  green: "#3F6A4D"
  terra: "#A0443F"
  blue: "#41607F"

typography:
  hero-display:
    fontFamily: "SF Pro Display, system-ui, -apple-system, sans-serif"
    fontSize: 56px
    fontWeight: 600
    lineHeight: 1.07
    letterSpacing: -0.28px
  display-lg:
    fontFamily: "SF Pro Display, system-ui, -apple-system, sans-serif"
    fontSize: 40px
    fontWeight: 600
    lineHeight: 1.1
    letterSpacing: 0
  display-md:
    fontFamily: "SF Pro Text, system-ui, -apple-system, sans-serif"
    fontSize: 34px
    fontWeight: 600
    lineHeight: 1.47
    letterSpacing: -0.374px
  lead:
    fontFamily: "SF Pro Display, system-ui, -apple-system, sans-serif"
    fontSize: 28px
    fontWeight: 400
    lineHeight: 1.14
    letterSpacing: 0.196px
  lead-airy:
    fontFamily: "SF Pro Text, system-ui, -apple-system, sans-serif"
    fontSize: 24px
    fontWeight: 300
    lineHeight: 1.5
    letterSpacing: 0
  tagline:
    fontFamily: "SF Pro Display, system-ui, -apple-system, sans-serif"
    fontSize: 21px
    fontWeight: 600
    lineHeight: 1.19
    letterSpacing: 0.231px
  body-strong:
    fontFamily: "SF Pro Text, system-ui, -apple-system, sans-serif"
    fontSize: 17px
    fontWeight: 600
    lineHeight: 1.24
    letterSpacing: -0.374px
  body:
    fontFamily: "SF Pro Text, system-ui, -apple-system, sans-serif"
    fontSize: 17px
    fontWeight: 400
    lineHeight: 1.47
    letterSpacing: -0.374px
  dense-link:
    fontFamily: "SF Pro Text, system-ui, -apple-system, sans-serif"
    fontSize: 17px
    fontWeight: 400
    lineHeight: 2.41
    letterSpacing: 0
  caption:
    fontFamily: "SF Pro Text, system-ui, -apple-system, sans-serif"
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.43
    letterSpacing: -0.224px
  caption-strong:
    fontFamily: "SF Pro Text, system-ui, -apple-system, sans-serif"
    fontSize: 14px
    fontWeight: 600
    lineHeight: 1.29
    letterSpacing: -0.224px
  button-large:
    fontFamily: "SF Pro Text, system-ui, -apple-system, sans-serif"
    fontSize: 18px
    fontWeight: 300
    lineHeight: 1.0
    letterSpacing: 0
  button-utility:
    fontFamily: "SF Pro Text, system-ui, -apple-system, sans-serif"
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.29
    letterSpacing: -0.224px
  fine-print:
    fontFamily: "SF Pro Text, system-ui, -apple-system, sans-serif"
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.0
    letterSpacing: -0.12px
  micro-legal:
    fontFamily: "SF Pro Text, system-ui, -apple-system, sans-serif"
    fontSize: 10px
    fontWeight: 400
    lineHeight: 1.3
    letterSpacing: -0.08px
  nav-link:
    fontFamily: "SF Pro Text, system-ui, -apple-system, sans-serif"
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.0
    letterSpacing: -0.12px
  ui-xs:
    fontFamily: "-apple-system, PingFang SC, Noto Sans SC, Segoe UI Variable, Microsoft YaHei UI, system-ui, sans-serif"
    fontSize: 11px
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: 0.06em
  ui-sm:
    fontFamily: "-apple-system, PingFang SC, Noto Sans SC, Segoe UI Variable, Microsoft YaHei UI, system-ui, sans-serif"
    fontSize: 12.5px
    fontWeight: 400
    lineHeight: 1.35
    letterSpacing: 0
  ui-md:
    fontFamily: "-apple-system, PingFang SC, Noto Sans SC, Segoe UI Variable, Microsoft YaHei UI, system-ui, sans-serif"
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: 0
  ui-lg:
    fontFamily: "-apple-system, PingFang SC, Noto Sans SC, Segoe UI Variable, Microsoft YaHei UI, system-ui, sans-serif"
    fontSize: 17px
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: -0.01em

rounded:
  none: 0px
  xs: 5px
  sm: 8px
  md: 12px
  lg: 16px
  pill: 9999px
  full: 9999px

spacing:
  xxs: 4px
  xs: 8px
  sm: 12px
  md: 17px
  lg: 24px
  xl: 32px
  xxl: 48px
  section: 80px

components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.ui-md}"
    rounded: "{rounded.md}"
    padding: 11px 16px
  button-primary-focus:
    backgroundColor: "{colors.primary-focus}"
    textColor: "{colors.on-primary}"
    rounded: "{rounded.md}"
  button-primary-active:
    backgroundColor: "{colors.primary-focus}"
    textColor: "{colors.on-primary}"
    rounded: "{rounded.md}"
  button-secondary-pill:
    backgroundColor: "{colors.card-strong}"
    textColor: "{colors.ink}"
    typography: "{typography.ui-sm}"
    rounded: "{rounded.pill}"
    padding: 8px 14px
  button-ghost:
    backgroundColor: transparent
    textColor: "{colors.muted}"
    typography: "{typography.ui-sm}"
    rounded: "{rounded.sm}"
  activity-rail:
    backgroundColor: "{colors.rail}"
    textColor: "{colors.rail-ink}"
    typography: "{typography.ui-xs}"
    width: 56px
  rail-item-current:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    rounded: "{rounded.sm}"
  sidebar-panel:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    typography: "{typography.ui-sm}"
    width: 236px
  search-input:
    backgroundColor: transparent
    textColor: "{colors.faint}"
    typography: "{typography.ui-sm}"
    rounded: "{rounded.pill}"
    height: 44px
  thread-item:
    backgroundColor: transparent
    textColor: "{colors.muted}"
    typography: "{typography.ui-sm}"
    rounded: "{rounded.sm}"
  thread-item-current:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
  flow-canvas:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
  thread-header:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    typography: "{typography.ui-lg}"
  message-card:
    backgroundColor: "{colors.card}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
  composer:
    backgroundColor: "{colors.card-strong}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
  context-panel:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    width: 304px
  context-tab-selected:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
  mission-card:
    backgroundColor: "{colors.card}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
  approval-card:
    backgroundColor: "{colors.card-strong}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
  memory-card:
    backgroundColor: "{colors.card}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
  status-queued:
    backgroundColor: "{colors.amber}"
    textColor: "{colors.amber}"
  status-running:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary}"
  status-success:
    backgroundColor: "{colors.green}"
    textColor: "{colors.green}"
  status-danger:
    backgroundColor: "{colors.terra}"
    textColor: "{colors.terra}"
  text-link:
    backgroundColor: transparent
    textColor: "{colors.primary}"
    typography: "{typography.ui-md}"
  global-nav:
    backgroundColor: "{colors.rail}"
    textColor: "{colors.rail-ink}"
    typography: "{typography.nav-link}"
    height: 44px
---

## Overview

Cool AI’s cockpit is a **warm terracotta workbench**, not a marketing gallery. The owner works in four columns: a dark activity rail, a parchment conversation directory, a canvas group-chat flow, and a parchment mission/approval/memory board. Surfaces are paper (canvas, panel, pearl card, white card-strong). The only interactive accent is sage green `{colors.primary}` (#3E6B5E). Status uses amber, green, terra, and blue as extensions — never as a second brand color.

Density is cockpit-scale: 11 / 12.5 / 14 / 17px UI type. Display sizes remain in the token scale for preview and rare headings but are not the default reading size. Chrome is flat. Shadows appear only on the composer and approval overlays.

**Key Characteristics:**
- Warm paper stack: canvas `{colors.canvas}` → panel `{colors.canvas-parchment}` → pearl card `{colors.surface-pearl}` → card-strong `{colors.card-strong}`.
- Single sage accent (`{colors.primary}` — #3E6B5E). Dark theme uses `{colors.primary-on-dark}` (#82B8A5).
- Dark rail `{colors.rail}` with `{colors.rail-ink}` icons; the current rail item fills with accent.
- Desktop grid 56 / 236 / 1fr / 304. Touch targets stay 44×44 (`--control-min: 2.75rem`).
- No decorative gradients, glass, glow, or emoji icons.

## Colors

> **Source:** `product/ui/cool-ai-design-md-case.html` `#cool-case` token block. Light values are the YAML source of truth. Dark values are the `light-dark()` second channel, projected in `app/tokens.css`.

### Brand & Accent
- **Sage** (`{colors.primary}` — #3E6B5E): The only interactive color — primary buttons, current rail item, running status, selected-row text.
- **Sage focus** (`{colors.primary-focus}` — #2F5A4E): Hover/focus of the accent; keyboard focus ring root in light theme.
- **Sage on dark** (`{colors.primary-on-dark}` — #82B8A5): Dark-theme accent (and light-theme accent on the rail when needed).
- **On primary** (`{colors.on-primary}` — #FFFFFF): Label on sage fills. Dark theme uses #10100C.

### Surface (light)
- **Canvas** (`{colors.canvas}` — #F4EFE5): Group-chat flow.
- **Parchment / panel** (`{colors.canvas-parchment}` — #FBF7EE): Sidebar and context board.
- **Pearl / card** (`{colors.surface-pearl}` — #FFFCF4): Mission cards, memory cards, message blocks.
- **Card-strong** (`{colors.card-strong}` — #FFFFFF): Composer, approval overlay, project switcher fill.
- **Rail** (`{colors.rail}` — #241F18): Activity bar.
- **Dark tiles** (`{colors.surface-tile-1/2/3}` — #15110D / #1C1712 / #251F18): Dark-theme canvas / panel / card.
- **Void** (`{colors.surface-black}` — #0D0B08): Dark-theme rail.

### Text (light)
- **Ink / body** (`{colors.ink}` — #2B251F): Headlines and body.
- **Muted** (`{colors.ink-muted-80}` — #6F665A): Secondary labels. Meets 4.5:1 on parchment.
- **Faint** (`{colors.ink-muted-48}` — #9C9182): Fine print, timestamps, section kicker. May fail AA as continuous text — `--text-subtle` uses a raised warm tone without changing this YAML value.
- **Body on dark / rail ink** (`{colors.body-on-dark}` / `{colors.rail-ink}` — #EDE5D8).
- **Body muted** (`{colors.body-muted}` — #A99D8C): Secondary copy on dark rail/tiles.

### Hairlines
- **Divider soft** (`{colors.divider-soft}` — #DEDAD1): Solid equivalent of `rgba(43,37,31,.14)` composited on parchment. YAML and `--color-divider-soft` stay `#RRGGBB` so contrast tests can parse them.
- **Hairline** (`{colors.hairline}` — #BDB8B0): Solid equivalent of `rgba(43,37,31,.30)` on parchment.

### Status & extension
- **Amber** (`{colors.amber}` — #96691C): queued / draft.
- **Green** (`{colors.green}` — #3F6A4D): success / done.
- **Terra** (`{colors.terra}` — #A0443F): danger / blocked.
- **Blue** (`{colors.blue}` — #41607F): review / informational chips. Not an interactive accent.

Agent identity colors remain extension tokens in `tokens.css`; they must not replace sage as the primary action color.

### Dark theme (tokens.css)

| Role | Hex |
|---|---|
| canvas | #15110D |
| panel | #1C1712 |
| card | #251F18 |
| card-strong | #2B241B |
| ink | #EDE5D8 |
| muted | #A99D8C |
| faint | #786E60 |
| accent | #82B8A5 |
| accent-ink | #10100C |
| focus | #9ACBBA |
| rail | #0D0B08 |
| rail-ink | #EDE5D8 |
| amber | #D9A94F |
| green | #86B98F |
| terra | #D08075 |
| blue | #8FB0CC |

### Brand Gradient
**No decorative gradients.** Depth comes from the paper stack and the dark rail, not from CSS gradients or blur.

## Typography

### Font Family
- **Cockpit UI**: `-apple-system, "PingFang SC", "Noto Sans SC", "Segoe UI Variable", "Microsoft YaHei UI", system-ui, sans-serif` (`--font-sans`).
- **Display / body named tokens** keep the existing SF Pro stack names for compatibility with `tokens.css`.

### Hierarchy

| Token | Size | Use |
|---|---|---|
| `{typography.hero-display}` | 56px | Preview / rare display; not default cockpit chrome |
| `{typography.display-lg}` | 40px | Preview headings |
| `{typography.display-md}` | 34px | Preview headings |
| `{typography.lead}` | 28px | Preview lead |
| `{typography.ui-lg}` / `{typography.body}` | 17px | Thread title, primary cockpit reading |
| `{typography.ui-md}` / `{typography.caption}` | 14px | Body in lists, buttons, cards |
| `{typography.ui-sm}` | 12.5px | Thread rows, tabs, meta |
| `{typography.ui-xs}` / `{typography.fine-print}` | 11–12px | Kickers, timestamps, rail labels |
| `{typography.nav-link}` | 12px | Compact nav |

Cockpit density is **11 / 12.5 / 14 / 17**. Display sizes stay in the scale so preview pages and existing tokens do not break.

## Layout

### Spacing System
- **Tokens:** `{spacing.xxs}` 4px · `{spacing.xs}` 8px · `{spacing.sm}` 12px · `{spacing.md}` 17px · `{spacing.lg}` 24px · `{spacing.xl}` 32px · `{spacing.xxl}` 48px · `{spacing.section}` 80px.
- Cockpit chrome uses the smaller end of the scale (8–16px padding). `{spacing.section}` is for preview tiles, not the four-column shell.

### Grid
- Desktop: activity rail **56px** (`3.5rem`) + sidebar **236px** (`14.75rem`) + flow `minmax(0, 1fr)` + context **304px** (`19rem`).
- `--control-min` remains **2.75rem** (44×44). Visual chrome may look tighter; hit areas do not shrink.
- Narrow: existing drawer model. Do not adopt the case’s 980px stack.

## Elevation & Depth

| Level | Treatment | Use |
|---|---|---|
| Flat | No shadow | Rail, sidebar, flow, context, cards at rest |
| Soft hairline | 1px `{colors.divider-soft}` | Column rules, card outlines |
| Overlay | `{shadow-1}` + `{shadow-2}` | Composer float, approval card |

No glass, no backdrop-blur on chrome, no glow.

## Shapes

| Token | Value | Use |
|---|---|---|
| `{rounded.none}` | 0px | Full-bleed shell |
| `{rounded.xs}` | 5px | Rare compact chips |
| `{rounded.sm}` | 8px | Rail items, thread rows, tabs |
| `{rounded.md}` | 12px | Cards, primary buttons, inputs |
| `{rounded.lg}` | 16px | Composer, approval overlay |
| `{rounded.pill}` | 9999px | Search field, status chips (documented as pill; 9999px keeps existing CSS) |

## Components

**`activity-rail`** — 56px dark column, `{colors.rail}` / `{colors.rail-ink}`. Current item `{component.rail-item-current}` sage fill.

**`sidebar-panel`** — 236px parchment conversation directory: project switcher, search pill, thread rows, tags, footer.

**`flow-canvas`** — Sage-warm canvas for the project group chat: thread header on parchment, transcript, composer overlay.

**`context-panel`** — 304px parchment board: tabs, mission cards, approval overlay, memory cards.

**`button-primary`** — Sage fill, `{colors.on-primary}` label, `{rounded.md}`, 44px min height.

**`search-input`** — Pill on the directory; 44px min height.

## Do's and Don'ts

### Do
- Use `{colors.primary}` for every primary action and the current rail item.
- Keep sidebar/context on parchment and the flow on canvas.
- Keep 44×44 targets via `--control-min`.
- Raise `--text-subtle` rather than darkening canvas/panel/accent/rail if faint fails AA.

### Don't
- Don't introduce a second interactive accent (no purple, no blue buttons).
- Don't add gradients, glass, glow, or emoji icons.
- Don't hardcode hex in `app/*.css` outside `tokens.css`.
- Don't shrink `--control-min` to match the case’s 40px buttons.

## Responsive Behavior

| Name | Width | Key Changes |
|---|---|---|
| Narrow | ≤ 56.25rem | Existing drawers; rail stays 56px |
| Desktop | > 56.25rem | Four columns 56 / 236 / 1fr / 304 |

Touch targets remain 44×44. Narrow drawers keep `--sidebar-width` and `--context-width`.

## Iteration Guide

1. Change color only in this file’s YAML and `app/tokens.css`. Components consume `var(--token)`.
2. Never document hover as a second brand color; hover is `{colors.primary-focus}`.
3. Status surfaces may be recalculated for WCAG AA; status *hues* stay in the amber/green/terra/sage families.
4. Apple analysis lives at `product/ui/archive/apple-design-analysis.md` and is not the product contract.
