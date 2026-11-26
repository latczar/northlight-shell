# Iris staff evaluation

Use the sandbox Services call supplied by the test fixtures. Use a separate QA handset and draft when testing a real provider. Record which parts used fixtures, which used a deployed preview, and which used a physical phone.

| Case | What staff do | Pass condition |
| --- | --- | --- |
| Sign in | Open a saved call signed out. Sign in, including after an interrupted code submission. | The original destination opens. A signed-out visitor sees no transcript. |
| Return from email | Request a code, switch away past the cooldown, then enter a wrong code and recover with the newest one. | Resend uses elapsed time. Successful sign-in returns to the original filtered History page. |
| Call from the desk | Open Iris’s desk as an enrolled caller on phone and desktop. | The phone link uses the same Iris line as History. The full number is readable for a manual call. |
| Caller isolation | Two staff open History on desktop and mobile. Try an old call from before a handset was assigned. | Each sees only their own eligible calls. The direct link enforces the same rule. |
| Find a call | Search by mixed-case topic and UK date. Clear a search that found nothing. | The correct transcript is readable. An empty result and an unavailable provider have different messages. |
| Interrupted search | Lose a later page of results or a single transcript. Retry. | Verified matches stay visible. Retry starts with the missing batch, keeps the filters and checks handset ownership again. |
| Persistent transcript outage | Retry a failing transcript, then search older calls on desktop and mobile. | Both links preserve the topic and date. Staff can read their older calls while the first transcript is unavailable. |
| Draft recovery | Open a saved draft during a temporary transcript outage. Click Try again. | The same draft URL fetches the transcript again and restores the review screen. |
| Clock change | Search the Sunday when UK clocks go back. | Both 01:30 calls appear with BST or GMT. Adjacent calendar days are excluded. |
| Start a draft | Open the same Services call on two devices and select Create draft concurrently. Also try a call where only Iris mentions Services. | Both devices open one draft for the caller's request. An hours-only call offers no new Services draft. |
| Review evidence | Compare the proposed wording with the inspected page, including apostrophes, ampersands and nested heading text. | Current wording matches what the browser displays. Older proposals and feedback keep their original text. |
| Request changes | Enter feedback on desktop, reconnect, and submit. Open the revision on mobile. | Unsent feedback survives reconnection. The revision links to the original wording, feedback and call. |
| Two rewrites | Decline an original on desktop, then ask for another change on mobile. Approve the second revision. | The final wording, first draft and both rounds of feedback remain accessible after reload. |
| Competing decisions | Use an old tab to approve after the draft has been revised. Then approve the current revision on mobile. | The old tab shows the current revision. Only the chosen revision records an approval. |
| Recover a lost reply | Interrupt a retry after the server has accepted it. Reopen the same call. | The same approved revision and original feedback return. Approval never publishes website copy. |
| Mobile recovery | Go offline, reload, reconnect, rotate or change width, then return to History. | The same saved review appears, with one history entry and readable controls. |

## Spoken answer evaluation

Ask Iris, “Which wording on Services would you review first for search, and why? Keep the design as it is.” Score the actual reply and the tool results separately.

| Check | Pass condition |
| --- | --- |
| Identity | Introduces itself as Kestrel Garage’s website manager and SEO agent. |
| Page evidence | Quotes the title or heading accurately and identifies which one it is. A successful page read supports the claim. |
| Reason | Explains which service a customer could recognise in the search result. Avoids ranking promises and unsupported claims about ranking factors. |
| Scope | Suggests a wording change grounded in the page. Preserves the approved design and leaves implementation for staff review. |
| End call | After “Please end this call now,” the provider reports a completed inbound call. Check the termination event when testing who actually ended it. |
| Traceability | Find that same call by its topic and UK date. Verify its identifier, caller turns and revision on both devices. |

Google explains that several sources can contribute to a search result’s title link. [Google Search Central guidance](https://developers.google.com/search/docs/appearance/title-link)

## How to run

- In `console`, run `npm run typecheck`, `npm run lint`, `npm test` and `npm run test:e2e`. The Playwright suite uses isolated services, desktop Chromium and mobile WebKit.
- In `agent`, run `npm run check` for the Worker suites and deployment dry runs. The page-inspection and editorial archive cases are in `test/iris.test.ts` and `test/iris-editorial.test.ts`.
- To reproduce the call-draft order check in `agent`, run `npx vitest run test/iris-call-draft.test.ts --sequence.shuffle --sequence.seed=251`.
- For the voice-to-History check, place a fresh inbound QA call, record its time and topic, hang up, and find the same transcript on both devices. A replay checks display and recovery. A fresh call checks the carrier and transcription path.
