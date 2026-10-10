const nodemailer = require("nodemailer");
// 1. Configure your email transporter
const transporter = nodemailer.createTransport({
  host: "smtpout.secureserver.net",
  port: 465,
  secure: true, // Must be true for port 465
  auth: {
    user: process.env.EMAIL_USER,        
    pass: process.env.EMAIL_APP_PASSWORD,
  },
});

/** Escapes a value before it is interpolated into an email HTML template. */
const escapeHtml = (value) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

// 2. Export the sendOtpEmail function
const sendOtpEmail = async (toEmail, otp) => {
  const mailOptions = {
    from: process.env.EMAIL_USER,
    to: toEmail,
    subject: "PharmaConnect - Email Verification Code",
    html: `
      <div style="font-family: Arial, sans-serif; padding: 24px; background-color: #f8fafc; border-radius: 8px; color: #1e293b;">
        <h2 style="color: #0284c7; margin-top: 0;">Welcome to PharmaConnect</h2>
        <p style="font-size: 16px;">Please use the verification code below to proceed with your registration:</p>
        <div style="background: #ffffff; padding: 16px 24px; border-radius: 6px; display: inline-block; border: 1px solid #e2e8f0; margin: 16px 0;">
          <span style="font-size: 28px; font-weight: bold; letter-spacing: 4px; color: #0284c7;">${otp}</span>
        </div>
        <p style="font-size: 14px; color: #64748b;">This code will expire in 10 minutes.</p>
        <p style="font-size: 12px; color: #94a3b8; margin-top: 24px;">If you didn't request this, you can safely ignore this email.</p>
      </div>
    `,
  };

  await transporter.sendMail(mailOptions);
};

/**
 * Emails a placed order to its supplier.
 *
 * Returns `{ sent }` instead of throwing on a configuration problem so the
 * caller can attempt delivery without risking the already-committed order. A
 * `null`/blank recipient is a no-op.
 *
 * @param {string} supplierName  Supplier display name.
 * @param {string} supplierEmail Recipient address.
 * @param {string} customerEmail Customer email address.
 * @param {Array}  items         Placed book lines (name/quantity/price/...).
 * @returns {Promise<{sent: boolean, reason?: string, itemCount?: number, approxCost?: number}>}
 */
const sendSupplierOrderEmail = async (supplierName, supplierEmail, customerEmail, items = []) => {
  const to = typeof supplierEmail === "string" ? supplierEmail.trim() : "";
    const cc = typeof customerEmail === "string" ? customerEmail.trim() : "";
  if (!to) {
    console.warn("Supplier order email skipped: no recipient email provided.");
    return { sent: false, reason: "missing-recipient" };
  }
if (!cc) {
    console.warn("CC email not existing: no customer email provided.");
    return { sent: false, reason: "missing-recipient" };
  }
  if (!process.env.EMAIL_USER || !process.env.EMAIL_APP_PASSWORD) {
    console.warn("Supplier order email skipped: EMAIL_USER/EMAIL_APP_PASSWORD are not configured.");
    return { sent: false, reason: "missing-credentials" };
  }

  const rows = (Array.isArray(items) ? items : []).map((item, index) => {
    const quantity = Number(item?.quantity ?? item?.qty ?? item?.orderedQuantity ?? 0) || 0;
    const price = Number(item?.price ?? item?.purchasePrice ?? 0) || 0;
    return {
      name: item?.name || item?.medicineName || item?.medicine || `Medicine ${index + 1}`,
      manufacturer: item?.manufacturer || "",
      packSize: item?.packSize || "",
      quantity,
      price,
      lineTotal: quantity * price,
    };
  });

  const itemCount = rows.length;
  const approxCost = rows.reduce((sum, row) => sum + row.lineTotal, 0);
  const toName =
    typeof supplierName === "string" && supplierName.trim() ? supplierName.trim() : "Supplier";

  const itemRows = rows.length
    ? rows
        .map(
          (row) => `
          <tr>
            <td style="padding: 10px 12px; border-bottom: 1px solid #e2e8f0;">${escapeHtml(row.name)}</td>
            <td style="padding: 10px 12px; border-bottom: 1px solid #e2e8f0;">${escapeHtml(row.manufacturer) || "-"}</td>
            <td style="padding: 10px 12px; border-bottom: 1px solid #e2e8f0;">${escapeHtml(row.packSize) || "-"}</td>
            <td style="padding: 10px 12px; border-bottom: 1px solid #e2e8f0; text-align: right;">${row.quantity}</td>
            <td style="padding: 10px 12px; border-bottom: 1px solid #e2e8f0; text-align: right;">${row.price.toFixed(2)}</td>
            <td style="padding: 10px 12px; border-bottom: 1px solid #e2e8f0; text-align: right;">${row.lineTotal.toFixed(2)}</td>
          </tr>`
        )
        .join("")
    : `<tr><td colspan="6" style="padding: 10px 12px; color: #64748b;">No medicines selected</td></tr>`;

  const html = `
    <div style="font-family: Arial, sans-serif; padding: 24px; background-color: #f8fafc; border-radius: 8px; color: #1e293b;">
      <h2 style="color: #0284c7; margin-top: 0;">New order request</h2>
      <p style="font-size: 16px;">Hello ${escapeHtml(toName)},</p>
      <p style="font-size: 16px;">Please supply the following medicines:</p>
      <table style="width: 100%; border-collapse: collapse; background: #ffffff; border: 1px solid #e2e8f0; font-size: 14px;">
        <thead>
          <tr style="background: #f1f5f9; text-align: left;">
            <th style="padding: 10px 12px;">Medicine</th>
            <th style="padding: 10px 12px;">Manufacturer</th>
            <th style="padding: 10px 12px;">Pack</th>
            <th style="padding: 10px 12px; text-align: right;">Qty</th>
            <th style="padding: 10px 12px; text-align: right;">Unit price</th>
            <th style="padding: 10px 12px; text-align: right;">Line total</th>
          </tr>
        </thead>
        <tbody>${itemRows}</tbody>
        <tfoot>
          <tr>
            <td colspan="5" style="padding: 10px 12px; text-align: right; font-weight: bold;">Approx. total (${itemCount} item${itemCount === 1 ? "" : "s"})</td>
            <td style="padding: 10px 12px; text-align: right; font-weight: bold;">${approxCost.toFixed(2)}</td>
          </tr>
        </tfoot>
      </table>
      <p style="font-size: 14px; color: #64748b; margin-top: 16px;">Please confirm availability and delivery timelines.</p>
      <p style="font-size: 12px; color: #94a3b8; margin-top: 24px;">This request was generated automatically by PharmaConnect.</p>
    </div>
  `;

  await transporter.sendMail({
    from: process.env.EMAIL_FROM || process.env.EMAIL_USER,
    to,
    cc,
    subject: `Order request - ${itemCount} item${itemCount === 1 ? "" : "s"}`,
    html,
  });

  return { sent: true, itemCount, approxCost };
};

module.exports = { sendOtpEmail, sendSupplierOrderEmail };