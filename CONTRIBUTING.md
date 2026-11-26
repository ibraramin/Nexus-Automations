# Contributing

Ground rules for changes to this repo. See [Architecture](docs/ARCHITECTURE.md)
for how the code fits together and [Usage](docs/USAGE.md) for command details.

## Branch workflow

- Work on a topic branch and open a pull request against `main`. Do not commit
  directly to `main`.
- CI's `verify` job runs on pushes to `main` and on `pull_request` events, so a
  branch gets the same checks before merge as `main` does after it.
- Keep one concern per change. Documentation-only changes should stay
  documentation-only; code changes should carry their tests.
- Do not rewrite `AGENTS.md`, `CLAUDE.md`, `CHANGELOG.md`, `state/` or
  `docs/activeContext.md` as part of an unrelated change.

## Definition of Done

Run from the repo root. Every command must exit 0:

```bash
npm ci                       # install exactly from package-lock.json
npm test                     # node --test: golden OCR tests + outbox tests
npm run build                # Next.js static export into out/
NEXUS_MOCK=1 npm run demo    # both flows end to end, offline
npx tsc --noEmit             # typecheck
npx eslint .                 # lint
```

Use Node 26 or newer (`engines.node >= 26.0.0` in `package.json`). The local
verification recorded in the README used Node 26.11.1, matching CI's
`node-version: "26"`.

## What CI checks

`.github/workflows/ci.yml` defines a single `verify` job on `ubuntu-latest`:

- `actions/checkout@v4`, then `actions/setup-node@v4` with Node 26 and npm cache.
- `npm ci`, `npm test`, `npm run build`.
- `npm run demo` with `NEXUS_MOCK: "1"` — the offline end-to-end walkthrough,
  which prints five steps and ends with `PASS`.

The `npx tsc --noEmit` and `npx eslint .` lines in the DoD block are local extras
from the README, not steps in the workflow. Reproduce the CI `demo` command
exactly: the script asserts `NEXUS_MOCK === "1"` and fails otherwise.

## Zero new dependencies

The test and demo tooling uses only what Node 26 ships: `node:test`,
`node:assert/strict`, `node:sqlite` and the built-in `fs`/`path`/`url` modules.
Do not add a test runner, assertion library, database package or other runtime
dependency for tests or demos. The parser in `lib/ocr-parser.ts` is intentionally
pure and dependency-free, and `lib/outbox.mjs` deliberately stays a plain `.mjs`
module because the installed `@types/node` is v20 and does not type
`node:sqlite`.

The site itself has its existing framework dependencies (`next`, `react`,
`react-dom`, `tesseract.js`) — do not introduce new ones without discussion.

## No credentials or env values

- `.env.example` is the only tracked env file and it lists **names only**. Never
  put a real value in it, and never commit a `.env` file or any provider token.
- The reserved names (`WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`,
  `WEBHOOK_VERIFY_TOKEN`, `OPENAI_API_KEY`) are unused by the current static
  export. Do not add secrets to CI or to the deploy config to make a demo work;
  the demos are designed to run offline with `NEXUS_MOCK=1`.
- The fake WhatsApp gateway is an in-memory array and the fake OCR adapter calls
  the parser directly. Keep it that way — no provider or HTTP calls in tests.

## Tests to add with changes

- **Parser changes:** add or update `tests/fixtures/*.txt` plus the matching
  `*.expected.json` golden (generated from the real `parseInvoiceText` output).
  `tests/ocr.test.mjs` deep-compares each golden and checks per-field confidence
  floors, so keep the fixture-count and positive/negative assertions in sync
  when you add a file. A negative fixture must be named with the `incomplete-`
  prefix to be treated as such.
- **Outbox changes:** add cases to `tests/outbox.test.mjs` — dedup, reply shape,
  ordered delivery, bounded retries, terminal `failed` rows, lease reclaim of
  stale `sending` rows, in-lease rows left alone, and file-backed restart.
  Inject a fake gateway with a `send(msg)` function; never call a real provider.
- Keep the demo in `scripts/demo.mjs` truthful if the observable flow changes:
  its five steps assert counts and a final `PASS`.

## Keep the README honest

The README's **Limitations (honest)** section is part of the contract: static
export only, no real API calls from the demos, a simulated WhatsApp bot,
heuristic confidence constants, at-least-once delivery, and browser-only OCR
upload. When a change makes one of those statements untrue, update the section
in the same change; when it does not, do not soften or delete the bullet. Do not
claim a pull request is open, a badge is pending, or a number you have not
measured from a command above.
