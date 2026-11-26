# Usage

Practical cookbook for the verifiable parts of this repo. All commands and
snippets match `package.json`, `lib/ocr-parser.ts`, `lib/outbox.mjs`, the tests
and `scripts/demo.mjs`.

## Definition of Done commands

Run from the repo root (the README "Verify in 2 minutes" block):

```bash
npm ci                       # install exactly from package-lock.json
npm test                     # node --test: golden OCR tests + outbox tests
npm run build                # Next.js static export into out/
NEXUS_MOCK=1 npm run demo    # both flows end to end, offline
npx tsc --noEmit             # typecheck
npx eslint .                 # lint
```

`npm test` is `node --test` with built-in `node:assert/strict` and
`node:sqlite`; no test runner or extra dependency was added. `package.json`
declares `engines.node >= 26.0.0`, and the README records local verification on
Node 26.11.1. CI installs Node 26 so `node --test` can strip TypeScript types
natively and `node:sqlite` is stable.

CI's `verify` job runs `npm ci`, `npm test`, `npm run build` and `npm run demo`
with `NEXUS_MOCK: "1"`; the `tsc` and `eslint` lines above are local extras from
the README block.

## Run locally

```bash
npm run dev      # next dev, http://localhost:3000
```

No mock flag is needed to view the site: demos use checked-in samples or run
tesseract.js in the browser. `NEXUS_MOCK=1` is only required by the demo script.

## The invoice parser

`lib/ocr-parser.ts` exports one function and three types:

```ts
type LineItem = { description: string; qty: number; unit: string; amount: number };
type ConfidenceKey = "vendor" | "invoiceNumber" | "date" | "totalEur" | "vatEur" | "lines";
type Extraction = {
  source: "sample" | "ocr" | "pasted"; vendor: string; invoiceNumber: string;
  date: string; totalEur: number; vatEur: number; vatRate: number;
  lines: LineItem[]; confidence: Record<ConfidenceKey, number>;
  validated: boolean; missing: string[];
};
function parseInvoiceText(text: string): Extraction;
```

Import through the `@/*` alias in app code, or the `.ts` path directly in a Node
26 test/script (the tests already do this):

```ts
// app / component code
import { parseInvoiceText, type Extraction } from "@/lib/ocr-parser";
// Node 26 test/script under tests/ instead:
// import { parseInvoiceText } from "../lib/ocr-parser.ts";
```

Example using a checked-in fixture (values below are the golden output in
`tests/fixtures/acme-invoice.expected.json`):

```js
import { readFileSync } from "node:fs";
import { parseInvoiceText } from "../lib/ocr-parser.ts";

const text = readFileSync("tests/fixtures/acme-invoice.txt", "utf8");
const r = parseInvoiceText(text);
r.vendor;          // "Acme Supplies GmbH"
r.invoiceNumber;   // "2026-0142"
r.date;            // "12.03.2026"
r.totalEur;        // 1485.12
r.vatRate;         // 19
r.lines.length;    // 2
r.validated;       // true
r.missing;         // []
r.confidence;      // { vendor: 92, invoiceNumber: 88, date: 90,
                   //   totalEur: 85, vatEur: 82, lines: 80 }
r.source;          // "ocr" (always)
```

The parser is pure: no network, filesystem or DOM access, deterministic for a
given string. Confidence values are fixed constants (only `lines` changes: 80
with line items, 0 without) — see the README limitations.

## Add an OCR fixture and its golden JSON

`tests/ocr.test.mjs` scans `tests/fixtures/*.txt` and pairs each with a
`*.expected.json` of the same basename. A file whose name starts with
`incomplete-` is a negative fixture; every other `.txt` is positive.

1. Add `tests/fixtures/my-invoice.txt` with the raw OCR-style text.
2. Produce `tests/fixtures/my-invoice.expected.json` from the real parser, e.g.
   with a one-off local script (not checked in):

   ```js
   import { readFileSync, writeFileSync } from "node:fs";
   import { parseInvoiceText } from "./lib/ocr-parser.ts";
   const name = "my-invoice";
   const text = readFileSync(`tests/fixtures/${name}.txt`, "utf8");
   const golden = parseInvoiceText(text);
   writeFileSync(`tests/fixtures/${name}.expected.json`, `${JSON.stringify(golden, null, 2)}\n`);
   ```

   The checked-in goldens use two-space indentation. Keep the generated file as
   the exact parser output: the test uses `assert.deepEqual`, so field order is
   irrelevant but every value matters (including `source: "ocr"`, the fixed
   confidence numbers and line descriptions that retain trailing spaces).
3. The suite currently asserts **3 fixtures: 2 positive + 1 negative**. Adding
   one means updating those count assertions in `tests/ocr.test.mjs` and, if the
   positive/negative mix changes, the test expecting one negative fixture with a
   missing `date`.

What the tests assert:

- `fixture set is 2 positive invoices + 1 negative invoice` — counts.
- `golden deep-equality: <name>` — `parseInvoiceText(text)` deep-equals the
  golden JSON for every fixture.
- `confidence floors: <name>` — for positive fixtures each confidence field is
  at least vendor 92, invoiceNumber 88, date 90, totalEur 85, vatEur 82, lines 80.
- `negative fixture is flagged for review` — `validated === false`,
  `missing.length > 0`, `missing` includes `"date"`, and `confidence.lines < 80`.

## Use the outbox with a fake gateway

`createOutbox(options)` returns `{ handleWebhook, flush, stats, close, db }`.
Options: `db` (default `new DatabaseSync(":memory:")`), `gateway` (required; must
have `send(msg)`), `buildReply` (default
`{ to: msg.from ?? "unknown", text: "Ack: " + (msg.text ?? "") }`), `maxAttempts`
(default 3), `now` (default `() => new Date().toISOString()`) and `leaseMs`
(default 30000). Pattern from `tests/outbox.test.mjs`:

```js
import { createOutbox } from "../lib/outbox.mjs";

function countingGateway() {
  const sent = [];
  return { sent, send: async (msg) => { sent.push(msg); } };
}
const webhook = (messageId, text = "hello") => ({
  messageId, from: "+10000000001", text,
});

const gateway = countingGateway();
const outbox = createOutbox({ gateway });
try {
  outbox.handleWebhook(webhook("msg-003", "ping"));
  // { status: "accepted", messageId: "msg-003", enqueued: true }
  outbox.handleWebhook(webhook("msg-003", "ping"));
  // { status: "duplicate", messageId: "msg-003", enqueued: false }
  await outbox.flush();
  // [{ id: 1, status: "sent", attempts: 1 }]
  gateway.sent;   // [{ to: "+10000000001", text: "Ack: ping" }]
  outbox.stats(); // { seen: 1, outbox: { sent: 1 } }
} finally {
  outbox.close();
}
```

A gateway that fails twice then succeeds (default bound of three):

```js
let calls = 0;
const flaky = {
  sent: [],
  send: async (msg) => {
    calls += 1;
    if (calls <= 2) throw new Error("temporary outage");
    flaky.sent.push(msg);
  },
};
const outbox = createOutbox({ gateway: flaky, maxAttempts: 3 });
// handleWebhook(webhook("msg-004", "retry me"))
// flush #1 -> { id: 1, status: "pending", attempts: 1, error: "temporary outage" }
// flush #2 -> { id: 1, status: "pending", attempts: 2, error: "temporary outage" }
// flush #3 -> { id: 1, status: "sent", attempts: 3 }
```

For durability across a restart, pass a file-backed database (the test uses a
temporary directory and deletes it afterwards):

```js
import { DatabaseSync } from "node:sqlite";
const outbox = createOutbox({ db: new DatabaseSync("./outbox.sqlite"), gateway });
```

The outbox tests also cover stale `sending` rows reclaimed after the lease, rows
still inside their lease left alone, a crash on the final attempt becoming
`failed`, and a reopened database preserving dedup and queued rows. Delivery is
at-least-once; see the README limitations.

## Run and read the offline demo

```bash
NEXUS_MOCK=1 npm run demo
```

`scripts/demo.mjs` prints five numbered steps:

1. **Mock guard** — asserts `NEXUS_MOCK === "1"`; without it the script exits non-zero.
2. **Seed fixtures** — reads the three sorted `.txt` files through
   `{ recognize: async (text) => parseInvoiceText(text) }`, prints invoice number,
   vendor, EUR total, confidence tuple and status, and asserts two are validated.
3. **Negative fixture flagged** — finds the unvalidated extraction, asserts
   missing fields and prints which ones.
4. **Dedup + outbox** — the fake gateway throws once on its first `send`; three
   webhooks are accepted and a repeated id returns `duplicate`. Replies are
   `{ to: msg.from, text: "Nexus ack: " + msg.text }`.
5. **Flush** — the first flush absorbs the outage (one row returns to `pending`),
   the second sends everything. It asserts three messages in `sent`, zero
   `failed` and three `sent` rows, then prints `PASS — both flows verified offline
   (mock mode, zero credentials, zero network)`.

On a failed assertion it prints `FAIL — <message>` and sets a non-zero exit code.
No credentials, network requests or OCR worker are used.

## Environment variable names

Names only — no values are committed, and `.env.example` is the only tracked env
file (other `.env*` files are ignored). The full list in `.env.example` is:

| Name | Needed locally? | Purpose in this repo |
| --- | --- | --- |
| `NEXUS_MOCK` | Only for `npm run demo` | Demo asserts it equals `"1"` and switches to the in-memory adapters. |
| `WHATSAPP_ACCESS_TOKEN` | No | Reserved name; unused by the current code. |
| `WHATSAPP_PHONE_NUMBER_ID` | No | Reserved name; unused by the current code. |
| `WEBHOOK_VERIFY_TOKEN` | No | Reserved name; unused by the current code. |
| `OPENAI_API_KEY` | No | Reserved name; unused by the current code. |

There are no other env names read by the code described here.
