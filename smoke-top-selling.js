// Temporary smoke test for the top-selling-medicines materialized view.
// Run against a database that has the billing tables: `node smoke-top-selling.js`
// Delete this file once you are done verifying.
require("dotenv").config();
const db = require("./database");
const Dashboard = require("./models/dashboard");

(async () => {
  // 1. Provision + rebuild the rollup — the same two calls POST /dashboard/top-selling-medicines/refresh makes.
  await Dashboard.ensureDailyMedicineSalesView();
  console.log("refresh:", await Dashboard.refreshDailyMedicineSalesView({ concurrently: true }));

  const owners = await db.query("SELECT created_by, COUNT(*)::int AS n FROM pharma.billing_invoice GROUP BY created_by ORDER BY n DESC LIMIT 3;");
  console.log("owners:", owners.rows);
  const owner = owners.rows[0]?.created_by;
  if (!owner) {
    console.log("no invoices to test with");
    return;
  }

  const today = await db.query("SELECT to_char(CURRENT_DATE, 'YYYY-MM-DD') AS d;");
  const endDate = today.rows[0].d;
  const start = await db.query("SELECT to_char(CURRENT_DATE - interval '29 days', 'YYYY-MM-DD') AS d;");
  const startDate = start.rows[0].d;

  // 2. Default window/metric: last 30 days, ranked by units sold.
  const byUnits = await Dashboard.topSellingMedicines({ emailid: owner, startDate, endDate, limit: 50 });
  console.log(`range ${startDate}..${endDate} owner=${owner} medicines=${byUnits.length}`);
  console.log("dataThrough:", await Dashboard.topSellingDataThrough(owner));
  console.log("top 6 by units:", byUnits.slice(0, 6));

  const ordered = byUnits.every((r, i) => i === 0 || byUnits[i - 1].totalQuantitySold >= r.totalQuantitySold);
  console.log("ordered by units desc:", ordered);
  console.log("all rows have revenue:", byUnits.every((r) => Number.isFinite(r.totalRevenue)));

  // 3. Same window ranked by revenue.
  const byRevenue = await Dashboard.topSellingMedicines({
    emailid: owner,
    startDate,
    endDate,
    limit: 50,
    sortBy: "revenue",
  });
  console.log("top 3 by revenue:", byRevenue.slice(0, 3));

  // 4. Cross-check the top medicine against the raw tables — proves the rollup is faithful.
  const top = byUnits[0];
  if (top) {
    const check = await db.query(
      `SELECT bi.medicine_name, SUM(bi.qty)::bigint AS qty, SUM(bi.total)::numeric(14,2) AS revenue
       FROM pharma.billing_items bi
       JOIN pharma.billing_invoice i ON bi.invoice_number = i.invoice_number
       WHERE i.created_by = $1 AND i.invoice_date::date BETWEEN $2::date AND $3::date
       GROUP BY bi.medicine_name ORDER BY qty DESC LIMIT 3;`,
      [owner, startDate, endDate]
    );
    console.log(`hand-check top 3 ${startDate}..${endDate}:`, check.rows);
  }
})()
  .catch((err) => console.error("FAILED:", err.message, err.code || ""))
  .finally(() => db.pool.end());
