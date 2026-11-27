/**
 * Durable, dependency-free webhook dedup + outbox using node:sqlite.
 *
 * This is intentionally transport-agnostic: a fake gateway is injected, so the
 * whole flow runs offline. With a file-backed DatabaseSync the seen-message
 * dedup and queued replies survive a process restart; with `:memory:` it is all
 * in-process (used by the unit tests).
 *
 * Delivery is at-least-once: if a gateway throws after actually delivering,
 * the row is retried. Real providers would need idempotency keys.
 */

import { DatabaseSync } from "node:sqlite";

const DEFAULT_MAX_ATTEMPTS = 3;

export function createOutbox(options = {}) {
  const {
    db = new DatabaseSync(":memory:"),
    gateway,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    buildReply = (msg) => ({ to: msg.from ?? "unknown", text: `Ack: ${msg.text ?? ""}` }),
    now = () => new Date().toISOString(),
    leaseMs = 30000,
  } = options;

  if (!gateway || typeof gateway.send !== "function") {
    throw new TypeError("createOutbox requires a gateway with a send(msg) function");
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new RangeError("maxAttempts must be a positive integer");
  }
  if (!Number.isInteger(leaseMs) || leaseMs < 1) {
    throw new RangeError("leaseMs must be a positive integer");
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS seen_messages (
      message_id TEXT PRIMARY KEY,
      received_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS outbox (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id      TEXT NOT NULL,
      payload         TEXT NOT NULL,
      attempts        INTEGER NOT NULL DEFAULT 0,
      status          TEXT NOT NULL DEFAULT 'pending',
      created_at      TEXT NOT NULL,
      sending_at      TEXT,
      sent_at         TEXT,
      last_error      TEXT
    );
  `);

  // Tolerate a database created by an earlier version of this module.
  if (!db.prepare("PRAGMA table_info(outbox)").all().some((c) => c.name === "sending_at")) {
    db.exec("ALTER TABLE outbox ADD COLUMN sending_at TEXT");
  }

  const insertSeen = db.prepare(
    "INSERT INTO seen_messages (message_id, received_at) VALUES (?, ?) ON CONFLICT(message_id) DO NOTHING",
  );
  const insertOutbox = db.prepare(
    "INSERT INTO outbox (message_id, payload, status, attempts, created_at) VALUES (?, ?, 'pending', 0, ?)",
  );

  // Local, in-process event counters. They describe what *this* instance observed
  // via handleWebhook/flush and the injected gateway; unlike the durable rows in
  // `outbox`, they are not persisted and reset on reopen. `failed` counts failed
  // delivery attempts (including transient ones), whereas `outbox.failed` in
  // stats() counts rows that reached a terminal failed status.
  const counters = {
    accepted: 0,
    duplicate: 0,
    enqueued: 0,
    sent: 0,
    failed: 0,
    attempts: 0,
  };

  /** Accept a webhook once per provider message id; enqueue the reply atomically. */
  function handleWebhook(msg) {
    if (!msg || typeof msg.messageId !== "string" || msg.messageId.length === 0) {
      throw new TypeError("msg.messageId is required");
    }

    db.exec("BEGIN IMMEDIATE");
    try {
      const seen = insertSeen.run(msg.messageId, now());
      if (seen.changes === 0) {
        db.exec("ROLLBACK");
        counters.duplicate += 1;
        return { status: "duplicate", messageId: msg.messageId, enqueued: false };
      }
      const reply = buildReply(msg);
      insertOutbox.run(msg.messageId, JSON.stringify(reply ?? {}), now());
      db.exec("COMMIT");
      counters.accepted += 1;
      counters.enqueued += 1;
      return { status: "accepted", messageId: msg.messageId, enqueued: true };
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  /** Drain pending/failed rows through the injected gateway, with bounded retries. */
  async function flush() {
    // A row left in `sending` by a crashed process must become retryable, but a
    // row that already used its last attempt must become terminally failed.
    const nowMs = Date.parse(now());
    const clockMs = Number.isFinite(nowMs) ? nowMs : Date.now();
    const cutoff = new Date(clockMs - leaseMs).toISOString();
    db.prepare(
      "UPDATE outbox SET status = CASE WHEN attempts >= ? THEN 'failed' ELSE 'pending' END, " +
        "sending_at = NULL, last_error = ? " +
        "WHERE status = 'sending' AND (sending_at IS NULL OR sending_at < ?)",
    ).run(maxAttempts, "reclaimed after lease", cutoff);

    const rows = db
      .prepare(
        "SELECT id, attempts, payload FROM outbox WHERE status IN ('pending', 'failed') AND attempts < ? ORDER BY id",
      )
      .all(maxAttempts);

    // Atomic claim: two workers sharing a file-backed DB cannot both send a row.
    const claim = db.prepare(
      "UPDATE outbox SET status = 'sending', attempts = attempts + 1, sending_at = ? " +
        "WHERE id = ? AND status IN ('pending', 'failed') AND attempts < ? RETURNING attempts",
    );
    const markSent = db.prepare(
      "UPDATE outbox SET status = 'sent', sent_at = ?, sending_at = NULL WHERE id = ?",
    );
    const markUnsent = db.prepare(
      "UPDATE outbox SET status = ?, last_error = ?, sending_at = NULL WHERE id = ?",
    );

    const results = [];
    for (const row of rows) {
      const claimed = claim.get(now(), row.id, maxAttempts);
      if (!claimed) continue; // another worker claimed this row first
      const attempts = claimed.attempts;
      counters.attempts += 1;
      try {
        await gateway.send(JSON.parse(row.payload));
        markSent.run(now(), row.id);
        counters.sent += 1;
        results.push({ id: row.id, status: "sent", attempts });
      } catch (err) {
        const status = attempts >= maxAttempts ? "failed" : "pending";
        const message = err instanceof Error ? err.message : String(err);
        markUnsent.run(status, message, row.id);
        counters.failed += 1;
        results.push({ id: row.id, status, attempts, error: message });
      }
    }
    return results;
  }

  function stats() {
    const outbox = {};
    for (const row of db.prepare("SELECT status, COUNT(*) AS n FROM outbox GROUP BY status").all()) {
      outbox[row.status] = row.n;
    }
    return {
      seen: db.prepare("SELECT COUNT(*) AS n FROM seen_messages").get().n,
      outbox,
      // A copy: callers cannot mutate the counters through a returned stats object.
      counters: { ...counters },
    };
  }

  function close() {
    db.close();
  }

  return { handleWebhook, flush, stats, close, db };
}

export default createOutbox;
