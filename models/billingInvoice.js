const db = require("../database");
const BillingItem = require("./billingItem");

// Whitelisted calendar-bucket definitions used by the revenue analytics queries below.
// `sqlUnit` / `seriesStep` are interpolated into the aggregation SQL, but ONLY from this
// fixed allow-list — never from user input — so parameterization of every user-supplied
// value (emailid, dates) remains the actual injection defense. Weeks are ISO (Monday start).
const REVENUE_BUCKETS = {
  day: {
    sqlUnit: "day",
    seriesStep: "'1 day'::interval",
    labelExpr: "to_char(s.bucket_start, 'YYYY-MM-DD')",
    endExpr: "s.bucket_start::date",
  },
  week: {
    sqlUnit: "week",
    seriesStep: "'7 days'::interval",
    labelExpr: "to_char(s.bucket_start, 'IYYY-\"W\"IW')",
    endExpr: "(s.bucket_start + interval '6 days')::date",
  },
  month: {
    sqlUnit: "month",
    seriesStep: "'1 month'::interval",
    labelExpr: "to_char(s.bucket_start, 'YYYY-MM')",
    endExpr: "(s.bucket_start + interval '1 month - 1 day')::date",
  },
};

// Table: pharma.billing_invoice — the invoice header
class BillingInvoice {
  static async ensureTableExists(client = db) {
    await client.query("CREATE SCHEMA IF NOT EXISTS pharma;");
    await client.query("CREATE SEQUENCE IF NOT EXISTS pharma.billing_invoice_seq START 1;");
    await client.query(`
      CREATE TABLE IF NOT EXISTS pharma.billing_invoice (
        invoice_number VARCHAR(50) PRIMARY KEY DEFAULT (
          'INV-' || TO_CHAR(CURRENT_DATE, 'YYYYMMDD') || '-' || LPAD(NEXTVAL('pharma.billing_invoice_seq')::TEXT, 5, '0')
        ),
        invoice_date DATE NOT NULL DEFAULT CURRENT_DATE,
        doctor_name VARCHAR(150),
        payment_type VARCHAR(50) NOT NULL DEFAULT 'Cash',
        customer_name VARCHAR(150),
        phone_number VARCHAR(15),
        patient_age INT,
        patient_gender VARCHAR(20),
        address TEXT,
        gstin VARCHAR(15),
        tax_breakdown JSONB DEFAULT '[]'::jsonb,
        total_quantity INT NOT NULL DEFAULT 1,
        gross_amount DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
        discount_amount DECIMAL(12, 2) DEFAULT 0.00,
        subtotal DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
        flat_discount DECIMAL(12, 2) DEFAULT 0.00,
        final_payable DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
        created_by VARCHAR(150),
        updated_by VARCHAR(150),
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await BillingInvoice.ensureUpdatedAtTrigger();
  }

  // Keeps updated_at in sync whenever a row is modified without an explicit UPDATE statement setting it.
  static async ensureUpdatedAtTrigger(client = db) {
    await client.query(`
      CREATE OR REPLACE FUNCTION pharma.set_billing_invoice_updated_at()
      RETURNS TRIGGER AS $$
      BEGIN
        NEW.updated_at := CURRENT_TIMESTAMP;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
    await client.query(`DROP TRIGGER IF EXISTS trg_billing_invoice_updated_at ON pharma.billing_invoice;`);
    await client.query(`
      CREATE TRIGGER trg_billing_invoice_updated_at
      BEFORE UPDATE ON pharma.billing_invoice
      FOR EACH ROW
      EXECUTE FUNCTION pharma.set_billing_invoice_updated_at();
    `);
  }

  static async ensureTablesExist() {
    await BillingInvoice.ensureTableExists();
    await BillingItem.ensureTableExists();
  }

  static async create(client, invoice) {
    const query = `
      INSERT INTO pharma.billing_invoice (
        doctor_name, payment_type, customer_name, phone_number, patient_age, patient_gender,
        address, gstin, tax_breakdown, total_quantity, gross_amount, discount_amount,
        subtotal, flat_discount, final_payable, created_by, updated_by
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $16
      )
      RETURNING *;
    `;

    const values = [
      invoice.doctorName || null,
      invoice.paymentType || "Cash",
      invoice.customerName || null,
      invoice.phoneNumber || null,
      invoice.patientAge ?? null,
      invoice.patientGender || null,
      invoice.address || null,
      invoice.gstin || null,
      JSON.stringify(invoice.taxBreakdown || []),
      invoice.totalQuantity,
      invoice.grossAmount,
      invoice.discountAmount ?? 0,
      invoice.subtotal,
      invoice.flatDiscount ?? 0,
      invoice.finalPayable,
      invoice.createdBy || null,
    ];

    const result = await client.query(query, values);
    return result.rows[0];
  }

  static async createInvoiceWithItems(invoiceData, items) {
    await BillingInvoice.ensureTablesExist();

    const client = await db.pool.connect();
    try {
      await client.query("BEGIN");

      const invoice = await BillingInvoice.create(client, invoiceData);
      const savedItems = await BillingItem.bulkCreate(client, invoice.invoice_number, items);

      await client.query("COMMIT");
      return { invoice, items: savedItems };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  static async findByInvoiceNumber(invoiceNumber, emailid) {
    const result = await db.query(`SELECT * FROM pharma.billing_invoice WHERE invoice_number = $1 and created_by = $2;`, [invoiceNumber, emailid]);
    return result.rows[0] || null;
  }

  static async update(client, invoiceNumber, emailid, invoice) {
    const query = `
      UPDATE pharma.billing_invoice SET
        doctor_name = $1, payment_type = $2, customer_name = $3, phone_number = $4, patient_age = $5,
        patient_gender = $6, address = $7, gstin = $8, tax_breakdown = $9, total_quantity = $10,
        gross_amount = $11, discount_amount = $12, subtotal = $13, flat_discount = $14, final_payable = $15,
        updated_by = $16
      WHERE invoice_number = $17 AND created_by = $18
      RETURNING *;
    `;

    const values = [
      invoice.doctorName || null,
      invoice.paymentType || "Cash",
      invoice.customerName || null,
      invoice.phoneNumber || null,
      invoice.patientAge ?? null,
      invoice.patientGender || null,
      invoice.address || null,
      invoice.gstin || null,
      JSON.stringify(invoice.taxBreakdown || []),
      invoice.totalQuantity,
      invoice.grossAmount,
      invoice.discountAmount ?? 0,
      invoice.subtotal,
      invoice.flatDiscount ?? 0,
      invoice.finalPayable,
      invoice.updatedBy || null,
      invoiceNumber,
      emailid,
    ];

    const result = await client.query(query, values);
    return result.rows[0] || null;
  }

  static async updateInvoiceWithItems(invoiceNumber, emailid, invoiceData, items) {
    await BillingInvoice.ensureTablesExist();

    const client = await db.pool.connect();
    try {
      await client.query("BEGIN");

      const invoice = await BillingInvoice.update(client, invoiceNumber, emailid, invoiceData);
      if (!invoice) {
        await client.query("ROLLBACK");
        return null;
      }

      const savedItems = await BillingItem.replaceForInvoice(client, invoice.invoice_number, items);

      await client.query("COMMIT");
      return { invoice, items: savedItems };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  static async getInvoiceByNumber(invoiceNumber, emailid) {
    await BillingInvoice.ensureTablesExist();
    const invoice = await BillingInvoice.findByInvoiceNumber(invoiceNumber,emailid);
    if (!invoice) return null;

    const items = await BillingItem.findByInvoiceNumber(invoiceNumber);
    return { invoice, items };
  }

  static async list(emailid, page = 1, limit = 50) {
    const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 100);
    const safePage = Math.max(parseInt(page, 10) || 1, 1);
    const offset = (safePage - 1) * safeLimit;

    const [rowsResult, countResult] = await Promise.all([
      db.query(`SELECT * FROM pharma.billing_invoice WHERE created_by = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3;`, [emailid, safeLimit, offset]),
      db.query(`SELECT COUNT(*)::int AS total FROM pharma.billing_invoice WHERE created_by = $1;`, [emailid]),
    ]);

    return {
      data: rowsResult.rows,
      pagination: { page: safePage, limit: safeLimit, total: countResult.rows[0].total },
    };
  }

  static async listInvoices(emailid, page, limit) {
    await BillingInvoice.ensureTablesExist();
    return BillingInvoice.list(emailid, page, limit);
  }

  /**
   * Today's business date (YYYY-MM-DD) as seen by the database session, which is pinned
   * to Asia/Kolkata via the pool options. Using this (instead of the Node process clock)
   * keeps "today / this week / this month" boundaries consistent with how invoice_date
   * is stamped at creation time.
   * @returns {Promise<string|null>} ISO date string, e.g. "2026-09-07".
   */
  static async currentLocalDate() {
    const result = await db.query(`SELECT to_char(CURRENT_DATE, 'YYYY-MM-DD') AS today;`);
    return result.rows[0]?.today || null;
  }

  /**
   * Builds a dense, gap-filled sales revenue time-series from pharma.billing_invoice.
   *
   * Business-date semantics: rows are filtered/grouped on `invoice_date` (the local business
   * day, kept as an ISO date) rather than `created_at`, so buckets align to clean calendar
   * periods and no client-side timezone shifting is needed. Missing/zero-sale buckets are
   * included as `total: 0` via `generate_series`, so charts can render a continuous axis
   * without gaps.
   *
   * @param {object} options
   * @param {string} options.emailid - Owner (created_by) email used to scope the query.
   * @param {"day"|"week"|"month"} options.granularity - Bucket size. Weeks are ISO, Monday-start.
   * @param {string} options.startDate - Inclusive range start (YYYY-MM-DD).
   * @param {string} options.endDate - Inclusive range end (YYYY-MM-DD).
   * @returns {Promise<Array<{label: string, startDate: string, endDate: string, total: number, invoiceCount: number}>>}
   *   Ascending buckets. `label` is a chart-friendly key (e.g. "2026-08", "2026-W35", "2026-09-07"),
   *   `startDate`/`endDate` delimit the exact calendar bucket, `total` is revenue from
   *   `final_payable` (net of discounts) and `invoiceCount` the number of invoices in it.
   */
  static async revenueTimeSeries({ emailid, granularity, startDate, endDate }) {
    const bucket = REVENUE_BUCKETS[granularity];
    if (!bucket) {
      throw new Error(`Unsupported granularity "${granularity}". Use one of: day, week, month`);
    }

    // `invoice_date` may be physically stored as DATE or as ISO TEXT (both have occurred in this
    // schema). Casting it to date keeps the filters/grouping type-safe regardless of the deployed
    // column type; every user-supplied value is still parameterized.
    const sql = `
      WITH series AS (
        SELECT generate_series(
                 date_trunc('${bucket.sqlUnit}', $2::date::timestamp),
                 date_trunc('${bucket.sqlUnit}', $3::date::timestamp),
                 ${bucket.seriesStep}
               ) AS bucket_start
      ),
      agg AS (
        SELECT date_trunc('${bucket.sqlUnit}', invoice_date::date::timestamp) AS bucket_start,
               COUNT(*)::int                                                 AS invoice_count,
               COALESCE(SUM(final_payable), 0)                               AS total
        FROM pharma.billing_invoice
        WHERE created_by = $1
          AND invoice_date::date >= $2::date
          AND invoice_date::date <= $3::date
        GROUP BY date_trunc('${bucket.sqlUnit}', invoice_date::date::timestamp)
      )
      SELECT ${bucket.labelExpr}                                 AS label,
             to_char(s.bucket_start::date, 'YYYY-MM-DD')         AS start_date,
             to_char(${bucket.endExpr}, 'YYYY-MM-DD')            AS end_date,
             COALESCE(a.total, 0)::numeric(14, 2)                AS total,
             COALESCE(a.invoice_count, 0)::int                   AS invoice_count
      FROM series s
      LEFT JOIN agg a ON a.bucket_start = s.bucket_start
      ORDER BY s.bucket_start ASC;
    `;

    const result = await db.query(sql, [emailid, startDate, endDate]);
    return result.rows.map((row) => ({
      label: row.label,
      startDate: row.start_date,
      endDate: row.end_date,
      total: Number(row.total),
      invoiceCount: row.invoice_count,
    }));
  }

  /**
   * Single-window revenue rollup (total + invoice count) for a given inclusive date range.
   * Used by the dashboard KPI summary; every value is parameterized.
   * @param {object} options
   * @param {string} options.emailid - Owner (created_by) email used to scope the query.
   * @param {string} options.startDate - Inclusive range start (YYYY-MM-DD).
   * @param {string} options.endDate - Inclusive range end (YYYY-MM-DD).
   * @returns {Promise<{total: number, invoiceCount: number}>}
   */
  static async revenueTotals({ emailid, startDate, endDate }) {
    const result = await db.query(
      `SELECT COALESCE(SUM(final_payable), 0)::numeric(14, 2) AS total,
              COUNT(*)::int                                   AS invoice_count
       FROM pharma.billing_invoice
       WHERE created_by = $1
         AND invoice_date::date >= $2::date
         AND invoice_date::date <= $3::date;`,
      [emailid, startDate, endDate]
    );
    const row = result.rows[0] || { total: "0", invoice_count: 0 };
    return { total: Number(row.total), invoiceCount: row.invoice_count };
  }
}

module.exports = BillingInvoice;
