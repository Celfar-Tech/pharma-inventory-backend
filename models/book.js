// Order book persistence backed by pharma.book_ledger + pharma.book_items.
//
// Every query is scoped to the authenticated user via `user_name` (mirroring
// the inventory model) so one user can never read or mutate another user's
// book. The ledger itself is created lazily per user; the `generate_ledger_id`
// trigger stamps it with the LE+YYYYMMDD+sequence id.

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

/** Creates the schema/tables/trigger, then back-fills any missing columns. */
const createSchema = async () => {
  await db.query("CREATE SCHEMA IF NOT EXISTS pharma;");

  await db.query(`
    CREATE TABLE IF NOT EXISTS pharma.book_ledger (
      ledger_id VARCHAR(16) PRIMARY KEY,
      date DATE NOT NULL DEFAULT CURRENT_DATE,
      unique_items_count INT DEFAULT 0,
      approx_cost NUMERIC(12, 2) DEFAULT 0.00,
      user_name VARCHAR(500)
    );
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS pharma.book_items (
      item_id BIGSERIAL PRIMARY KEY,
      ledger_id VARCHAR(16) NOT NULL REFERENCES pharma.book_ledger(ledger_id) ON DELETE CASCADE,
      supplier_name VARCHAR(255),
      supplier_phone VARCHAR(20),
      supplier_email VARCHAR(255),
      supplier_address TEXT,
      medicine_name VARCHAR(255) NOT NULL,
      composition TEXT,
      quantity INT NOT NULL CHECK (quantity > 0),
      purchase_price NUMERIC(10, 2),
      remarks TEXT,
      user_name VARCHAR(500),
      medicine_id BIGINT,
      manufacturer VARCHAR(500),
      pack_size_label VARCHAR(100),
      status VARCHAR(20) NOT NULL DEFAULT 'active',
      ordered_at TIMESTAMP,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Deployments created before this module may already have the two tables
  // without the columns this feature needs, so add them idempotently.
  const alters = [
    `ALTER TABLE pharma.book_ledger ADD COLUMN IF NOT EXISTS user_name VARCHAR(500)`,
    `ALTER TABLE pharma.book_items ADD COLUMN IF NOT EXISTS user_name VARCHAR(500)`,
    `ALTER TABLE pharma.book_items ADD COLUMN IF NOT EXISTS medicine_id BIGINT`,
    `ALTER TABLE pharma.book_items ADD COLUMN IF NOT EXISTS manufacturer VARCHAR(500)`,
    `ALTER TABLE pharma.book_items ADD COLUMN IF NOT EXISTS pack_size_label VARCHAR(100)`,
    `ALTER TABLE pharma.book_items ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'active'`,
    `ALTER TABLE pharma.book_items ADD COLUMN IF NOT EXISTS ordered_at TIMESTAMP`,
    `ALTER TABLE pharma.book_items ADD COLUMN IF NOT EXISTS created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP`,
    `ALTER TABLE pharma.book_items ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP`,
  ];
  for (const statement of alters) {
    await db.query(statement);
  }

  // Auto-generates ledger_id (LE + YYYYMMDD + 6-digit daily sequence).
  await db.query(`
    CREATE OR REPLACE FUNCTION pharma.generate_ledger_id()
    RETURNS TRIGGER AS $$
    DECLARE
        seq_num INT;
        date_str TEXT;
    BEGIN
        IF NEW.date IS NULL THEN
            NEW.date := CURRENT_DATE;
        END IF;
        date_str := TO_CHAR(NEW.date, 'YYYYMMDD');
        SELECT COALESCE(MAX(SUBSTRING(ledger_id FROM 11 FOR 6)::INT), 0) + 1
        INTO seq_num
        FROM pharma.book_ledger
        WHERE date = NEW.date;
        NEW.ledger_id := 'LE' || date_str || LPAD(seq_num::TEXT, 6, '0');
        RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);

  await db.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgname = 'trg_set_ledger_id'
          AND tgrelid = 'pharma.book_ledger'::regclass
      ) THEN
        CREATE TRIGGER trg_set_ledger_id
        BEFORE INSERT ON pharma.book_ledger
        FOR EACH ROW
        EXECUTE FUNCTION pharma.generate_ledger_id();
      END IF;
    END
    $$;
  `);
};

/**
 * Runs the DDL above at most once per process.
 *
 * The statements are not concurrency-safe on their own — two connections running
 * `CREATE TABLE IF NOT EXISTS` (or `CREATE OR REPLACE FUNCTION`) at the same time
 * can still raise a duplicate-key / "tuple concurrently updated" error — and the
 * order book page loads `/entries` and `/history` in parallel, so the first pair
 * of requests used to race each other on the same DDL. Sharing one promise also
 * drops ~14 catalog round-trips from every subsequent request.
 */
let schemaReady = null;
const ensureTableExists = () => {
  if (!schemaReady) {
    schemaReady = createSchema().catch((error) => {
      // Let the next call retry after a transient failure (lock timeout, blip).
      schemaReady = null;
      throw error;
    });
  }
  return schemaReady;
};

/** Returns (or lazily creates) the user's ledger id. */
const ensureLedger = async (email) => {
  const existing = await db.query(
    `SELECT ledger_id
     FROM pharma.book_ledger
     WHERE user_name = $1
     ORDER BY date DESC, ledger_id DESC
     LIMIT 1`,
    [email]
  );
  if (existing.rows.length) return existing.rows[0].ledger_id;

  const created = await db.query(
    `INSERT INTO pharma.book_ledger (user_name, unique_items_count, approx_cost)
     VALUES ($1, 0, 0)
     RETURNING ledger_id`,
    [email]
  );
  return created.rows[0].ledger_id;
};

/** Keeps the ledger's derived counters in sync after any mutation. */
const refreshLedger = async (email) => {
  await db.query(
    `UPDATE pharma.book_ledger l
     SET
       unique_items_count = (
         SELECT COUNT(*) FROM pharma.book_items i
         WHERE i.ledger_id = l.ledger_id AND i.status = 'active'
       ),
       approx_cost = (
         SELECT COALESCE(SUM(i.quantity * i.purchase_price), 0)
         FROM pharma.book_items i
         WHERE i.ledger_id = l.ledger_id AND i.status = 'active'
       )
     WHERE l.user_name = $1`,
    [email]
  );
};

const listActive = async (email) => {
  await ensureTableExists();

  const result = await db.query(
    `SELECT * FROM pharma.book_items
     WHERE user_name = $1 AND status = $2
     ORDER BY created_at DESC, item_id DESC`,
    [email, ACTIVE]
  );
  return result.rows.map(toEntry);
};

const listHistory = async (email) => {
  await ensureTableExists();

  const result = await db.query(
    `SELECT * FROM pharma.book_items
     WHERE user_name = $1 AND status = $2
     ORDER BY ordered_at DESC, item_id DESC`,
    [email, ORDERED]
  );
  return result.rows.map(toHistoryEntry);
};

/** Inserts a line, or folds quantity into an existing line for the same medicine. */
const upsertEntry = async (email, input) => {
  await ensureTableExists();

  const name = String(input.name || "").trim();
  const quantity = Math.max(1, Number(input.quantity) || 0);
  const medicineId = input.medicineId == null ? null : Number(input.medicineId);
  const manufacturer = String(input.manufacturer || "").trim();
  const composition = String(input.composition || "").trim();
  const packSize = String(input.packSize || "").trim();
  const price = Number(input.price) || 0;
  const remark = String(input.remark || "").trim();

  const ledgerId = await ensureLedger(email);

  // Merge key mirrors the client: by sku when known, otherwise by name. A line
  // first typed from the catalogue without a sku is adopted when the same
  // medicine is later picked from it, so the book cannot grow a duplicate row.
  const existingResult =
    medicineId !== null
      ? await db.query(
          `SELECT * FROM pharma.book_items
           WHERE ledger_id = $1 AND user_name = $2 AND status = $3
             AND (
               medicine_id = $4
               OR (medicine_id IS NULL AND LOWER(medicine_name) = LOWER($5))
             )
           ORDER BY (medicine_id IS NOT DISTINCT FROM $4) DESC, item_id ASC
           LIMIT 1`,
          [ledgerId, email, ACTIVE, medicineId, name]
        )
      : await db.query(
          `SELECT * FROM pharma.book_items
           WHERE ledger_id = $1 AND user_name = $2 AND status = $3
             AND medicine_id IS NULL
             AND LOWER(medicine_name) = LOWER($4)
           LIMIT 1`,
          [ledgerId, email, ACTIVE, name]
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
    const result = await db.query(
      `INSERT INTO pharma.book_items
         (ledger_id, user_name, medicine_id, medicine_name, manufacturer, composition, pack_size_label, quantity, purchase_price, remarks)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [ledgerId, email, medicineId, name, manufacturer, composition, packSize, quantity, price, remark]
    );
    entry = toEntry(result.rows[0]);
  }

  await refreshLedger(email);
  const entries = await listActive(email);
  return { entries, entry, merged };
};

/** Patches an active line. A missing/foreign id is a no-op, not an error. */
const updateEntry = async (email, itemId, patch) => {
  await ensureTableExists();

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

  await refreshLedger(email);
  return {
    entries: await listActive(email),
    // The row can vanish between the read above and this UPDATE; report it as
    // "not found" (the controller maps that to a 404) instead of throwing.
    entry: result.rows[0] ? toEntry(result.rows[0]) : undefined,
  };
};

/** Deletes a single active line. */
const removeEntry = async (email, itemId) => {
  await ensureTableExists();

  const id = Number(itemId);
  if (Number.isFinite(id) && id > 0) {
    await db.query(
      `DELETE FROM pharma.book_items
       WHERE item_id = $1 AND user_name = $2 AND status = $3`,
      [id, email, ACTIVE]
    );
  }

  await refreshLedger(email);
  return listActive(email);
};

/** Deletes every active line (history is preserved). */
const clearEntries = async (email) => {
  await ensureTableExists();

  await db.query(
    `DELETE FROM pharma.book_items
     WHERE user_name = $1 AND status = $2`,
    [email, ACTIVE]
  );

  await refreshLedger(email);
  return [];
};

/** Moves the selected active lines into order history. */
const placeOrder = async (email, ids) => {
  await ensureTableExists();

  const numericIds = (Array.isArray(ids) ? ids : [])
    .map(Number)
    .filter((value) => Number.isFinite(value) && value > 0);

  let placed = [];
  if (numericIds.length) {
    const result = await db.query(
      `UPDATE pharma.book_items SET
         status = $1,
         ordered_at = CURRENT_TIMESTAMP,
         updated_at = CURRENT_TIMESTAMP
       WHERE item_id = ANY($2::bigint[]) AND user_name = $3 AND status = $4
       RETURNING *`,
      [ORDERED, numericIds, email, ACTIVE]
    );
    placed = result.rows.map(toHistoryEntry);
  }

  await refreshLedger(email);
  const entries = await listActive(email);
  const history = await listHistory(email);
  return { entries, history, placed };
};

module.exports = {
  ensureTableExists,
  listActive,
  listHistory,
  upsertEntry,
  updateEntry,
  removeEntry,
  clearEntries,
  placeOrder,
};
