const BillingInvoice = require("../models/billingInvoice");

// Note: all DB access in this app goes through parameterized queries ($1, $2, ...), so these
// values can never be interpreted as SQL. The allow-list patterns below are defense-in-depth
// (reject control characters / SQL metacharacters / script-injection payloads at the boundary),
// not the actual SQL-injection fix, which is parameterization itself.
const PHONE_REGEX = /^[6-9]\d{9}$/;
const NAME_REGEX = /^[A-Za-z][A-Za-z .'-]{1,99}$/;

function validateNameField(value, label) {
  if (value === undefined || value === null || value === "") return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  if (!NAME_REGEX.test(trimmed)) {
    return `${label} may only contain letters, spaces, apostrophes, hyphens and periods (2-100 characters)`;
  }
  return null;
}

function isExpiryBeforeCurrentMonth(expiryDate) {
  const expiry = new Date(expiryDate);
  if (Number.isNaN(expiry.getTime())) return true;
  const now = new Date();
  const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const expiryMonthStart = new Date(expiry.getFullYear(), expiry.getMonth(), 1);
  return expiryMonthStart < currentMonthStart;
}

function validateInvoiceItem(item, index) {
  if (!item.medicineName || !String(item.medicineName).trim()) {
    return `Item ${index + 1}: medicineName is required`;
  }
  if (!item.batch || !String(item.batch).trim()) {
    return `Item ${index + 1}: batch is required`;
  }
  if (!item.expiryDate) {
    return `Item ${index + 1}: expiryDate is required`;
  }
  if (isExpiryBeforeCurrentMonth(item.expiryDate)) {
    return `Item ${index + 1}: expiry month cannot be before the current month`;
  }
  if (!item.hsnCode || !String(item.hsnCode).trim()) {
    return `Item ${index + 1}: hsnCode is required`;
  }
  const mrp = Number(item.mrp);
  if (!Number.isFinite(mrp) || mrp < 0) {
    return `Item ${index + 1}: mrp must be a non-negative number`;
  }
  const qty = Number(item.qty);
  if (!Number.isFinite(qty) || qty <= 0) {
    return `Item ${index + 1}: qty must be greater than zero`;
  }
  const sellingPrice = Number(item.sellingPrice);
  if (!Number.isFinite(sellingPrice) || sellingPrice < 1) {
    return `Item ${index + 1}: sellingPrice can not be zero or less`;
  }
  if (mrp > 0 && sellingPrice > mrp) {
    return `Item ${index + 1}: sellingPrice cannot be greater than mrp`;
  }
  const discount = Number(item.discount);
  if (!Number.isFinite(discount) || discount < 0 || discount > sellingPrice * qty) {
    return `Item ${index + 1}: discount cannot be greater than the item selling amount`;
  }
  const taxableAmount = Number(item.taxableAmount);
  if (!Number.isFinite(taxableAmount) || taxableAmount < 1) {
    return `Item ${index + 1}: taxableAmount can not be zero or less`;
  }
  const total = Number(item.total);
  if (!Number.isFinite(total) || total < 1) {
    return `Item ${index + 1}: total can not be zero or less`;
  }
  return null;
}

exports.createInvoice = async (req, res) => {
  const payload = req.body || {};
  const items = payload.items;

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ success: false, error: "At least one billing item is required" });
  }

  for (let i = 0; i < items.length; i++) {
    const itemError = validateInvoiceItem(items[i], i);
    if (itemError) {
      return res.status(400).json({ success: false, error: itemError });
    }
  }

  const totalQuantity = Number(payload.totalQuantity);
  const grossAmount = Number(payload.grossAmount);
  const subtotal = Number(payload.subtotal);
  const finalPayable = Number(payload.finalPayable);
  const flatDiscount = Number(payload.flatDiscount ?? 0);
  const discountAmount = Number(payload.discountAmount ?? 0);

  if (!Number.isFinite(totalQuantity) || totalQuantity <= 0) {
    return res.status(400).json({ success: false, error: "totalQuantity must be greater than zero" });
  }
  if (!Number.isFinite(grossAmount) || grossAmount < 0) {
    return res.status(400).json({ success: false, error: "grossAmount must be a non-negative number" });
  }
  if (!Number.isFinite(subtotal) || subtotal < 0) {
    return res.status(400).json({ success: false, error: "subtotal must be a non-negative number" });
  }
  if (!Number.isFinite(finalPayable) || finalPayable < 0) {
    return res.status(400).json({ success: false, error: "finalPayable cannot be less than zero" });
  }
  if (!Number.isFinite(flatDiscount) || flatDiscount < 0) {
    return res.status(400).json({ success: false, error: "flatDiscount must be a non-negative number" });
  }
  if (flatDiscount > subtotal) {
    return res.status(400).json({ success: false, error: "flatDiscount cannot be greater than subtotal" });
  }
  if (!Number.isFinite(discountAmount) || discountAmount < 0) {
    return res.status(400).json({ success: false, error: "discountAmount must be a non-negative number" });
  }

  if (payload.phoneNumber && !PHONE_REGEX.test(String(payload.phoneNumber).trim())) {
    return res.status(400).json({ success: false, error: "phoneNumber must be a valid 10-digit mobile number" });
  }

  if (payload.patientAge != null && payload.patientAge !== "") {
    const age = Number(payload.patientAge);
    if (!Number.isFinite(age) || age <= 2) {
      return res.status(400).json({ success: false, error: "patientAge must be greater than 2" });
    }
  }

  const doctorNameError = validateNameField(payload.doctorName, "doctorName");
  if (doctorNameError) {
    return res.status(400).json({ success: false, error: doctorNameError });
  }
  const customerNameError = validateNameField(payload.customerName, "customerName");
  if (customerNameError) {
    return res.status(400).json({ success: false, error: customerNameError });
  }

  const invoiceData = {
    doctorName: payload.doctorName,
    paymentType: payload.paymentType,
    customerName: payload.customerName,
    phoneNumber: payload.phoneNumber,
    patientAge: payload.patientAge != null ? Number(payload.patientAge) : null,
    patientGender: payload.patientGender,
    address: payload.address,
    gstin: payload.gstin,
    taxBreakdown: payload.taxBreakdown,
    totalQuantity,
    grossAmount,
    discountAmount,
    subtotal,
    flatDiscount,
    finalPayable,
    // Trust the authenticated session, not client-supplied input, for the audit trail.
    createdBy: req.user?.email || null,
  };

  try {
    const result = await BillingInvoice.createInvoiceWithItems(invoiceData, items);
    return res.status(201).json({
      success: true,
      message: "Invoice created successfully",
      data: result,
    });
  } catch (err) {
    console.error("Invoice creation error:", err);
    return res.status(500).json({ success: false, error: "Failed to create invoice" });
  }
};

exports.getInvoice = async (req, res) => {
  const { invoiceNumber } = req.params;

  if (!invoiceNumber || !invoiceNumber.trim()) {
    return res.status(400).json({ success: false, error: "Invoice number is required" });
  }

  try {
    const result = await BillingInvoice.getInvoiceByNumber(invoiceNumber.trim(),req.user?.email || null);
    if (!result) {
      return res.status(404).json({ success: false, error: `No invoice found with number "${invoiceNumber}"` });
    }
    return res.status(200).json({ success: true, data: result });
  } catch (err) {
    console.error("Invoice fetch error:", err);
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
};

exports.listInvoices = async (req, res) => {
  const { page, limit } = req.query;

  try {
    const result = await BillingInvoice.listInvoices(req.user?.email || null, page, limit);
    return res.status(200).json({
      success: true,
      data: result.data,
      pagination: result.pagination,
    });
  } catch (err) {
    console.error("Invoice list error:", err);
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
};

exports.updateInvoice = async (req, res) => {
  const { invoiceNumber } = req.params;
  const payload = req.body || {};
  const items = payload.items;
  if (!invoiceNumber || !invoiceNumber.trim()) {
    return res.status(400).json({ success: false, error: "Invoice number is required" });
  }

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ success: false, error: "At least one billing item is required" });
  }

  for (let i = 0; i < items.length; i++) {
    const itemError = validateInvoiceItem(items[i], i);
    if (itemError) {
      return res.status(400).json({ success: false, error: itemError });
    }
  }

  const totalQuantity = Number(payload.totalQuantity);
  const grossAmount = Number(payload.grossAmount);
  const subtotal = Number(payload.subtotal);
  const finalPayable = Number(payload.finalPayable);
  const flatDiscount = Number(payload.flatDiscount ?? 0);
  const discountAmount = Number(payload.discountAmount ?? 0);

  if (!Number.isFinite(totalQuantity) || totalQuantity <= 0) {
    return res.status(400).json({ success: false, error: "totalQuantity must be greater than zero" });
  }
  if (!Number.isFinite(grossAmount) || grossAmount < 0) {
    return res.status(400).json({ success: false, error: "grossAmount must be a non-negative number" });
  }
  if (!Number.isFinite(subtotal) || subtotal < 0) {
    return res.status(400).json({ success: false, error: "subtotal must be a non-negative number" });
  }
  if (!Number.isFinite(finalPayable) || finalPayable < 0) {
    return res.status(400).json({ success: false, error: "finalPayable cannot be less than zero" });
  }
  if (!Number.isFinite(flatDiscount) || flatDiscount < 0) {
    return res.status(400).json({ success: false, error: "flatDiscount must be a non-negative number" });
  }
  if (flatDiscount > subtotal) {
    return res.status(400).json({ success: false, error: "flatDiscount cannot be greater than subtotal" });
  }
  if (!Number.isFinite(discountAmount) || discountAmount < 0) {
    return res.status(400).json({ success: false, error: "discountAmount must be a non-negative number" });
  }

  if (payload.phoneNumber && !PHONE_REGEX.test(String(payload.phoneNumber).trim())) {
    return res.status(400).json({ success: false, error: "phoneNumber must be a valid 10-digit mobile number" });
  }

  if (payload.patientAge != null && payload.patientAge !== "") {
    const age = Number(payload.patientAge);
    if (!Number.isFinite(age) || age <= 2) {
      return res.status(400).json({ success: false, error: "patientAge must be greater than 2" });
    }
  }

  const doctorNameError = validateNameField(payload.doctorName, "doctorName");
  if (doctorNameError) {
    return res.status(400).json({ success: false, error: doctorNameError });
  }
  const customerNameError = validateNameField(payload.customerName, "customerName");
  if (customerNameError) {
    return res.status(400).json({ success: false, error: customerNameError });
  }

  const invoiceData = {
    doctorName: payload.doctorName,
    paymentType: payload.paymentType,
    customerName: payload.customerName,
    phoneNumber: payload.phoneNumber,
    patientAge: payload.patientAge != null ? Number(payload.patientAge) : null,
    patientGender: payload.patientGender,
    address: payload.address,
    gstin: payload.gstin,
    taxBreakdown: payload.taxBreakdown,
    totalQuantity,
    grossAmount,
    discountAmount,
    subtotal,
    flatDiscount,
    finalPayable,
    // Trust the authenticated session, not client-supplied input, for the audit trail.
    updatedBy: req.user?.email || null,
  };

  try {
    const result = await BillingInvoice.updateInvoiceWithItems(
      invoiceNumber.trim(),
      req.user?.email || null,
      invoiceData,
      items
    );
    if (!result) {
      return res.status(404).json({ success: false, error: `No invoice found with number "${invoiceNumber}"` });
    }
    return res.status(200).json({
      success: true,
      message: "Invoice updated successfully",
      data: result,
    });
  } catch (err) {
    console.error("Invoice update error:", err);
    return res.status(500).json({ success: false, error: "Failed to update invoice" });
  }
};

exports.deleteInvoice = async (req, res) => {
  const { invoiceNumber } = req.params;

  if (!invoiceNumber || !invoiceNumber.trim()) {
    return res.status(400).json({ success: false, error: "Invoice number is required" });
  }

  try {
    // Ownership is enforced in the model via created_by = the authenticated session's email,
    // so a user can never delete another user's invoice.
    const result = await BillingInvoice.deleteInvoiceWithItems(invoiceNumber.trim(), req.user?.email || null);

    if (!result) {
      return res.status(404).json({ success: false, error: `No invoice found with number "${invoiceNumber}"` });
    }

    return res.status(200).json({
      success: true,
      message: `Invoice "${result.invoiceNumber}" deleted successfully along with ${result.deletedItems} item(s)`,
      data: result,
    });
  } catch (err) {
    console.error("Invoice deletion error:", err);
    return res.status(500).json({
      success: false,
      error: "Failed to delete invoice",
      errorId: `ERR-${Date.now()}`,
    });
  }
};

