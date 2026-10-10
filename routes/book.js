const express = require("express");
const book = require("../controllers/book");
const reqAuth = require("../middleware/reqAuth");

const router = express.Router();
router.use(reqAuth);

router.get("/entries", book.getEntries);
router.get("/history", book.getHistory);
router.get("/history/:ledgerId", book.getLedgerItems);
router.post("/upsert", book.upsertEntry);
router.put("/:id", book.updateEntry);
router.delete("/clear", book.clearEntries);
router.delete("/:id", book.removeEntry);
router.post("/place-order", book.placeOrder);

module.exports = router;
