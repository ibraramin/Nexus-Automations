#!/usr/bin/env node
/**
 * Offline end-to-end demo of both Nexus flows.
 *
 * NEXUS_MOCK=1 is required. No credentials, no network, no tesseract.js worker:
 * the OCR adapter is an in-memory parser call over checked-in fixtures and the
 * WhatsApp gateway is an in-memory array. The outbox itself is real
 * node:sqlite code, running against an in-memory database.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createOutbox } from "../lib/outbox.mjs";
import { parseInvoiceText } from "../lib/ocr-parser.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixturesDir = join(root, "tests", "fixtures");
const eur = (n) => `EUR ${n.toFixed(2)}`;

function step(n, total, label) {
  console.log(`[${n}/${total}] ${label}`);
}

function detail(label, value) {
  console.log(`    ${label}: ${value}`);
}

async function main() {
  const total = 5;
  step(1, total, "mock guard — no credentials, no network");
  assert.equal(process.env.NEXUS_MOCK, "1", "run this demo as: NEXUS_MOCK=1 npm run demo");
  detail("adapters", "fake OCR (in-memory parser) + fake WhatsApp gateway (in-memory array)");

  step(2, total, "seed invoice fixtures through the fake OCR adapter");
  const fakeOcr = { recognize: async (text) => parseInvoiceText(text) };
  const files = readdirSync(fixturesDir).filter((name) => name.endsWith(".txt")).sort();
  assert.equal(files.length, 3);
  const extractions = [];
  for (const name of files) {
    const extraction = await fakeOcr.recognize(readFileSync(join(fixturesDir, name), "utf8"));
    extractions.push(extraction);
    const c = extraction.confidence;
    detail(
      name,
      `${extraction.invoiceNumber} · ${extraction.vendor} · ${eur(extraction.totalEur)} · ` +
        `confidence ${c.vendor}/${c.invoiceNumber}/${c.date}/${c.totalEur}/${c.vatEur}/${c.lines} · ` +
        `${extraction.validated ? "validated" : "needs review"}`,
    );
  }
  assert.equal(extractions.filter((e) => e.validated).length, 2);

  step(3, total, "negative fixture flagged for review");
  const negative = extractions.find((e) => !e.validated);
  assert.ok(negative && negative.missing.length > 0);
  detail("flagged fields", negative.missing.join(", "));

  step(4, total, "webhook dedup + durable outbox (in-memory SQLite)");
  let sendCalls = 0;
  const fakeWhatsApp = {
    sent: [],
    async send(msg) {
      sendCalls += 1;
      if (sendCalls === 1) throw new Error("injected transient WhatsApp outage");
      this.sent.push(msg);
    },
  };
  const outbox = createOutbox({
    gateway: fakeWhatsApp,
    buildReply: (msg) => ({ to: msg.from, text: `Nexus ack: ${msg.text}` }),
  });
  const webhookFor = (e) => ({
    messageId: `invoice:${e.invoiceNumber}`,
    from: "+10000000001",
    text: `${e.invoiceNumber} · ${eur(e.totalEur)} · ${e.validated ? "validated" : "needs review"}`,
  });
  let accepted = 0;
  let duplicates = 0;
  for (const e of extractions) {
    if (outbox.handleWebhook(webhookFor(e)).status === "accepted") accepted += 1;
  }
  if (outbox.handleWebhook(webhookFor(extractions[0])).status === "duplicate") duplicates += 1;
  assert.equal(accepted, 3);
  assert.equal(duplicates, 1);
  detail("webhooks", `${accepted} accepted, ${duplicates} duplicate ignored`);

  step(5, total, "flush replies through the fake gateway, retry the injected failure");
  try {
    const first = await outbox.flush();
    detail("flush #1", first.map((r) => `#${r.id}:${r.status}/${r.attempts}`).join(" "));
    const second = await outbox.flush();
    detail("flush #2", second.map((r) => `#${r.id}:${r.status}/${r.attempts}`).join(" "));
    const stats = outbox.stats();
    detail("outbox", JSON.stringify(stats.outbox));
    assert.equal(fakeWhatsApp.sent.length, 3);
    assert.equal(stats.outbox.failed ?? 0, 0);
    assert.equal(stats.outbox.sent, 3);
  } finally {
    outbox.close();
  }

  console.log("PASS — both flows verified offline (mock mode, zero credentials, zero network)");
}

main().catch((err) => {
  console.error(`FAIL — ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
