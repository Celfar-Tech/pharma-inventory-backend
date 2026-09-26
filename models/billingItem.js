const db = require("../database");

// Table: pharma.billing_items — line items belonging to an invoice
class BillingItem {
  static async ensureTableExists(client = db) {
    await client.query("CREATE SCHEMA IF NOT EXISTS pharma;");
    await client.query(`
      CREATE TABLE IF NOT EXISTS pharma.billing_items (
        item_id BIGSERIAL PRIMARY KEY,
        invoice_number VARCHAR(50) NOT NULL REFERENCES pharma.billing_invoice(invoice_number) ON DELETE CASCADE,
        medicine_id BIGINT,
        medicine_name VARCHAR(200) NOT NULL,
        batch VARCHAR(100) NOT NULL,
        expiry_date DATE NOT NULL,
        qty INT NOT NULL CHECK (qty > 0),
        pack VARCHAR(50) DEFAULT 'Strip',
        mrp DECIMAL(10, 2) NOT NULL,
        selling_price DECIMAL(10, 2) NOT NULL,
        discount DECIMAL(10, 2) DEFAULT 0.00,
        gst_percentage DECIMAL(5, 2) NOT NULL DEFAULT 0.00,
        gst_amount DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
        hsn_code VARCHAR(20),
        taxable_amount DECIMAL(10, 2) NOT NULL,
        total DECIMAL(10, 2) NOT NULL
      );
    `);
  }

  static async bulkCreate(client, invoiceNumber, items) {
    const columnsPerRow = 15;
    const values = [];
    const placeholders = items
      .map((item, rowIndex) => {
        const base = rowIndex * columnsPerRow;
        values.push(
          invoiceNumber,
          item.medicineId ?? null,
          item.medicineName,
          item.batch,
          item.expiryDate,
          item.qty,
          item.pack || "Strip",
          item.mrp,
          item.sellingPrice,
          item.discount ?? 0,
          item.gstPercentage ?? 0,
          item.gstAmount ?? 0,
          item.hsnCode || null,
          item.taxableAmount,
          item.total
        );
        const placeholderNumbers = Array.from({ length: columnsPerRow }, (_, i) => `$${base + i + 1}`);
        return `(${placeholderNumbers.join(", ")})`;
      })
      .join(", ");

    const query = `
      INSERT INTO pharma.billing_items (
        invoice_number, medicine_id, medicine_name, batch, expiry_date, qty, pack,
        mrp, selling_price, discount, gst_percentage, gst_amount, hsn_code, taxable_amount, total
      ) VALUES ${placeholders}
      RETURNING *;
    `;

    const result = await client.query(query, values);
    return result.rows;
  }

  static async findByInvoiceNumber(invoiceNumber) {
    const result = await db.query(
      `SELECT * FROM pharma.billing_items WHERE invoice_number = $1 ORDER BY item_id ASC;`,
      [invoiceNumber]
    );
    return result.rows;
  }

  // Full replace keeps item_id sequencing simple and avoids diffing add/edit/remove client-side.
  static async replaceForInvoice(client, invoiceNumber, items) {
    await client.query(`DELETE FROM pharma.billing_items WHERE invoice_number = $1;`, [invoiceNumber]);
    if (!items.length) return [];
    return BillingItem.bulkCreate(client, invoiceNumber, items);
  }

  /**
   * Removes every line item belonging to an invoice and returns the removed rows.
   * Runs on the caller-supplied client so it participates in the invoice delete transaction
   * (a failure here must roll back the invoice header deletion as well).
   * RETURNING * is used so the caller can snapshot the exact deleted rows into
   * pharma.billing_items_backup without a second (and potentially racy) SELECT.
   * @param {object} client - Pool or transaction client.
   * @param {string} invoiceNumber - Invoice whose items should be removed.
   * @returns {Promise<Array<Object>>} The deleted rows (empty array when the invoice had no items).
   */
  static async deleteByInvoiceNumber(client, invoiceNumber) {
    const result = await client.query(`DELETE FROM pharma.billing_items WHERE invoice_number = $1 RETURNING *;`, [
      invoiceNumber,
    ]);
    return result.rows;
  }
}

module.exports = BillingItem;
