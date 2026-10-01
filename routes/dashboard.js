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
 *   GET /dashboard/top-selling-medicines?days=30&limit=50&sortBy=quantity
 *   POST /dashboard/top-selling-medicines/refresh
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

// Best-selling medicines over a date window (default last 30 days) as a single ranked
// leaderboard: one row per medicine with total units sold + total revenue, ordered by `sortBy`
// (`quantity` | `revenue`). `limit` is the frontend "records to show" page size (default 50, max 200).
// Reads pharma.mv_daily_medicine_sales; answers 503 with a hint when the rollup is missing.
router.get("/top-selling-medicines", dashboard.httpTopSellingMedicines);

// Rebuilds pharma.mv_daily_medicine_sales so the endpoint above picks up new sales.
// Maintenance action (global rebuild, debounced to at most once per MV_REFRESH_MIN_INTERVAL_SECONDS).
router.post("/top-selling-medicines/refresh", dashboard.httpRefreshTopSellingMedicines);

module.exports = router;
