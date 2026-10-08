// Order book persistence backed by pharma.book_ledger + pharma.book_items.
//
// Every query is scoped to the authenticated user via `user_name` (mirroring
// the inventory model) so one user can never read or mutate another user's
// book. Active lines are stored with a NULL `ledger_id`; a ledger row is only
// written when an order is placed, at which point the selected lines are moved
// into that fresh ledger (status 'ordered' + ledger_id). The
// `generate_ledger_id` trigger stamps each new ledger with the
// LE+YYYYMMDD+sequence id.

const db = require("../database");

const ACTIVE = "active";
const ORDERED = "ordered";

/** Serialises a timestamp-ish value (Date, ISO string, raw string) to ISO. */
const toIso = (value) => {
  if (value === null || value === undefined) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
};

/** Maps a book_items row to the shape the frontend expects. */
const toEntry = (row) => ({
  id: String(row.item_id),
  medicineId: row.medicine_id == null ? null : Number(row.medicine_id),
  ledgerId: row.ledger_id == null ? null : String(row.ledger_id),
  key:
    row.medicine_id != null
      ? `id:${row.medicine_id}`
      : `name:${(row.medicine_name || "").trim().toLowerCase()}`,
  name: row.medicine_name || "",
  manufacturer: row.manufacturer || "",
  composition: row.composition || "",
  packSize: row.pack_size_label || "",
  quantity: Number(row.quantity) || 0,
  price: Number(row.purchase_price) || 0,
  remark: row.remarks || "",
  createdAt: toIso(row.created_at),
  updatedAt: toIso(row.updated_at),
});

const toHistoryEntry = (row) => ({
  ...toEntry(row),
  orderedAt: toIso(row.ordered_at) || toIso(row.updated_at),
});

/**
 * Maps a book_ledger row to the shape the frontend expects.
 *
 * A ledger is the record of one *placed order*, so the summary carries the
 * order-level fields (supplier details, item count, approximate cost). The
 * individual medicines live in book_items and are only loaded when the user
 * expands a row, via `listLedgerItems`.
 *
 * Fields are read defensively (`row.x || default`) so an older deployment whose
 * `book_ledger` predates the supplier_* columns still serialises cleanly.
 */
const toLedger = (row) => ({
  ledgerId: String(row.ledger_id),
  date: toIso(row.date),
  supplierName: row.supplier_name || "",
  supplierEmail: row.supplier_email || "",
  itemCount: Number(row.unique_items_count) || 0,
  approxCost: Number(row.approx_cost) || 0,
  status: row.status || ORDERED,
  orderedAt: toIso(row.date),
});



/*
 * Writers of pharma.book_ledger.
 *
 * A ledger is the record of a *placed order*, never of a line sitting in the
 * book, so `upsertEntry` / `updateEntry` / `removeEntry` / `clearEntries` must
 * not reach this table — adding a line touches `pharma.book_items` only.
 *
 * To make that invariant structural rather than a convention, both helpers
 * below take the `client` of the transaction `placeOrder` opens and never the
 * shared pool, so no line-level operation can write a ledger row even by
 * accident.
 */

/**
 * Inserts a brand new ledger row and returns its id.
 *
 * A ledger represents a single placed order, so it is created on demand by
 * `placeOrder` and never before. The `generate_ledger_id` trigger stamps the
 * id (LE + YYYYMMDD + 6-digit daily sequence).
 */
const createLedger = async (client, email, supplierName, supplierEmail) => {
  const created = await client.query(
    `INSERT INTO pharma.book_ledger 
      (user_name, supplier_name, supplier_email, unique_items_count, approx_cost)
     VALUES ($1, $2, $3, 0, 0)
     RETURNING ledger_id`,
    [email, supplierName, supplierEmail]
  );

  return created.rows[0].ledger_id;
};
/**
 * Recomputes a single ledger's derived counters from its ordered lines.
 *
 * A ledger only ever holds the lines that were placed into it, so every item
 * with this `ledger_id` counts regardless of status.
 */
const refreshLedger = async (client, ledgerId) => {
  await client.query(
    `UPDATE pharma.book_ledger l
     SET
       unique_items_count = (
         SELECT COUNT(*) FROM pharma.book_items i
         WHERE i.ledger_id = l.ledger_id
       ),
       approx_cost = (
         SELECT COALESCE(SUM(i.quantity * i.purchase_price), 0)
         FROM pharma.book_items i
         WHERE i.ledger_id = l.ledger_id
       )
     WHERE l.ledger_id = $1`,
    [ledgerId]
  );
};

const listActive = async (email) => {

  const result = await db.query(
    `SELECT * FROM pharma.book_items
     WHERE user_name = $1 AND status = $2
     ORDER BY created_at DESC, item_id DESC`,
    [email, ACTIVE]
  );
  return result.rows.map(toEntry);
};

/**
 * Lists the user's placed orders, one summary row per ledger.
 *
 * A ledger is reported only when it actually owns at least one ordered line.
 * That keeps the list honest two ways: it expresses "a ledger is a placed
 * order" without relying on a `status` column on `book_ledger` (which older
 * deployments never had), and it hides the empty per-user ledger rows written
 * by the previous lazy-ledger design. Ordered lines are not joined in — the
 * history list shows the order summary only, and `listLedgerItems` loads the
 * medicines when a row is expanded.
 */
const listLedgers = async (email) => {
  const result = await db.query(
    `SELECT l.* FROM pharma.book_ledger l
     WHERE l.user_name = $1
       AND EXISTS (
         SELECT 1 FROM pharma.book_items i
         WHERE i.ledger_id = l.ledger_id AND i.status = $2
       )
     ORDER BY l.date DESC, l.ledger_id DESC`,
    [email, ORDERED]
  );
  return result.rows.map(toLedger);
};

/**
 * Loads a single ledger (order) together with the medicines it placed.
 *
 * Scoped by `user_name` as well as `ledger_id`, so a user cannot expand another
 * user's order by guessing its id. A `null` ledger means the id is unknown to
 * this user (the controller maps that to a 404); an existing ledger with no
 * lines returns an empty `items` array.
 */
const listLedgerItems = async (email, ledgerId) => {
  const ledgerResult = await db.query(
    `SELECT * FROM pharma.book_ledger
     WHERE ledger_id = $1 AND user_name = $2`,
    [ledgerId, email]
  );

  if (!ledgerResult.rows.length) {
    return { ledger: null, items: [] };
  }

  const itemsResult = await db.query(
    `SELECT * FROM pharma.book_items
     WHERE ledger_id = $1 AND user_name = $2
     ORDER BY item_id ASC`,
    [ledgerId, email]
  );

  return {
    ledger: toLedger(ledgerResult.rows[0]),
    items: itemsResult.rows.map(toHistoryEntry),
  };
};

/** Inserts a line, or folds quantity into an existing line for the same medicine. */
const upsertEntry = async (email, input) => {

  const name = String(input.name || "").trim();
  const quantity = Math.max(1, Number(input.quantity) || 0);
  const medicineId = input.medicineId == null ? null : Number(input.medicineId);
  const manufacturer = String(input.manufacturer || "").trim();
  const composition = String(input.composition || "").trim();
  const packSize = String(input.packSize || "").trim();
  const price = Number(input.price) || 0;
  const remark = String(input.remark || "").trim();

  // Merge key mirrors the client: by sku when known, otherwise by name. A line
  // first typed from the catalogue without a sku is adopted when the same
  // medicine is later picked from it, so the book cannot grow a duplicate row.
  // Active lines are not tied to a ledger yet, so the lookup is scoped by user
  // + status only (no ledger_id filter).
  const existingResult =
    medicineId !== null
      ? await db.query(
        `SELECT * FROM pharma.book_items
           WHERE user_name = $1 AND status = $2
             AND (
               medicine_id = $3
               OR (medicine_id IS NULL AND LOWER(medicine_name) = LOWER($4))
             )
           ORDER BY (medicine_id IS NOT DISTINCT FROM $3) DESC, item_id ASC
           LIMIT 1`,
        [email, ACTIVE, medicineId, name]
      )
      : await db.query(
        `SELECT * FROM pharma.book_items
           WHERE user_name = $1 AND status = $2
             AND medicine_id IS NULL
             AND LOWER(medicine_name) = LOWER($3)
           LIMIT 1`,
        [email, ACTIVE, name]
      );

  const existing = existingResult.rows[0];
  let entry;
  let merged = false;

  if (existing) {
    const result = await db.query(
      `UPDATE pharma.book_items SET
         medicine_name = $1,
         medicine_id = $2,
         manufacturer = $3,
         composition = $4,
         pack_size_label = $5,
         quantity = quantity + $6,
         purchase_price = $7,
         remarks = $8,
         updated_at = CURRENT_TIMESTAMP
       WHERE item_id = $9 AND user_name = $10 AND status = $11
       RETURNING *`,
      [name, medicineId, manufacturer, composition, packSize, quantity, price, remark, existing.item_id, email, ACTIVE]
    );
    entry = toEntry(result.rows[0]);
    merged = true;
  } else {
    // ledger_id is intentionally omitted: it stays NULL until the order is
    // placed, so no ledger row is created here.
    const result = await db.query(
      `INSERT INTO pharma.book_items
         (user_name, medicine_id, medicine_name, manufacturer, composition, pack_size_label, quantity, purchase_price, remarks)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [email, medicineId, name, manufacturer, composition, packSize, quantity, price, remark]
    );
    entry = toEntry(result.rows[0]);
  }

  const entries = await listActive(email);
  return { entries, entry, merged };
};

/** Patches an active line. A missing/foreign id is a no-op, not an error. */
const updateEntry = async (email, itemId, patch) => {

  const id = Number(itemId);
  if (!Number.isFinite(id) || id <= 0) {
    return { entries: await listActive(email), entry: undefined };
  }

  const existingResult = await db.query(
    `SELECT * FROM pharma.book_items
     WHERE item_id = $1 AND user_name = $2 AND status = $3`,
    [id, email, ACTIVE]
  );
  const existing = existingResult.rows[0];
  if (!existing) {
    return { entries: await listActive(email), entry: undefined };
  }

  const name = patch.name?.trim() || existing.medicine_name;
  const medicineId =
    patch.medicineId !== undefined
      ? (patch.medicineId == null ? null : Number(patch.medicineId))
      : (existing.medicine_id == null ? null : Number(existing.medicine_id));
  const manufacturer = patch.manufacturer?.trim() ?? existing.manufacturer ?? "";
  const composition = patch.composition?.trim() ?? existing.composition ?? "";
  const packSize = patch.packSize?.trim() ?? existing.pack_size_label ?? "";
  const quantity =
    patch.quantity !== undefined
      ? Math.max(1, Number(patch.quantity) || Number(existing.quantity) || 1)
      : Number(existing.quantity) || 1;
  const price =
    patch.price !== undefined
      ? Number(patch.price) || 0
      : Number(existing.purchase_price) || 0;
  const remark = patch.remark?.trim() ?? existing.remarks ?? "";

  const result = await db.query(
    `UPDATE pharma.book_items SET
       medicine_name = $1,
       medicine_id = $2,
       manufacturer = $3,
       composition = $4,
       pack_size_label = $5,
       quantity = $6,
       purchase_price = $7,
       remarks = $8,
       updated_at = CURRENT_TIMESTAMP
     WHERE item_id = $9 AND user_name = $10 AND status = $11
     RETURNING *`,
    [name, medicineId, manufacturer, composition, packSize, quantity, price, remark, id, email, ACTIVE]
  );

  return {
    entries: await listActive(email),
    // The row can vanish between the read above and this UPDATE; report it as
    // "not found" (the controller maps that to a 404) instead of throwing.
    entry: result.rows[0] ? toEntry(result.rows[0]) : undefined,
  };
};

/** Deletes a single active line. */
const removeEntry = async (email, itemId) => {
  const id = Number(itemId);
  if (Number.isFinite(id) && id > 0) {
    await db.query(
      `DELETE FROM pharma.book_items
       WHERE item_id = $1 AND user_name = $2 AND status = $3`,
      [id, email, ACTIVE]
    );
  }

  return listActive(email);
};

/** Deletes every active line (history is preserved). */
const clearEntries = async (email) => {
  await db.query(
    `DELETE FROM pharma.book_items
     WHERE user_name = $1 AND status = $2`,
    [email, ACTIVE]
  );

  return [];
};

/**
 * Moves the selected active lines into order history.
 *
 * Every call creates at most one new ledger row (the order) and stamps the
 * selected lines with that ledger id + status 'ordered'. Lines are never
 * attached to a ledger before this point, and this is the only code path in the
 * module that writes to `pharma.book_ledger`.
 */
const placeOrder = async (email, ids, supplierName, supplierEmail) => {
  const numericIds = (Array.isArray(ids) ? ids : [])
    .map(Number)
    .filter((value) => Number.isFinite(value) && value > 0);

  let placed = [];
  let ledgerId = null;

  if (numericIds.length) {
    // One transaction per order: the ledger row and the lines pointing at it
    // are committed together, so an order can never half-exist and a stale
    // selection leaves no trace at all.
    const client = await db.pool.connect();
    try {
      await client.query("BEGIN");

      // Created here and nowhere else.
      const candidateId = await createLedger(client, email, supplierName, supplierEmail);

      const result = await client.query(
        `UPDATE pharma.book_items SET
           status = $1,
           ledger_id = $2,
           ordered_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
         WHERE item_id = ANY($3::bigint[]) AND user_name = $4 AND status = $5
         RETURNING *`,
        [ORDERED, candidateId, numericIds, email, ACTIVE]
      );
      placed = result.rows.map(toHistoryEntry);

      if (placed.length) {
        await refreshLedger(client, candidateId);
        await client.query("COMMIT");
        ledgerId = candidateId;
      } else {
        // Every selected id was stale/foreign: roll the empty order back so
        // the ledger keeps one row per *placed* order and nothing else.
        await client.query("ROLLBACK");
      }
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  const entries = await listActive(email);
  const history = await listLedgers(email);
  return { entries, history, placed, ledgerId };
};

module.exports = {
  listActive,
  listLedgers,
  listLedgerItems,
  upsertEntry,
  updateEntry,
  removeEntry,
  clearEntries,
  placeOrder,
};
