import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createOutbox } from "../lib/outbox.mjs";

function countingGateway() {
  const sent = [];
  return { sent, send: async (msg) => { sent.push(msg); } };
}

const webhook = (messageId, text = "hello") => ({
  messageId,
  from: "+10000000001",
  text,
});

test("duplicate provider message ids are not processed twice", () => {
  const gateway = countingGateway();
  const outbox = createOutbox({ gateway });
  try {
    assert.deepEqual(outbox.handleWebhook(webhook("msg-001")), {
      status: "accepted",
      messageId: "msg-001",
      enqueued: true,
    });
    assert.deepEqual(outbox.handleWebhook(webhook("msg-001")), {
      status: "duplicate",
      messageId: "msg-001",
      enqueued: false,
    });
    assert.equal(outbox.stats().seen, 1);
    assert.equal(outbox.stats().outbox.pending, 1);
  } finally {
    outbox.close();
  }
});

test("accepted webhooks enqueue a reply in the outbox", () => {
  const gateway = countingGateway();
  const outbox = createOutbox({
    gateway,
    buildReply: (msg) => ({ to: msg.from, text: `RECEIVED:${msg.text}` }),
  });
  try {
    outbox.handleWebhook(webhook("msg-002", "invoice please"));
    const rows = outbox.db.prepare("SELECT message_id, payload, attempts, status FROM outbox").all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].message_id, "msg-002");
    assert.deepEqual(JSON.parse(rows[0].payload), { to: "+10000000001", text: "RECEIVED:invoice please" });
    assert.equal(rows[0].attempts, 0);
    assert.equal(rows[0].status, "pending");
  } finally {
    outbox.close();
  }
});

test("flush sends queued replies through the injected fake gateway exactly once", async () => {
  const gateway = countingGateway();
  const outbox = createOutbox({ gateway });
  try {
    outbox.handleWebhook(webhook("msg-003", "ping"));
    const first = await outbox.flush();
    assert.deepEqual(first, [{ id: 1, status: "sent", attempts: 1 }]);
    assert.deepEqual(gateway.sent, [{ to: "+10000000001", text: "Ack: ping" }]);
    assert.deepEqual(await outbox.flush(), [], "sent rows must not be re-delivered");
    assert.equal(outbox.stats().outbox.sent, 1);
  } finally {
    outbox.close();
  }
});

test("a failing gateway is retried and eventually succeeds", async () => {
  let calls = 0;
  const gateway = {
    sent: [],
    send: async (msg) => {
      calls += 1;
      if (calls <= 2) throw new Error("temporary outage");
      gateway.sent.push(msg);
    },
  };
  const outbox = createOutbox({ gateway, maxAttempts: 3 });
  try {
    outbox.handleWebhook(webhook("msg-004", "retry me"));
    assert.deepEqual(await outbox.flush(), [
      { id: 1, status: "pending", attempts: 1, error: "temporary outage" },
    ]);
    assert.deepEqual(await outbox.flush(), [
      { id: 1, status: "pending", attempts: 2, error: "temporary outage" },
    ]);
    assert.deepEqual(await outbox.flush(), [{ id: 1, status: "sent", attempts: 3 }]);
    assert.equal(gateway.sent.length, 1);
    assert.equal(outbox.stats().outbox.sent, 1);
  } finally {
    outbox.close();
  }
});

test("a permanently failing gateway stops at the bounded attempt limit", async () => {
  const gateway = {
    send: async () => {
      throw new Error("permanent outage");
    },
  };
  const outbox = createOutbox({ gateway, maxAttempts: 2 });
  try {
    outbox.handleWebhook(webhook("msg-005", "never delivered"));
    assert.equal((await outbox.flush())[0].status, "pending");
    assert.equal((await outbox.flush())[0].status, "failed");
    assert.deepEqual(await outbox.flush(), [], "failed rows stop being retried");
    assert.equal(outbox.stats().outbox.failed, 1);
    const row = outbox.db.prepare("SELECT attempts, last_error FROM outbox").get();
    assert.equal(row.attempts, 2);
    assert.equal(row.last_error, "permanent outage");
  } finally {
    outbox.close();
  }
});

test("file-backed SQLite keeps dedup and queued rows across reopen", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nexus-outbox-"));
  const file = join(dir, "outbox.sqlite");
  try {
    const first = createOutbox({ db: new DatabaseSync(file), gateway: countingGateway() });
    first.handleWebhook(webhook("msg-006", "durable"));
    assert.deepEqual(first.handleWebhook(webhook("msg-006", "durable")), {
      status: "duplicate",
      messageId: "msg-006",
      enqueued: false,
    });
    first.close();

    const gateway = countingGateway();
    const reopened = createOutbox({ db: new DatabaseSync(file), gateway });
    try {
      assert.equal(reopened.stats().seen, 1);
      assert.equal(reopened.stats().outbox.pending, 1);
      assert.deepEqual(await reopened.flush(), [{ id: 1, status: "sent", attempts: 1 }]);
      assert.deepEqual(gateway.sent, [{ to: "+10000000001", text: "Ack: durable" }]);
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a stale sending row is reclaimed and retried after a crash", async () => {
  const gateway = countingGateway();
  const outbox = createOutbox({ gateway });
  try {
    outbox.handleWebhook(webhook("msg-007", "crashed mid-send"));
    outbox.db
      .prepare("UPDATE outbox SET status='sending', attempts=1, sending_at=? WHERE message_id=?")
      .run(new Date(Date.now() - 60000).toISOString(), "msg-007");
    assert.deepEqual(await outbox.flush(), [{ id: 1, status: "sent", attempts: 2 }]);
    assert.equal(gateway.sent.length, 1);
    assert.equal(outbox.stats().outbox.sending, undefined);
  } finally {
    outbox.close();
  }
});

test("a row still inside its lease is not re-sent", async () => {
  const gateway = countingGateway();
  const outbox = createOutbox({ gateway });
  try {
    outbox.handleWebhook(webhook("msg-008", "in flight"));
    outbox.db
      .prepare("UPDATE outbox SET status='sending', attempts=1, sending_at=? WHERE message_id=?")
      .run(new Date().toISOString(), "msg-008");
    assert.deepEqual(await outbox.flush(), []);
    assert.equal(gateway.sent.length, 0);
    assert.equal(outbox.db.prepare("SELECT status FROM outbox").get().status, "sending");
  } finally {
    outbox.close();
  }
});

test("a crash on the final attempt marks the row failed, not stranded", async () => {
  const gateway = countingGateway();
  const outbox = createOutbox({ gateway, maxAttempts: 2 });
  try {
    outbox.handleWebhook(webhook("msg-009", "last attempt crashed"));
    outbox.db
      .prepare("UPDATE outbox SET status='sending', attempts=2, sending_at=? WHERE message_id=?")
      .run(new Date(Date.now() - 60000).toISOString(), "msg-009");
    assert.deepEqual(await outbox.flush(), []);
    assert.equal(gateway.sent.length, 0);
    assert.equal(outbox.stats().outbox.failed, 1);
    assert.equal(outbox.db.prepare("SELECT status FROM outbox").get().status, "failed");
  } finally {
    outbox.close();
  }
});

test("stats counters track accepted, duplicate and enqueued webhooks", () => {
  const outbox = createOutbox({ gateway: countingGateway() });
  try {
    assert.deepEqual(outbox.stats().counters, {
      accepted: 0,
      duplicate: 0,
      enqueued: 0,
      sent: 0,
      failed: 0,
      attempts: 0,
    });

    outbox.handleWebhook(webhook("msg-010", "first"));
    outbox.handleWebhook(webhook("msg-011", "second"));
    outbox.handleWebhook(webhook("msg-010", "again"));

    assert.deepEqual(outbox.stats().counters, {
      accepted: 2,
      duplicate: 1,
      enqueued: 2,
      sent: 0,
      failed: 0,
      attempts: 0,
    });
    assert.equal(outbox.stats().seen, 2);
    assert.equal(outbox.stats().outbox.pending, 2);

    // stats() hands back a snapshot, not the live counter object.
    const snapshot = outbox.stats().counters;
    snapshot.accepted = 99;
    assert.equal(outbox.stats().counters.accepted, 2);
  } finally {
    outbox.close();
  }
});

test("stats counters track attempts, sent and failed through a transient gateway failure", async () => {
  let calls = 0;
  const gateway = {
    sent: [],
    send: async (msg) => {
      calls += 1;
      if (calls === 1) throw new Error("temporary outage");
      gateway.sent.push(msg);
    },
  };
  const outbox = createOutbox({ gateway, maxAttempts: 3 });
  try {
    outbox.handleWebhook(webhook("msg-012", "recover"));
    assert.deepEqual(outbox.stats().counters, {
      accepted: 1,
      duplicate: 0,
      enqueued: 1,
      sent: 0,
      failed: 0,
      attempts: 0,
    });

    await outbox.flush(); // attempt 1 fails
    assert.deepEqual(outbox.stats().counters, {
      accepted: 1,
      duplicate: 0,
      enqueued: 1,
      sent: 0,
      failed: 1,
      attempts: 1,
    });

    await outbox.flush(); // attempt 2 succeeds
    assert.deepEqual(outbox.stats().counters, {
      accepted: 1,
      duplicate: 0,
      enqueued: 1,
      sent: 1,
      failed: 1,
      attempts: 2,
    });

    await outbox.flush(); // nothing left to do: counters must not move
    assert.equal(outbox.stats().counters.attempts, 2);
    assert.equal(outbox.stats().counters.sent, 1);
    assert.equal(gateway.sent.length, 1);
    assert.equal(outbox.stats().outbox.sent, 1);
  } finally {
    outbox.close();
  }
});

test("stats counters record every failed attempt up to the bounded limit", async () => {
  const gateway = {
    send: async () => {
      throw new Error("permanent outage");
    },
  };
  const outbox = createOutbox({ gateway, maxAttempts: 2 });
  try {
    outbox.handleWebhook(webhook("msg-013", "never delivered"));
    await outbox.flush();
    await outbox.flush();
    await outbox.flush(); // terminal row is not retried

    assert.deepEqual(outbox.stats().counters, {
      accepted: 1,
      duplicate: 0,
      enqueued: 1,
      sent: 0,
      failed: 2,
      attempts: 2,
    });
    // `counters.failed` counts failed delivery attempts; `outbox.failed` counts
    // rows in the terminal failed state (one row here).
    assert.equal(outbox.stats().outbox.failed, 1);
  } finally {
    outbox.close();
  }
});
