# Nexus Automations — verifiable showcase site

**Custom n8n + AI automation for WhatsApp, web, email and phone — with the core logic backed by offline, repeatable tests and a two-minute demo.**

[![CI](https://github.com/ibraramin/automation-portfolio/actions/workflows/ci.yml/badge.svg)](https://github.com/ibraramin/automation-portfolio/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-2ea44f.svg)](LICENSE)
[![Node >= 26](https://img.shields.io/badge/Node-%3E%3D26-339933.svg)](https://nodejs.org/)
[![Release: v0.2.0](https://img.shields.io/badge/release-v0.2.0-blueviolet.svg)](https://github.com/ibraramin/automation-portfolio/releases)

![Nexus Automations — live desktop home page](docs/assets/nexus-hero-desktop.png)

Client-facing showcase for **Nexus Automations**: custom n8n + AI automation across
WhatsApp, web, email and phone. This repository is the interactive front end. The
point of the verifiability pass is that the interesting logic is no longer only
behind a browser click: the invoice parser and the webhook/outbox have real,
offline, repeatable tests, plus a one-command demo that exercises both flows.

> Prior pivot context: the unified `00-omni-chat-core` build and specs 01–10 are
> tracked in `docs/specs/Omni-Unified-Spec.md`, `docs/plans/Omni-Unified.md` and
> `blueprints/README.md`. This README describes this repo as it exists today.

![Nexus mock demo — recorded offline end-to-end run](docs/assets/nexus-demo.gif)

`NEXUS_MOCK=1 npm run demo` prints five numbered steps: mock guard, fixture
seeding through the fake OCR adapter, negative-fixture flagging, dedup +
outbox, and a flush with one injected transient gateway failure. It ends with
`PASS` and a non-zero exit on any failed assertion.

## Verify in 2 minutes

Everything below runs offline, with no provider token, no external HTTP request
(the e2e tests serve `out/` on loopback) and no n8n execution.

```bash
npm ci                       # install exactly from package-lock.json
npm test                     # node --test: 7 golden OCR + 12 outbox tests (19 pass)
npm run build                # Next.js static export into out/
npx playwright test          # 2 chromium e2e tests against out/ (needs build first)
NEXUS_MOCK=1 npm run demo    # both flows end to end, offline
npx tsc --noEmit             # typecheck
npx eslint .                 # lint
```

Local development and deployment:

```bash
npm run dev      # http://localhost:3000
npm run deploy   # npm run build && wrangler deploy (static assets from out/)
```

`npm test` uses Node's built-in runner (`node --test`) and built-in assertions
and `node:sqlite`; no third-party runner was added for the unit suites.
`@playwright/test` (pinned 1.63.0, dev-only) was added solely for the browser
e2e checks against the static export; it is not used by `npm test`. CI pins
**Node 26**, matching the runtime used to verify this repo, because that gives
native TypeScript type stripping in `node --test` and stable `node:sqlite`.
`package.json` therefore declares `engines.node >= 26` (earlier Node versions
cannot run these tests). Local verification ran on Node 26.11.1.

## Architecture

```mermaid
flowchart LR
    W["webhook / API message"] --> OCR["OCR parser<br/>lib/ocr-parser.ts"]
    OCR --> J["structured JSON<br/>Extraction"]
    J --> OB["durable outbox<br/>lib/outbox.mjs + node:sqlite"]
    OB --> WA["WhatsApp fake gateway<br/>in-memory"]
    M["mock adapters<br/>NEXUS_MOCK=1"] -. feeds fixture text .-> OCR
    M -. receives sent messages .-> WA
```

In the shipped website the OCR text comes from tesseract.js in the browser. In
tests and in the demo the *same* parser consumes checked-in text fixtures
through an in-memory fake OCR adapter. Replies are queued in a real SQLite
outbox and delivered to an injected fake WhatsApp gateway — no provider token,
no HTTP request, no n8n execution.

## Features

The verifiable core, file by file:

- `lib/ocr-parser.ts` — pure `parseInvoiceText(text): Extraction`, extracted
  from `components/demos/InvoiceReader.tsx` (the component now imports it).
- `tests/fixtures/*.txt` — **3 fixtures**: 2 positive invoices (Acme,
  TechParts) and 1 negative invoice (`incomplete-invoice.txt`, missing date).
- `tests/fixtures/*.expected.json` — checked-in golden outputs, deep-equality
  compared for every fixture.
- `tests/ocr.test.mjs` — golden tests, measured per-field confidence floors
  (vendor 92, invoice # 88, date 90, total 85, VAT 82, lines 80) and an
  explicit "negative fixture is flagged" assertion.
- `lib/outbox.mjs` + `tests/outbox.test.mjs` — SQLite dedup/outbox with an
  injected gateway: duplicate ids ignored, replies queued, bounded retries,
  permanent failures marked `failed`, and a file-backed restart test.
- `scripts/demo.mjs` — the offline end-to-end walkthrough described above.
- `playwright.config.ts` + `e2e/home.spec.ts` — 2 chromium e2e tests run against
  the **shipped static export**: Playwright's webServer serves `out/` over
  loopback with `python3 -m http.server` (no live URL, server route or real API
  call; run `npm run build` first). They assert the H1 and both hero CTAs and
  that the stat counters read `<0 min`/`0 wks` before scrolling and settle to
  `<5 min`/`2 wks` afterwards — verifying that the shipped scroll-triggered
  animation is correct (not a defect fix).
- `lib/outbox.mjs` `stats()` — alongside the durable `outbox` rows, returns an
  in-process `counters` object (`accepted`, `duplicate`, `enqueued`, `sent`,
  `failed`, `attempts`) tracked via the injected fake gateway; no hosted
  collector and no real provider calls. These counters reset on reopen.

## Results at a glance

| Area | Verified result |
| --- | --- |
| Tests | **19/19 pass** — 7 golden OCR + 12 outbox tests (`node --test`) |
| E2E | **2/2 Playwright chromium tests** pass against the static export (`out/`) served over loopback |
| Build | **15/15 static pages generated** into `out/` |
| Demo | Ends with **PASS**; **3 replies sent** |
| Fixtures | 3: Acme, TechParts (positive) and `incomplete-invoice.txt` (negative) |
| Confidence floors | vendor 92 · invoice # 88 · date 90 · total 85 · VAT 82 · lines 80 (lines 0 when absent) |
| Outbox | `maxAttempts` 3 · dedup via `seen_messages` primary key · stale-sending lease reclaim · injected fake gateway |
| Stack | Next.js 16.3.0 · React 19 · TypeScript strict |
| Runtime | Node >= 26 (native TS stripping + `node:sqlite`); verified on Node 26.11.1 |
| Dependencies | One pinned dev-only test dependency, `@playwright/test` 1.63.0; no runtime dependency added (Chromium already cached; no browser-install step in the verified run) |
| License | MIT |

## Environment variables

Names only — no values are committed, and `.env.example` is the only tracked
env file (`.env*` is otherwise ignored).

| Name | Needed locally? | Purpose |
| --- | --- | --- |
| `NEXUS_MOCK` | Only for `npm run demo` | Switches to in-memory OCR/gateway adapters; the command above sets it. |
| `WHATSAPP_ACCESS_TOKEN` | No | Reserved name for a future integration; unused here. |
| `WHATSAPP_PHONE_NUMBER_ID` | No | Reserved name; unused here. |
| `WEBHOOK_VERIFY_TOKEN` | No | Reserved name; unused here. |
| `OPENAI_API_KEY` | No | Reserved name; unused here. |

## Structure

```
app/                       # Home, services, demos, contact, privacy
components/demos/          # WhatsAppOrderBot, InvoiceReader, and other demos
lib/demos.ts               # Demo registry
lib/ocr-parser.ts          # Pure invoice extraction (tested)
lib/outbox.mjs             # SQLite dedup + outbox (tested)
tests/                     # node:test suites + fixtures/goldens
playwright.config.ts       # chromium e2e config: serves out/ over loopback
e2e/                       # Playwright static-site e2e specs
scripts/demo.mjs           # NEXUS_MOCK=1 end-to-end demo
public/downloads/          # n8n workflow JSON lead magnets (static data)
blueprints/                # Service spec sheets / example workflow JSON
docs/plans, docs/specs     # Repo and feature specs
```

## Deploy

The site is a fully static export (`output: "export"` in `next.config.ts`).
`next build` writes plain HTML/CSS/JS into `out/`, and `wrangler.jsonc` serves
that directory as Cloudflare Workers assets. There is no Node server, so
`npm run start` is not usable with this export; preview with any static file
server (for example `npx serve out`).

## Limitations (honest)

- **Static export only.** No `app/api` routes and no server runtime can be
  added without changing the deployment model.
- **No real API calls.** The contact form posts to Web3Forms with a mailto
  fallback; the demos do not call OpenAI, WhatsApp, bKash or Pathao. The n8n
  JSON under `public/downloads/` and `blueprints/` is static downloadable
  data, not code executed by this repo.
- **WhatsApp bot is a simulation.** `components/demos/WhatsAppOrderBot.tsx`
  is a client-side state machine with `setTimeout` and fake bKash/Pathao
  steps. The demo's gateway is an in-memory array, not a WhatsApp client.
- **Confidence numbers are heuristic constants**, not calibrated model
  probabilities: all fields report fixed scores, and `lines` drops to 0 when
  no line items were found. They are useful as a regression signal, not as a
  measure of extraction correctness.
- **At-least-once delivery.** The outbox retries after gateway errors; a
  gateway that sends and then throws could be delivered twice. A production
  integration would need provider idempotency keys.
- **OCR upload is browser-only.** tesseract.js is lazy-loaded client side;
  the Node tests never invoke an OCR engine.
- **E2E scope and metrics are local.** Playwright covers the static export only
  (no live URL or server runtime), and outbox `counters` are in-process values
  from the injected fake gateway, not a hosted collector. The counters'
  zero-to-final animation on scroll was verified as shipped behavior — it was
  not a defect that needed fixing.

## Documentation

- [Architecture](docs/ARCHITECTURE.md) — static export, OCR and outbox flows, state model, file map.
- [Usage](docs/USAGE.md) — local commands, fixtures, parser and outbox cookbook, offline demo.
- [Deployment](docs/DEPLOYMENT.md) — static build, Cloudflare Workers assets, preview, Node/CI parity.
- [Contributing](CONTRIBUTING.md) — branch workflow, DoD commands, CI checks and rules.

## License

MIT — see [LICENSE](LICENSE). Copyright (c) 2026 Ibrar Amin.
