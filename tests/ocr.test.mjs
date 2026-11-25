import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseInvoiceText } from "../lib/ocr-parser.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "fixtures");

const fixtureTxt = readdirSync(fixturesDir).filter((name) => name.endsWith(".txt")).sort();
const positiveFixtures = fixtureTxt.filter((name) => !name.startsWith("incomplete-"));
const negativeFixtures = fixtureTxt.filter((name) => name.startsWith("incomplete-"));

const readFixture = (name) => readFileSync(join(fixturesDir, name), "utf8");
const readGolden = (name) =>
  JSON.parse(readFileSync(join(fixturesDir, name.replace(/\.txt$/, ".expected.json")), "utf8"));

// Measured by running parseInvoiceText over all positive fixtures on 2026-11-25.
// The parser assigns fixed per-field scores; `lines` is the only data-dependent
// score (80 with line items, 0 without). These are floors, not aspirations.
const MEASURED_MIN_CONFIDENCE = {
  vendor: 92,
  invoiceNumber: 88,
  date: 90,
  totalEur: 85,
  vatEur: 82,
  lines: 80,
};

test("fixture set is 2 positive invoices + 1 negative invoice", () => {
  assert.equal(fixtureTxt.length, 3, "unexpected fixture count");
  assert.equal(positiveFixtures.length, 2);
  assert.equal(negativeFixtures.length, 1);
});

for (const name of fixtureTxt) {
  test(`golden deep-equality: ${name}`, () => {
    assert.deepEqual(parseInvoiceText(readFixture(name)), readGolden(name));
  });
}

for (const name of positiveFixtures) {
  test(`confidence floors: ${name}`, () => {
    const { confidence } = parseInvoiceText(readFixture(name));
    for (const [field, floor] of Object.entries(MEASURED_MIN_CONFIDENCE)) {
      assert.ok(
        confidence[field] >= floor,
        `${field} confidence ${confidence[field]} is below measured floor ${floor}`,
      );
    }
  });
}

test("negative fixture is flagged for review", () => {
  assert.equal(negativeFixtures.length, 1);
  const result = parseInvoiceText(readFixture(negativeFixtures[0]));
  assert.equal(result.validated, false);
  assert.ok(result.missing.length > 0, "missing fields must be reported");
  assert.ok(result.missing.includes("date"));
  assert.ok(
    result.confidence.lines < MEASURED_MIN_CONFIDENCE.lines,
    "a fixture with no line items must score below the positive floor",
  );
});
