/**
 * Dashboard revenue analytics routes.
 *
 * Mounted behind `reqAuth` in index.js (`app.use("/dashboard/", reqAuth, dashboardRoutes)`),
 * so `req.user` (with `.email` = the created_by owner) is always available. All query
 * parameters are validated inside the controller before any SQL runs.
 *
 * Endpoints:
 *   GET /dashboard/revenue/daily?days=30
 *   GET /dashboard/revenue/monthly?months=6
 *   GET /dashboard/revenue/weekly?weeks=12
 *   GET /dashboard/revenue/range?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD&granularity=day
 *   GET /dashboard/summary
 */
const express = require("express");
const dashboard = require("../controllers/dashboard");

const router = express.Router();

// Trailing calendar days of sales revenue (default 30) — the dashboard's default view.
router.get("/revenue/daily", dashboard.httpDaily);

// Trailing calendar months of sales revenue (default 6), or an explicit date override.
router.get("/revenue/monthly", dashboard.httpMonthly);

// Trailing ISO weeks (Monday-start) of sales revenue (default 12), or an explicit date override.
router.get("/revenue/weekly", dashboard.httpWeekly);

// Sales revenue for an explicit, inclusive custom date range bucketed by day/week/month.
router.get("/revenue/range", dashboard.httpCustomRange);

// Headline KPI rollups: today / this week / this month / trailing 30 days.
router.get("/summary", dashboard.httpSummary);

module.exports = router;
