const express = require("express");
const billing = require("../controllers/billing");
const reqAuth = require("../middleware/reqAuth");

const router = express.Router();
router.use(reqAuth);
router.post("/invoice", billing.createInvoice);
router.get("/invoice/:invoiceNumber", billing.getInvoice);
router.patch("/invoice/:invoiceNumber", billing.updateInvoice);
router.delete("/invoice/:invoiceNumber", billing.deleteInvoice);
router.get("/invoices", billing.listInvoices);

module.exports = router;
