
const Inventory = require("../models/inventory");

exports.addInventory = async (req, res, next) => {

  if (Array.isArray(req.body)) {
    return res.status(400).json({ error: "Array payloads are not allowed" });
  };
  const payload = req.body;
  const name = payload.name;
  const manufacturerName = payload.manufacturername;
  const type = payload.type;
  const packSizeLabel = payload.packsizelabel;
  const composition1 = payload.composition1;
  const mrp = payload.mrp ? parseFloat(payload.mrp) : null;
  const batchNumberRaw = payload.batchnumber;
  const batchNumber = typeof batchNumberRaw === "string" ? batchNumberRaw : (batchNumberRaw == null ? "" : String(batchNumberRaw));
  const shelfRackInfoRaw = payload.shelfrackinfo;
  const shelfRackInfo = typeof shelfRackInfoRaw === "string" ? shelfRackInfoRaw : (shelfRackInfoRaw == null ? null : String(shelfRackInfoRaw));
  const stockQuantity = payload.stockquantity ? parseInt(payload.stockquantity) : null;
  const userName = req.user?.email;
  const purchasePrice = payload.purchaseprice ? parseFloat(payload.purchaseprice) : null;
  const sellingPrice = payload.sellingprice ? parseFloat(payload.sellingprice) : null;
  if (mrp && (isNaN(mrp) || mrp < 0)) {
    return res.status(400).json({ error: "Invalid MRP value" });
  }
  if (stockQuantity !== null && (isNaN(stockQuantity) || stockQuantity <= 0)) {
    return res.status(400).json({ error: "Invalid stock quantity" });
  }
  if (purchasePrice !== null && (isNaN(purchasePrice) || purchasePrice < 0)) {
    return res.status(400).json({ error: "Invalid purchase price" });
  }
  if (sellingPrice !== null && (isNaN(sellingPrice) || sellingPrice < 0)) {
    return res.status(400).json({ error: "Invalid selling price" });
  }
  const stockAlertThreshold = payload.stockalertthreshold;
  const expiryDate = payload.expirydate ? new Date(payload.expirydate) : null;
  if (expiryDate && isNaN(expiryDate.getTime())) {
    return res.status(400).json({ error: "Invalid expiry date format" });
  }
  // const userName = payload.username;
  const insertDate = payload.insertdate;
  const updateDate = payload.updatedate;

  // Input validation
  if (!name || name.trim() === '') {
    return res.status(400).json({ error: "Medicine name is required" });
  }
  if (!manufacturerName || manufacturerName.trim() === '') {
    return res.status(400).json({ error: "Manufacturer name is required" });
  }
  if (stockQuantity === null || stockQuantity <= 0) {
    return res.status(400).json({ error: "Stock quantity must be greater than zero" });
  }
  if (!batchNumber || batchNumber.trim() === '') {
    return res.status(400).json({ error: "Batch number is required" });
  }

  try {
    const new_inventory = new Inventory(name, manufacturerName, type, packSizeLabel, composition1, mrp, batchNumber, shelfRackInfo, stockQuantity, purchasePrice, sellingPrice, stockAlertThreshold, expiryDate, userName, insertDate, updateDate);
    const response = await new_inventory.addInventory();

    const savedItem = response.rows?.[0];

    // Safety fallback check to ensure database returned data properly
    if (!savedItem) {
      return res.status(500).json({ error: "Failed to save or retrieve inventory record from the database response." });
    }
    const isNewInsert = !savedItem.update_date || new Date(savedItem.insert_date).getTime() >= new Date(savedItem.update_date).getTime();
    const actionTaken = isNewInsert ? 'inserted' : 'updated';
    return res.status(201).json({
      success: true,
      action: actionTaken,
      message: actionTaken === 'inserted'
        ? "Medicine added successfully"
        : "Inventory stock merged and details updated successfully",
      data: savedItem
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Internal server error occurred" });
  }
};


exports.getInventory = async (req, res, next) => {
  try {
    // Extract everything straight from the URL query params
    const { sortBy, page, limit, ...searchParams } = req.query;

    const parsedPage = parseInt(page, 10) || 1;
    const parsedLimit = parseInt(limit, 10) || 50;
    const safeLimit = Math.min(parsedLimit, 50);
    const safeSortBy = sortBy || 'name';
    const emailid = req.user?.email || null;
    // Call the model passing the search object directly
    const result = await Inventory.searchInventory(
      emailid,
      searchParams,
      safeSortBy,
      parsedPage,
      safeLimit
    );

    const medicines = result.data;
    const pagination = result?.pagination || { page: parsedPage, limit: safeLimit, total: 0 };

    const searchKeys = Object.keys(searchParams);
    const searchSummary = searchKeys.length > 0
      ? searchKeys.map(key => `${key}: "${searchParams[key]}"`).join(', ')
      : 'all inventory';

    if (!medicines || medicines.length === 0) {
      return res.status(404).json({
        success: false,
        message: `No medicines found matching parameters (${searchSummary})`,
        data: [],
        pagination: pagination
      });
    }

    return res.status(200).json({
      success: true,
      message: medicines.length > 0
        ? `Loaded records matching (${searchSummary})`
        : `No medicines found matching parameters (${searchSummary})`,
      data: medicines,
      pagination: pagination
    });

  } catch (err) {
    console.error(`Inventory fetch error:`, err);
    return res.status(500).json({
      success: false,
      error: "Internal server error but",
      errorId: `ERR-${Date.now()}`
    });
  }
};

exports.getBatchNumbers = async (req, res, next) => {
  try {
    const name = req.query.name;
    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, error: "Medicine name is required" });
    }

    console.log(`Fetching batch numbers for medicine: ${name} and user: ${req.user?.email}`);
    const batchNumbers = await Inventory.getBatchNumbersByName(name.trim(), req.user?.email);

    if (!batchNumbers || batchNumbers.length === 0) {
      return res.status(404).json({
        success: false,
        message: `No batch numbers found for medicine "${name}"`,
        data: []
      });
    }

    return res.status(200).json({
      success: true,
      message: `Loaded batch numbers for "${name}"`,
      data: batchNumbers
    });
  } catch (err) {
    console.error("Batch number fetch error:", err);
    return res.status(500).json({
      success: false,
      error: "Internal server error",
      errorId: `ERR-${Date.now()}`
    });
  }
};


exports.deleteInventory = async (req, res, next) => {
  try {
    const { id } = req.params;
    //const { user, reason } = req.query;
    const user = req.user?.username || req.user?.email || req.query.user || "System";
    const reason = req.query.reason || "User Request";
    if (!id || isNaN(id) || parseInt(id) <= 0) {
      return res.status(400).json({
        success: false,
        message: "Missing required parameter: id"
      });
    }
    const deletedCount = await Inventory.deleteById(id, user, reason, req.user?.email);

    if (deletedCount === 0) {
      return res.status(404).json({
        success: false,
        message: `No inventory item found with ID: ${id}`
      });
    }

    return res.status(200).json({
      success: true,
      message: `Successfully backed up and deleted inventory item with ID: ${id}`
    });

  } catch (err) {
    console.error(`Inventory deletion error:`, err);
    return res.status(500).json({
      success: false,
      error: "Internal server error",
      errorId: `ERR-${Date.now()}`
    });
  }
};
