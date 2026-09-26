const db = require("../database");

/**
 * Audit trail for deleted invoice line items.
 * Table: pharma.billing_items_backup — a snapshot of every row removed from
 * pharma.billing_items, so an invoice can be reconstructed after deletion.
 * Sibling of InvoiceBackup (which snapshots the billing_invoice header).
 */
class BillingItemBackup {
  /**
   * Ensures the audit table pharma.billing_items_backup exists.
   * Columns mirror pharma.billing_items plus the deletion metadata, so a deleted
   * line item can be replayed without losing any original values.
   * @static
   * @async
   * @param {object} [client=db] - Pool or transaction client used to run the DDL.
   * @returns {Promise<void>}
   */
  static async ensureTableExists(client = db) {
    await client.query("CREATE SCHEMA IF NOT EXISTS pharma;");
    await client.query(`
      CREATE TABLE IF NOT EXISTS pharma.billing_items_backup (
        backup_id BIGSERIAL PRIMARY KEY,
        item_id BIGINT,
        invoice_number VARCHAR(50),
        medicine_id BIGINT,
        medicine_name VARCHAR(200),
        batch VARCHAR(100),
        expiry_date DATE,
        qty INT,
        pack VARCHAR(50),
        mrp DECIMAL(10, 2),
        selling_price DECIMAL(10, 2),
        discount DECIMAL(10, 2),
        gst_percentage DECIMAL(5, 2),
        gst_amount DECIMAL(10, 2),
        hsn_code VARCHAR(20),
        taxable_amount DECIMAL(10, 2),
        total DECIMAL(10, 2),
        deleted_by VARCHAR(150),
        deleted_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);
  }

  /**
   * Snapshots deleted line items into the backup table in a single multi-row INSERT.
   * Runs on the caller-supplied client so the backup shares the delete transaction:
   * if this fails, the invoice deletion is rolled back with it.
   * @static
   * @async
   * @param {Array<Object>} items - Rows returned by the DELETE ... RETURNING * in
   *   BillingItem.deleteByInvoiceNumber (snake_case DB columns).
   * @param {string} useremail - Identifier of who deleted the rows (deleted_by).
   * @param {object} [client=db] - Transaction client.
   * @returns {Promise<Array<Object>>} The inserted backup rows.
   */
  static async insertMany(items, useremail, client = db) {
    if (!items || items.length === 0) return [];

    const columnsPerRow = 17;
    const values = [];
    const placeholders = items
      .map((item, rowIndex) => {
        const base = rowIndex * columnsPerRow;
        values.push(
          item.item_id ?? null,
          item.invoice_number ?? null,
          item.medicine_id ?? null,
          item.medicine_name ?? null,
          item.batch ?? null,
          item.expiry_date ?? null,
          item.qty ?? null,
          item.pack ?? null,
          item.mrp ?? null,
          item.selling_price ?? null,
          item.discount ?? 0,
          item.gst_percentage ?? 0,
          item.gst_amount ?? 0,
          item.hsn_code ?? null,
          item.taxable_amount ?? null,
          item.total ?? null,
          useremail ?? null
        );
        const placeholderNumbers = Array.from({ length: columnsPerRow }, (_, i) => `$${base + i + 1}`);
        return `(${placeholderNumbers.join(", ")})`;
      })
      .join(", ");

    const query = `
      INSERT INTO pharma.billing_items_backup (
        item_id, invoice_number, medicine_id, medicine_name, batch, expiry_date, qty, pack,
        mrp, selling_price, discount, gst_percentage, gst_amount, hsn_code, taxable_amount, total,
        deleted_by
      ) VALUES ${placeholders}
      RETURNING *;
    `;

    const result = await client.query(query, values);
    return result.rows;
  }
}

module.exports = BillingItemBackup;
