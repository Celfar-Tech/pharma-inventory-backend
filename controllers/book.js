const Book = require("../models/book");
const { sendSupplierOrderEmail } = require("../utils/mailer");

const sendError = (res, err, message) => {
  console.error(message, err);
  return res.status(500).json({ success: false, error: "Internal server error" });
};

exports.getEntries = async (req, res) => {
  try {
    const entries = await Book.listActive(req.user?.email);
    return res.status(200).json({ success: true, data: entries });
  } catch (err) {
    return sendError(res, err, "Book entries fetch error:");
  }
};

exports.getHistory = async (req, res) => {
  try {
    const history = await Book.listLedgers(req.user?.email);
    return res.status(200).json({ success: true, data: history });
  } catch (err) {
    return sendError(res, err, "Book history fetch error:");
  }
};

/** Expands one placed order: the ledger summary plus its ordered medicines. */
exports.getLedgerItems = async (req, res) => {
  try {
    const ledgerId = typeof req.params.ledgerId === "string" ? req.params.ledgerId.trim() : "";
    if (!ledgerId) {
      return res.status(400).json({ success: false, error: "Missing required parameter: ledgerId" });
    }

    const result = await Book.listLedgerItems(req.user?.email, ledgerId);
    if (!result.ledger) {
      return res.status(404).json({
        success: false,
        message: `No order found with ID: ${ledgerId}`,
      });
    }

    return res.status(200).json({ success: true, data: result });
  } catch (err) {
    return sendError(res, err, "Book ledger fetch error:");
  }
};

exports.upsertEntry = async (req, res) => {
  try {
    if (Array.isArray(req.body)) {
      return res.status(400).json({ success: false, error: "Array payloads are not allowed" });
    }

    const name = typeof req.body.name === "string" ? req.body.name.trim() : "";
    if (!name) {
      return res.status(400).json({ success: false, error: "Medicine name is required" });
    }
    const quantity = parseInt(req.body.quantity, 10);
    if (!quantity || quantity <= 0) {
      return res.status(400).json({ success: false, error: "Quantity must be greater than zero" });
    }

    const result = await Book.upsertEntry(req.user?.email, req.body);
    return res.status(201).json({
      success: true,
      message: result.merged ? "Line quantity updated" : "Line added to order book",
      data: result,
    });
  } catch (err) {
    return sendError(res, err, "Book upsert error:");
  }
};

exports.updateEntry = async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id || id <= 0) {
      return res.status(400).json({ success: false, error: "Missing required parameter: id" });
    }

    const result = await Book.updateEntry(req.user?.email, id, req.body || {});
    if (!result.entry) {
      return res.status(404).json({
        success: false,
        message: `No order book item found with ID: ${id}`,
      });
    }
    return res.status(200).json({ success: true, message: "Line updated", data: result });
  } catch (err) {
    return sendError(res, err, "Book update error:");
  }
};

exports.removeEntry = async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id || id <= 0) {
      return res.status(400).json({ success: false, error: "Missing required parameter: id" });
    }

    const entries = await Book.removeEntry(req.user?.email, id);
    return res.status(200).json({ success: true, message: "Line removed", data: entries });
  } catch (err) {
    return sendError(res, err, "Book removal error:");
  }
};

exports.clearEntries = async (req, res) => {
  try {
    const entries = await Book.clearEntries(req.user?.email);
    return res.status(200).json({ success: true, message: "Order book cleared", data: entries });
  } catch (err) {
    return sendError(res, err, "Book clear error:");
  }
};

exports.placeOrder = async (req, res) => {
  try {
    const ids = req.body?.ids;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ success: false, error: "No items selected" });
    }

    const supplierName = req.body?.supplierName;
    const supplierEmail = req.body?.supplierEmail;

    const result = await Book.placeOrder(req.user?.email, ids, supplierName, supplierEmail);

    // Notify the supplier only once the order has actually placed lines. The
    // email is a side effect of a committed order, so a delivery failure is
    // logged and surfaced via `emailSent` but never fails the request itself.
    let emailSent = false;
    if (result.placed.length && supplierEmail) {
      try {
        const email = await sendSupplierOrderEmail(supplierName, supplierEmail, req.user?.email, result.placed);
        emailSent = Boolean(email?.sent);
      } catch (mailErr) {
        console.error("Supplier order email error:", mailErr);
      }
    }

    return res.status(200).json({
      success: true,
      message: `${result.placed.length} item(s) moved to order history`,
      data: { ...result, emailSent },
    });
  } catch (err) {
    return sendError(res, err, "Book place-order error:");
  }
};
