# Northlight client app

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Next.js 16 (App Router) on Vercel, React 19, Tailwind CSS 4, Lucide icons, Manrope, Inter and Geist Mono. Supabase for
sign-in (6-digit email code) and the access table. The agent (Cloudflare Workers, `../agent` in this repository) is the
backend for everything the employees do.

## Users

People at Northlight's client businesses (small local businesses; the first is Kestrel Garage in Milbrook) who work
with the AI employees Northlight set up for them: an owner or manager who decides what an employee may do, and staff who only
ask it for work. Northlight admins also use the app to decide who has access and to decide requests nobody else may.

## Product Purpose

Answer one question each time someone opens it: what did my team do, and what needs me? It shows each AI employee's
recent work, the requests waiting on the person's decision, a chat to ask the employee for work, what the employee needs to
work, and what it has learned. Success is a person deciding a waiting request in under a minute, knowing exactly what
approving does, and never seeing someone else's request or chat.

## Positioning

The employees do real work in the business's own systems (Iris reads the live website and drafts page titles and
descriptions), and nothing that changes the outside world happens without a named person's decision in this app. Every
request says what it changes, who asked, and what approving records.

## Operating Context

- One app per client set, configured by `AGENT_CLIENTS`; Kestrel Garage (a fictional demo business) first.
- Access is per person, per employee: Uses, Approves, Manages. Northlight admins set it on the People page; the app sends the
  approver and manager lists to the agent after every change.
- A chat message becomes a background job in the agent; the app follows its real steps and shows when it waits for a
  decision. People close the tab and come back.
- Times are shown in UK time (every current client is there).

## Capabilities and Constraints

- In scope: sign-in, team page, employee desk (Overview, Requests, Setup, Learned), chat with job progress, approve,
  decline with a reason, ask for a new draft (Iris's copy), keep or remove lessons, People page for Northlight admins.
- Out of scope for v1: voice calls, media uploads, leads, other employees' special panels, editing an
  employee's settings, invitation emails (the admin tells the person where to sign in).
- Requests are private to the person who asked and to Northlight admins; requests nobody asked for in the app are admin-only.
- Terminology: "AI employee", never "agent", "bot" or "chatbot". An employee is called by name or "it".

## Brand Commitments

Northlight: charcoal with teal accents (teal ink on light, bright teal on dark), cool neutrals and four state colours;
the Northlight mark (a four-point north star in teal beside the wordmark) and its signature motion (a slow twinkle, then
a long rest). Type is Manrope for headings and Inter for everything else, with Geist Mono for literal strings.
Voice: plain, careful, no exclamation marks; bad news says what happened, then what happens next. Never "seamless" or
"AI-powered".

## Evidence on Hand

- `DESIGN.md` for the palette, type and components.
- The agent's documented contracts (`../agent/docs/reference.md`) and Iris's tools.
- No client testimonials, metrics or case studies exist; never invent them. Sample data in `scripts/fake-world.mjs` is
  labelled "Sample:" and must never ship as real content.

## Product Principles

1. What needs the person comes first, in words; a count alone never stands for a decision.
2. Say exactly what approving does and what it does not (approved copy is recorded for the website team, not published).
3. Private by default: a person sees their own requests and chat; admins see the rest.
4. Never claim progress the brain did not report; an outage looks like an outage, never like an empty list.
5. Plain words over features: v1 does the core job for one business well.

## Accessibility & Inclusion

WCAG 2.2 AA: text at least 4.5:1, controls and focus at least 3:1, 44 px touch targets, full keyboard use (tabs with
arrow keys, dialogs that keep focus), status as a dot plus a word, reduced motion respected, announcements for job events
and decisions.
