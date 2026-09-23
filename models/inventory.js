const db = require("../database");
const InventoryBackup = require("./inventory_backup");
/**
 * Represents an inventory item with medicine details and stock information.
 * @class
 */
class Inventory {
  /**
   * Creates an instance of Inventory.
   * @param {string} name - The name of the medicine
   * @param {string} manufacturerName - The name of the manufacturer
   * @param {string} type - The type/category of medicine
   * @param {string} packSizeLabel - The label for the pack size
   * @param {string} composition1 - First composition ingredient
   * @param {number} mrp - Maximum Retail Price
   * @param {number} stockQuantity - Current stock quantity
   * @param {number} purchasePrice - Purchase price per unit
   * @param {number} sellingPrice - Selling price per unit
   * @param {number} stockAlertThreshold - Threshold for stock alerts
   * @param {Date} expiryDate - Expiry date of the medicine
   * @param {string} userName - Username associated with the record
   * @param {Date} insertDate - Date when the record was inserted
   * @param {Date} updateDate - Date when the record was last updated
   */
  constructor(
    name,
    manufacturerName,
    type,
    packSizeLabel,
    composition1,
    mrp,
    batchNumber,
    shelfRackInfo,
    stockQuantity,
    purchasePrice,
    sellingPrice,
    stockAlertThreshold,
    expiryDate,
    userName,
    insertDate,
    updateDate
  ) {
    this.name = name;
    this.manufacturerName = manufacturerName;
    this.type = type;
    this.packSizeLabel = packSizeLabel;
    this.composition1 = composition1;
    this.mrp = mrp;
    this.batchNumber = batchNumber;
    this.shelfRackInfo = shelfRackInfo;
    this.stockQuantity = stockQuantity;
    this.purchasePrice = purchasePrice;
    this.sellingPrice = sellingPrice;
    this.stockAlertThreshold = stockAlertThreshold;
    this.expiryDate = expiryDate;
    this.userName = userName;
    this.insertDate = insertDate;
    this.updateDate = updateDate;
  }

  /**
   * Ensures the inventory table exists in the database by creating the schema and table if needed.
   * @static
   * @async
   * @returns {Promise<void>}
   * @throws {Error} If table creation fails
   */
  static async ensureTableExists() {
    // 1. Create the schema if it doesn't exist
    const createSchemaQuery = "CREATE SCHEMA IF NOT EXISTS pharma;";
    await db.query(createSchemaQuery);

    const createTableQuery = `
     CREATE TABLE IF NOT EXISTS pharma.inventory (
    id SERIAL PRIMARY KEY,
    name VARCHAR(500) NOT NULL,
    manufacturer_name VARCHAR(500) NOT NULL,
    type VARCHAR(50) NOT NULL,
    pack_size_label VARCHAR(100),
    composition1 TEXT,
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
    CONSTRAINT unique_medicine_identity UNIQUE (name, manufacturer_name, pack_size_label, composition1, user_name, batch_number)
);
    `;
    await db.query(createTableQuery);

    await InventoryBackup.ensureTableExists();
  }

  /**
   * Adds or updates an inventory record in the database.
   * If a record with the same identity exists, it updates the stock quantity and other fields.
   * @async
   * @returns {Promise<Object>} Database query result with the saved/updated record
   * @throws {Error} If table creation or database operation fails
   */
  async addInventory() {
    try {
      await Inventory.ensureTableExists();
    } catch (error) {
      throw new Error(`Failed to ensure inventory table exists: ${error.message}`);
    }

    const query = `
      INSERT INTO pharma.inventory (
        name, manufacturer_name, type, pack_size_label, composition1, 
        mrp, batch_number, shelf_rack_info, stock_quantity, purchase_price, selling_price, stock_alert_threshold,
        expiry_date, user_name, insert_date, update_date
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16
      )
      ON CONFLICT ON CONSTRAINT unique_medicine_identity 
      DO UPDATE SET 
        -- 1. Increment the stock quantity by adding the incoming stock
        stock_quantity = EXCLUDED.stock_quantity,
        type = EXCLUDED.type,
        mrp = EXCLUDED.mrp,
        shelf_rack_info = EXCLUDED.shelf_rack_info,
        purchase_price = EXCLUDED.purchase_price,
        selling_price = EXCLUDED.selling_price,
        stock_alert_threshold = EXCLUDED.stock_alert_threshold,
        expiry_date = EXCLUDED.expiry_date,
        update_date = CURRENT_TIMESTAMP
      RETURNING *;
    `;

    return db.query(query, [
      this.name,
      this.manufacturerName,
      this.type,
      this.packSizeLabel,
      this.composition1,
      this.mrp,
      this.batchNumber,
      this.shelfRackInfo,
      this.stockQuantity,
      this.purchasePrice,
      this.sellingPrice,
      this.stockAlertThreshold,
      this.expiryDate,
      this.userName,
      this.insertDate,
      this.updateDate,
    ]);
  }

  /**
   * Searches inventory records with filtering, sorting, and pagination.
   * @static
   * @async
   * @param {Object} searchParams - Search criteria object
   * @param {string} [searchParams.name] - Medicine name to search for (case-insensitive)
   * @param {string} [searchParams.manufacturer_name] - Manufacturer name to search for (case-insensitive)
   * @param {string} [searchParams.type] - Medicine type to search for (case-insensitive)
   * @param {string} [searchParams.composition1] - First composition to search for (case-insensitive)
   * @param {string} [userOrderBy=name] - Field to sort results by (default: 'name')
   * @param {number} [page=1] - Page number for pagination (default: 1)
   * @param {number} [limit=50] - Number of records per page (default: 50)
   * @returns {Promise<Array>} Array of inventory records matching the search criteria
   * @throws {Error} If database operations fail
   */
  static async searchInventory(emailid, searchParams = {}, userOrderBy = "name", page = 1, limit = 50) {
    try {
      if (typeof Inventory.ensureTableExists === "function") {
        await Inventory.ensureTableExists();
      }
    } catch (tableErr) {
      console.warn("Table existence check skipped/failed:", tableErr.message);
    }

    const allowedColumns = ["name", "manufacturer_name", "type", "composition1", "batch_number"];

    const safeUserOrderBy = allowedColumns.includes(userOrderBy) ? userOrderBy : "name";

    const whereClauses = [];
    const queryValues = [];
    let paramIndex = 1;

    // 1. Extract search term(s) from searchParams
    // Prefer explicit `search`, otherwise treat each allowed string filter value as a search term.
    const searchTerms = [];
    const explicitSearch = typeof searchParams.search === "string" ? searchParams.search.trim() : "";
    if (explicitSearch) {
      searchTerms.push(explicitSearch);
    } else {
      for (const [key, val] of Object.entries(searchParams)) {
        if (!allowedColumns.includes(key) || typeof val !== "string") continue;
        const trimmed = val.trim();
        if (trimmed) searchTerms.push(trimmed);
      }
    }

    // 2. If search term(s) are found, search them against ANY of the allowed text columns
    for (const term of searchTerms) {
      const orClauses = allowedColumns.map(column => `${column} ILIKE $${paramIndex}`);
      whereClauses.push(`(${orClauses.join(" OR ")})`);
      queryValues.push(`%${term}%`);
      paramIndex++;
    }

    // 3. Handle any non-string specific filters (like IDs, booleans, status numbers) if present
    for (const [column, value] of Object.entries(searchParams)) {
      if (column === "search" || typeof value === "string") continue; // Skip text search terms already handled

      if (allowedColumns.includes(column) && value !== undefined && value !== null && value !== "") {
        whereClauses.push(`${column} = $${paramIndex}`);
        queryValues.push(value);
        paramIndex++;
      }
    }

    // 4. Get Total Count for Pagination (Reusing the identical whereClauses)
    let totalCount = 0;
    try {
      // Always scope the count to the logged-in user, even when there are no search filters.
      const countWhereClauses = [
        ...whereClauses,
        `user_name = $${queryValues.length + 1}`,
      ];

      const countQuery = `SELECT COUNT(*) as total FROM pharma.inventory WHERE ${countWhereClauses.join(" AND ")}`;

      const countResult = await db.query(countQuery, [...queryValues, emailid]);
      totalCount = parseInt(countResult.rows[0].total) || 0;
    } catch (countErr) {
      console.warn('Could not get total count:', countErr.message);
      totalCount = 0;
    }
    ///////////////////////////////

    whereClauses.push(`user_name = $${queryValues.length + 1}`);
    queryValues.push(emailid);

    // 5. Build the Main Query for Records
    let queryStr = "SELECT * FROM pharma.inventory";

    if (whereClauses.length > 0) {
      queryStr += ` WHERE ${whereClauses.join(" AND ")}`;
    }

    // Sorting
    if (userOrderBy !== "insert_date" && allowedColumns.includes(userOrderBy)) {
      const textColumns = ["name", "manufacturer_name", "type", "pack_size_label", "composition1", "batch_number", "user_name"];
      if (textColumns.includes(safeUserOrderBy)) {
        queryStr += ` ORDER BY LOWER(${safeUserOrderBy}) ASC`;
      } else {
        queryStr += ` ORDER BY ${safeUserOrderBy} ASC`;
      }
    } else {
      queryStr += " ORDER BY insert_date DESC";
    }
    // Pagination bounds
    const offset = (page - 1) * limit;
    queryStr += ` LIMIT ${limit} OFFSET ${offset};`;

    const result = await db.query(queryStr, queryValues);
    const records = result.rows;

    // Calculate pagination metadata
    const totalPages = Math.ceil(totalCount / limit);
    const hasNext = page < totalPages;
    const hasPrev = page > 1;

    return {
      data: records,
      pagination: {
        page: page,
        limit: limit,
        total: totalCount,
        totalPages: totalPages,
        hasNext: hasNext,
        hasPrev: hasPrev,
        hasNextPage: hasNext ? page + 1 : null,
        hasPrevPage: hasPrev ? page - 1 : null
      }
    };
  }

  /**
   * Fetches all batch numbers recorded for a given medicine name.
   * @static
   * @async
   * @param {string} name - Exact medicine name to look up
   * @returns {Promise<Array<string>>} Array of batch numbers
   * @throws {Error} If database operations fail
   */
  static async getBatchNumbersByName(name, emailid) {
    const queryStr = "SELECT batch_number,mrp, selling_price, expiry_date FROM pharma.inventory WHERE name = $1 AND user_name = $2;";
    const result = await db.query(queryStr, [name, emailid]);

    return result.rows.map(row => ({
      batchNumber: row.batch_number,
      mrp: row.mrp,
      sellingPrice: row.selling_price,
      expiryDate: row.expiry_date,
    }));
  }

  static async deleteById(id, deletedBy = 'system', reason = 'User Request',useremail) {
    // Start a transaction so if anything fails, the database rolls back safely
    await db.query("BEGIN");

    try {
      // 1. Delete the item and IMMEDIATELY return its data using RETURNING *
      const deleteQueryStr = `
      DELETE FROM pharma.inventory 
      WHERE id = $1 and user_name = $2
      RETURNING *;
    `;
      const deleteResult = await db.query(deleteQueryStr, [id, useremail]);

      // If no row was found/deleted, roll back and return 0
      if (deleteResult.rowCount === 0) {
        await db.query("ROLLBACK");
        return 0;
      }

      // The deleted item's data is sitting right here:
      const oldData = deleteResult.rows[0];

      try {
        await InventoryBackup.insert(oldData, deletedBy, reason);
      } catch (backupError) {
        console.error('Failed to backup inventory item:', backupError);
        throw new Error(`Failed to backup inventory item before deletion: ${backupError.message}`);
      }

      // Everything worked smoothly. Commit the transaction permanent!
      await db.query("COMMIT");
      return 1;

    } catch (error) {
      // If anything blew up during backup, cancel the deletion completely
      await db.query("ROLLBACK");
      throw error;
    }
  }
}

module.exports = Inventory;
