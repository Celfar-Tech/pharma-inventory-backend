const db = require("../database");

/**
 * Represents a soft-deleted inventory record kept for audit purposes.
 * @class
 */
class InventoryBackup {
  /**
   * Ensures the inventory_backup table exists in the database.
   * @static
   * @async
   * @returns {Promise<void>}
   */
  static async ensureTableExists() {
    const createSchemaQuery = "CREATE SCHEMA IF NOT EXISTS pharma;";
    await db.query(createSchemaQuery);

    const createBackupTableQuery = `
      CREATE TABLE IF NOT EXISTS pharma.inventory_backup (
        id SERIAL PRIMARY KEY, 
        name VARCHAR(500) NOT NULL,
        manufacturer_name VARCHAR(500) NOT NULL,
        type VARCHAR(50) NOT NULL,
        pack_size_label VARCHAR(100),
        composition1 TEXT,
        composition2 TEXT,
        mrp NUMERIC(10, 2),
        batch_number VARCHAR(100) NOT NULL,
        shelf_rack_info VARCHAR(100),         -- New column added here
        stock_quantity INTEGER,
        purchase_price NUMERIC(10, 2),
        selling_price NUMERIC(10, 2),
        stock_alert_threshold INTEGER DEFAULT 10,
        expiry_date DATE,
        user_name VARCHAR(500),
        insert_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        update_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        deleted_by VARCHAR(500),
        deleted_reason TEXT,
        deleted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `;
    await db.query(createBackupTableQuery);
  }

  /**
   * Inserts a deleted inventory record into the backup table.
   * @static
   * @async
   * @param {Object} oldData - The deleted inventory row.
   * @param {string} deletedBy - Identifier of who deleted the record.
   * @param {string} reason - Reason for deletion.
   * @returns {Promise<Object>} Database query result.
   */
  static async insert(oldData,useremail) {
    const backupQueryStr = `
      INSERT INTO pharma.inventory_backup (
        id, name, manufacturer_name, type, pack_size_label, composition1, 
        mrp,batch_number,shelf_rack_info, stock_quantity, purchase_price, selling_price, stock_alert_threshold,
        expiry_date, user_name, insert_date, update_date, deleted_by, deleted_reason
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19
      );
    `;

    const backupValues = [
      oldData.id,
      oldData.name,
      oldData.manufacturer_name,
      oldData.type,
      oldData.pack_size_label,
      oldData.composition1,
      oldData.mrp,
      oldData.batch_number,
      oldData.shelf_rack_info,
      oldData.stock_quantity,
      oldData.purchase_price,
      oldData.selling_price,
      oldData.stock_alert_threshold,
      oldData.expiry_date,
      oldData.user_name,
      oldData.insert_date,
      oldData.update_date,
      useremail, // deleted_by
      'User Request', // deleted_reason
    ];

    return db.query(backupQueryStr, backupValues);
  }
}

module.exports = InventoryBackup;
