const nodemailer = require("nodemailer");

const normalizeEmail = (value) => {
  if (typeof value !== "string") return "";
  return value.trim();
};

const isValidEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value || "");

const getTransporter = () => {
  if (!process.env.EMAIL_USER || !process.env.EMAIL_APP_PASSWORD) {
    return null;
  }

  return nodemailer.createTransport({
    host: "smtpout.secureserver.net",
    port: 465,
    secure: true,
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_APP_PASSWORD,
    },
  });
};

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
  const to = normalizeEmail(toEmail);
  if (!to || !isValidEmail(to)) {
    console.warn("OTP email skipped: invalid recipient email address.");
    return { sent: false, reason: "missing-recipient" };
  }

  const transporter = getTransporter();
  if (!transporter) {
    console.warn("OTP email skipped: EMAIL_USER/EMAIL_APP_PASSWORD are not configured.");
    return { sent: false, reason: "missing-credentials" };
  }

  const otpCode = String(otp ?? "").trim();
  if (!otpCode) {
    console.warn("OTP email skipped: OTP value is empty.");
    return { sent: false, reason: "missing-otp" };
  }

  const mailOptions = {
    from: process.env.EMAIL_FROM || process.env.EMAIL_USER,
    to,
    subject: "PharmaConnect - Email Verification Code",
    html: `
      <div style="font-family: Arial, sans-serif; padding: 24px; background-color: #f8fafc; border-radius: 8px; color: #1e293b;">
        <h2 style="color: #0284c7; margin-top: 0;">Welcome to PharmaConnect</h2>
        <p style="font-size: 16px;">Please use the verification code below to proceed with your registration:</p>
        <div style="background: #ffffff; padding: 16px 24px; border-radius: 6px; display: inline-block; border: 1px solid #e2e8f0; margin: 16px 0;">
          <span style="font-size: 28px; font-weight: bold; letter-spacing: 4px; color: #0284c7;">${escapeHtml(otpCode)}</span>
        </div>
        <p style="font-size: 14px; color: #64748b;">This code will expire in 10 minutes.</p>
        <p style="font-size: 12px; color: #94a3b8; margin-top: 24px;">If you didn't request this, you can safely ignore this email.</p>
      </div>
    `,
  };

  await transporter.sendMail(mailOptions);
  return { sent: true };
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
const sendSupplierOrderEmail = async (supplierName, supplierEmail, customerEmail, customerName, items = [], ledgerId) => {
  const to = normalizeEmail(supplierEmail);
  const cc = normalizeEmail(customerEmail);
  if (!to || !isValidEmail(to)) {
    console.warn("Supplier order email skipped: invalid supplier recipient email provided.");
    return { sent: false, reason: "missing-recipient" };
  }
  if (!cc || !isValidEmail(cc)) {
    console.warn("Supplier order email skipped: invalid customer email provided for CC.");
    return { sent: false, reason: "missing-recipient" };
  }
  const transporter = getTransporter();
  if (!transporter) {
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

  // Narrow-screen table: Manufacturer/Pack cannot fit next to a real medicine
  // name on a phone, so they collapse into a sub-line under the name and the
  // grid keeps 4 real columns (Medicine, Qty, Rate, Amount). This stays a
  // table — no horizontal scrolling, no reflowed card layout.
  const mobileRows = rows.length
    ? rows
        .map((row) => {
          const subParts = [row.manufacturer, row.packSize].filter(Boolean);
          const sub = subParts.length
            ? `<span style="display: block; font-size: 10px; line-height: 14px; color: #64748b; font-weight: normal;">${escapeHtml(
                subParts.join(" · ")
              )}</span>`
            : "";
          return `
          <tr>
            <td style="padding: 8px 6px; border-bottom: 1px solid #e2e8f0; vertical-align: top; word-break: break-word;">${escapeHtml(
              row.name
            )}${sub}</td>
            <td style="padding: 8px 6px; border-bottom: 1px solid #e2e8f0; text-align: right; vertical-align: top; white-space: nowrap;">${
              row.quantity
            }</td>
            <td style="padding: 8px 6px; border-bottom: 1px solid #e2e8f0; text-align: right; vertical-align: top; white-space: nowrap;">${row.price.toFixed(
              2
            )}</td>
            <td style="padding: 8px 6px; border-bottom: 1px solid #e2e8f0; text-align: right; vertical-align: top; white-space: nowrap;">${row.lineTotal.toFixed(
              2
            )}</td>
          </tr>`;
        })
        .join("")
    : `<tr><td colspan="4" style="padding: 8px 6px; color: #64748b;">No medicines selected</td></tr>`;

  // Plain-text alternative. HTML-only mail is a well-known spam signal
  // (`MIME_HTML_ONLY`), and many suppliers read mail in text-only clients.
  const padRight = (value, width) => {
    const text = String(value ?? "");
    return text.length >= width ? text : text + " ".repeat(width - text.length);
  };
  const padLeft = (value, width) => {
    const text = String(value ?? "");
    return text.length >= width ? text : " ".repeat(width - text.length) + text;
  };
  const textHeader = `${padRight("Medicine", 30)} ${padLeft("Qty", 5)} ${padLeft("Rate", 9)} ${padLeft("Amount", 10)}`;
  const textRows = rows.length
    ? rows.flatMap((row) => {
        // Free-text fields go on their own indented line: manufacturer names are
        // far too long to keep a fixed-width column aligned, and truncating them
        // would lose information the supplier needs.
        const subParts = [row.manufacturer, row.packSize].filter(Boolean);
        const lines = [
          `${padRight(row.name, 30)} ${padLeft(row.quantity, 5)} ${padLeft(row.price.toFixed(2), 9)} ${padLeft(
            row.lineTotal.toFixed(2),
            10
          )}`,
        ];
        if (subParts.length) lines.push(`  ${subParts.join(" | ")}`);
        return lines;
      })
    : ["No medicines selected"];
  const text = [
    `Hello ${toName},`,
    "",
    `Please supply the following medicines:`,
    "",
    textHeader,
    "-".repeat(textHeader.length),
    ...textRows,
    "",
    `Approx. total (${itemCount} item${itemCount === 1 ? "" : "s"}): ${approxCost.toFixed(2)}`,
    "",
    "Please confirm availability and delivery timelines.",
    "",
    "This request was generated automatically by PharmaConnect.",
  ].join("\n");

  const html = `
  <!DOCTYPE html>
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <style>
        /* Both tables are real tables. The wide one is swapped for the narrow
           one below 600px; the wrappers are hidden with inline styles so that
           clients which drop this block fall back to the desktop table only
           (never two tables at once). */
        @media only screen and (max-width: 600px) {
          .email-card { padding: 16px !important; }
          .desktop-only { display: none !important; max-height: 0 !important; overflow: hidden !important; }
          .mobile-only { display: block !important; max-height: none !important; overflow: visible !important; }
          .mobile-table th,
          .mobile-table td { padding: 8px 6px !important; font-size: 12px !important; }
        }
      </style>
    </head>
    <body style="margin: 0; padding: 0; background-color: #f8fafc;">
      <div class="email-card" style="font-family: Arial, sans-serif; padding: 24px; background-color: #f8fafc; border-radius: 8px; color: #1e293b;">
        <h2 style="color: #0284c7; margin-top: 0;">New order request</h2>
        <p style="font-size: 16px;">Hello ${escapeHtml(toName)},</p>
        <p style="font-size: 16px;">Please supply the following medicines:</p>

        <div class="desktop-only">
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
        </div>

        <div class="mobile-only" style="display: none; max-height: 0; overflow: hidden;">
          <table class="mobile-table" style="width: 100%; border-collapse: collapse; background: #ffffff; border: 1px solid #e2e8f0; font-size: 12px;">
            <thead>
              <tr style="background: #f1f5f9; text-align: left;">
                <th style="padding: 8px 6px;">Medicine</th>
                <th style="padding: 8px 6px; text-align: right;">Qty</th>
                <th style="padding: 8px 6px; text-align: right;">Rate</th>
                <th style="padding: 8px 6px; text-align: right;">Amount</th>
              </tr>
            </thead>
            <tbody>${mobileRows}</tbody>
            <tfoot>
              <tr>
                <td colspan="3" style="padding: 8px 6px; text-align: right; font-weight: bold;">Total (${itemCount} item${itemCount === 1 ? "" : "s"})</td>
                <td style="padding: 8px 6px; text-align: right; font-weight: bold;">${approxCost.toFixed(2)}</td>
              </tr>
            </tfoot>
          </table>
        </div>

        <p style="font-size: 14px; color: #64748b; margin-top: 16px;">Please confirm availability and delivery timelines.</p>
        <p style="font-size: 12px; color: #94a3b8; margin-top: 24px;">This request was generated automatically by PharmaConnect.</p>
      </div>
    </body>
  </html>
  `;

  // Header values must never carry CR/LF, otherwise a crafted supplier or
  // customer name could inject extra headers into the message.
  const headerSafe = (value) => String(value ?? "").replace(/[\r\n]+/g, " ").trim();

  // `from` must be the authenticated mailbox or an SPF/DKIM-aligned domain.
  // A display name makes the message look less like a bare relay send.
  const rawFrom = headerSafe(process.env.EMAIL_FROM || process.env.EMAIL_USER || "");
  const fromSource = rawFrom || "no-reply@localhost";
  const from = fromSource.includes("<") ? fromSource : `PharmaConnect <${fromSource}>`;
  const ledgerRef = headerSafe(ledgerId);
  const customerLabel = headerSafe(customerName) || "customer";

  await transporter.sendMail({
    from,
    to,
    cc,
    // Replies belong to the buyer, not the no-reply mailbox.
    replyTo: cc,
    subject: ledgerRef
      ? `${ledgerRef} - Order request from ${customerLabel}`
      : `Order request from ${customerLabel}`,
    text,
    html,
  });

  return { sent: true, itemCount, approxCost };
};

module.exports = { sendOtpEmail, sendSupplierOrderEmail };