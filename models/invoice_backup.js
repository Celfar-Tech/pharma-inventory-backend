const db = require("../database");

/**
 * Represents a soft-deleted inventory record kept for audit purposes.
 * @class
 */
class InvoiceBackup {

  /**
   * Ensures the audit table pharma.billing_invoice_backup exists.
   * The column list mirrors insert() below so a deleted invoice can always be recorded,
   * even on a fresh database where no migration has created the backup table yet.
   * @static
   * @async
   * @param {object} [client=db] - Pool or transaction client used to run the DDL.
   * @returns {Promise<void>}
   */
  static async ensureTableExists(client = db) {
    await client.query("CREATE SCHEMA IF NOT EXISTS pharma;");
    await client.query(`
      CREATE TABLE IF NOT EXISTS pharma.billing_invoice_backup (
        backup_id BIGSERIAL PRIMARY KEY,
        invoice_number VARCHAR(50),
        invoice_date DATE,
        doctor_name VARCHAR(150),
        payment_type VARCHAR(50),
        customer_name VARCHAR(150),
        phone_number VARCHAR(15),
        patient_age INT,
        patient_gender VARCHAR(20),
        address TEXT,
        gstin VARCHAR(15),
        tax_breakdown JSONB DEFAULT '[]'::jsonb,
        total_quantity INT,
        gross_amount DECIMAL(12, 2),
        discount_amount DECIMAL(12, 2),
        subtotal DECIMAL(12, 2),
        flat_discount DECIMAL(12, 2),
        final_payable DECIMAL(12, 2),
        created_by VARCHAR(150),
        updated_by VARCHAR(150),
        created_at TIMESTAMP WITH TIME ZONE,
        updated_at TIMESTAMP WITH TIME ZONE,
        deleted_by VARCHAR(150),
        deleted_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);
  }

  /**
   * Inserts a deleted invoice header into the backup table.
   * @static
   * @async
   * @param {Object} oldData - The deleted billing_invoice row.
   * @param {string} useremail - Identifier of who deleted the record (deleted_by).
   * @param {object} [client=db] - Transaction client, so the backup shares the delete transaction.
   * @returns {Promise<Object>} Database query result.
   */
  static async insert(oldData, useremail, client = db) {
    const backupQueryStr = `
        INSERT INTO pharma.billing_invoice_backup (
            invoice_number, invoice_date, doctor_name, payment_type, 
            customer_name, phone_number, patient_age, patient_gender, 
            address, gstin, tax_breakdown, total_quantity, gross_amount, 
            discount_amount, subtotal, flat_discount, final_payable, 
            created_by, updated_by, created_at, updated_at, deleted_by, deleted_at
        ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, timezone('Asia/Kolkata'::text, clock_timestamp())
        );
    `;

    const backupValues = [
        oldData.invoice_number,
        oldData.invoice_date,
        oldData.doctor_name,
        oldData.payment_type,
        oldData.customer_name,
        oldData.phone_number,
        oldData.patient_age,
        oldData.patient_gender,
        oldData.address,
        oldData.gstin,
        JSON.stringify(oldData.tax_breakdown || []), // Ensures JSON objects pass correctly to Postgres
        oldData.total_quantity,
        oldData.gross_amount,
        oldData.discount_amount,
        oldData.subtotal,
        oldData.flat_discount,
        oldData.final_payable,
        oldData.created_by,
        oldData.updated_by,
        oldData.created_at,
        oldData.updated_at,
        useremail
    ];

    return client.query(backupQueryStr, backupValues);
  }
}

module.exports = InvoiceBackup;
