---
name: Northlight client app
description: What your AI employees did, and what needs you.
colors:
  ground: "#f6f8f8"
  card: "#ffffff"
  ink: "#1f2328"
  ink-2: "#4a545d"
  ink-3: "#5b6670"
  rule: "#dde3e6"
  rule-strong: "#7d878f"
  teal-ink: "#0f766e"
  teal: "#14b8a6"
  teal-tint: "#e6f6f4"
  charcoal: "#16191d"
  charcoal-card: "#1f2328"
  charcoal-raised: "#262b31"
  charcoal-inset: "#111417"
  bright-teal: "#2dd4bf"
  ok: "#157a51"
  ok-dot: "#1f9d6b"
  warn: "#855700"
  warn-dot: "#e0a73a"
  danger: "#b53939"
  danger-dot: "#cf4b4b"
  quiet-dot: "#6b7680"
typography:
  display:
    fontFamily: "Manrope, Inter, Helvetica Neue, Arial, sans-serif"
    fontSize: "1.75rem"
    fontWeight: 600
    lineHeight: "2.125rem"
    letterSpacing: "-0.02em"
  heading:
    fontFamily: "Manrope, Inter, Helvetica Neue, Arial, sans-serif"
    fontSize: "1.25rem"
    fontWeight: 600
    lineHeight: "1.75rem"
  title:
    fontFamily: "Inter, Helvetica Neue, Arial, sans-serif"
    fontSize: "1rem"
    fontWeight: 600
    lineHeight: "1.5rem"
  body:
    fontFamily: "Inter, Helvetica Neue, Arial, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: "1.5rem"
  small:
    fontFamily: "Inter, Helvetica Neue, Arial, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: "1.25rem"
  label:
    fontFamily: "Inter, Helvetica Neue, Arial, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 500
    lineHeight: "1rem"
  mono:
    fontFamily: "Geist Mono, ui-monospace, Menlo, monospace"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: "1rem"
rounded:
  input: "4px"
  card: "8px"
  dialog: "12px"
  pill: "9999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "16px"
  lg: "24px"
  xl: "40px"
components:
  button-primary:
    backgroundColor: "{colors.teal-ink}"
    textColor: "{colors.card}"
    rounded: "{rounded.pill}"
    padding: "0 16px"
    height: "40px"
  button-secondary:
    backgroundColor: "{colors.card}"
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
    padding: "0 16px"
    height: "40px"
  card:
    backgroundColor: "{colors.card}"
    textColor: "{colors.ink}"
    rounded: "{rounded.card}"
    padding: "24px"
  input:
    backgroundColor: "{colors.ground}"
    textColor: "{colors.ink}"
    rounded: "{rounded.input}"
    height: "40px"
  top-bar:
    backgroundColor: "{colors.charcoal}"
    textColor: "{colors.card}"
    height: "64px"
---

# Northlight client app: design

## Overview

**Creative North Star: "The quiet control room"**

A calm, light workspace under a charcoal bar, where the one bright thing is what needs you. The Northlight mark, a
four-point north star, sits at the centre of the team page: the business is the ring, its AI employees sit on the orbit,
and the star twinkles now and then. Everything else is paper-quiet: cool neutrals, one accent, status as a dot plus a word.

Dark mode is charcoal, not light inverted: a charcoal ground, elevation by surface colour, bright teal as the accent with
charcoal type on it.

**Key Characteristics:**

- One accent per theme: teal ink on light, bright teal on dark. The only full teal on a light screen is the north star.
- Charcoal appears in the top bar, the avatars and the sign-in cover only.
- No shadows, no glass, no gradients: elevation is surface colour.
- Words carry state; colour only repeats it.

## Colors

### Primary

- **Teal ink** (`#0f766e`): buttons, links, focus, counts on light. White type on it reaches 5.4:1.
- **Teal** (`#14b8a6`): the north star only. Never text.
- **Bright teal** (`#2dd4bf`): the accent on dark surfaces, always with charcoal type on it (9.5:1).

### Neutral

- **Ground** `#f6f8f8`, **card** `#ffffff`, **rule** `#dde3e6`, **rule-strong** `#7d878f` (3.4:1, for control borders).
- **Ink** `#1f2328`, **ink-2** `#4a545d`, **ink-3** `#5b6670` (5.5:1, the lightest text allowed).
- **Charcoal** `#16191d` with **card** `#1f2328`, **raised** `#262b31` and **inset** `#111417` for the dark theme's
  surfaces.

### Named Rules

**The One Star Rule.** On a light screen the only full teal is the north star; everything interactive uses the darker
teal ink.

**The Dot-and-Word Rule.** Every status is a coloured dot plus a word ("Needs you", "Done", "Problem"); colour is never the
only signal. Dots use the state colours; their words use the darker text variants (ok `#157a51`, warn `#855700`, danger
`#b53939`).

## Typography

Manrope for page titles and headings, Inter for everything else you read, Geist Mono only for literal strings
(addresses, character counts, codes).

### Hierarchy

- **Display** 28/34, 600, -0.02em: one page title per page.
- **Heading** 20/28, 600: sections and dialogs.
- **Title** 16/24, 600: an item's name (a request, a piece of work, a lesson).
- **Body** 16/24: prose and every form field, so a phone never zooms on focus.
- **Small** 14/20: values, hints, buttons and tabs (500 to 600 for controls).
- **Label** 12/16, 500 and **Meta** 12/16 tabular: keys, table heads, times and counts. Nothing is smaller than 12 px.

### Named Rules

**The Sentence Case Rule.** Labels, buttons and headings are sentence case; no eyebrow or kicker labels above headings.

## Layout

A 1264 px column under the bar. The team page pairs the orbit (left, sticky) with Needs you and Recent work. An employee's
desk keeps its disc and the chat button in a left column and the tabs on the right; from 1280 px the chat opens as a third
column, below that it covers the desk. Under 640 px everything stacks, the orbit shrinks, and the desk's four tabs sit in a
two-by-two grid. Panels narrower than 36rem stack their rows (container queries).

## Elevation & Depth

Flat. Cards are white on the ground with a 1 px rule; the dark theme steps charcoal, card, raised and inset. Dialogs sit
on a charcoal scrim. No shadows anywhere.

## Shapes

Pills on buttons, tabs and counts only. Inputs 4 px, cards 8 px, dialogs 12 px. Avatars and the employee disc are
circles. The orbit's rings are 1 px hairlines at 10 to 22 % ink.

## Components

### Buttons

Primary (one per view): teal ink pill, white type. Secondary: outlined pill. Danger: red outline. Ghost: no border.
40 px tall, 44 px where a finger is the pointer. Busy buttons spin and say what they are doing at the same width.

### Cards / Containers

White, 1 px rule, 8 px radius, 16 to 24 px padding. Lists are one card with a rule between rows, never a box per row.

### Inputs / Fields

40 px (44 px on touch), 4 px radius, a 1 px rule-strong border on the inset colour; label above, hint below, error in
words under the field with an icon.

### Navigation

The charcoal bar (56 px on phones, 64 px from 768 px) holds the lockup, the business name and the sections (Team, People for
admins), with the account menu on the right. Desk tabs are pills with a count badge whose meaning is spoken to screen
readers.

### The Orbit (signature)

Three faint rings with a few drifting nodes around the Northlight mark. On the team page the employees sit on the outer ring and
their words sit outward, never across a ring. On a desk the employee's disc is a card-coloured circle that covers the inner
ring. Still under reduced motion.

## Do's and Don'ts

### Do:

- Do say what approving does and what it does not.
- Do show load failures as failures with Try again, never as an empty list.
- Do keep every count next to words that say what it counts.

### Don't:

- Don't use shadows, glass, glow or gradient text.
- Don't put full teal on a light surface outside the north star.
- Don't call an employee an agent, bot or chatbot, or use exclamation marks.
