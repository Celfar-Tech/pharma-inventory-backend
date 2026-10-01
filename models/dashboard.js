const db = require("../database");

/**
 * Dashboard read-model: cross-entity analytics that do not belong to a single entity model.
 *
 * Hosts the "best-selling medicines" query that backs
 * `GET /dashboard/top-selling-medicines` (see controllers/dashboard.js for validation and
 * response shaping, routes/dashboard.js for the wiring).
 *
 * Materialized view, not the live tables
 * --------------------------------------
 * The endpoint never reads `pharma.billing_items` / `pharma.billing_invoice` directly. It reads
 * `pharma.mv_daily_medicine_sales`, a pre-aggregated rollup of "units + revenue per medicine per
 * day per owner" — the same pattern `BillingInvoice.revenueTimeSeries()` uses with
 * `pharma.mv_daily_revenue`.
 *
 * Ranking medicines over a date window against raw line items means a two-table join plus
 * grouping over every sale. Against the MV it is a scan of one row per (day, owner, medicine),
 * so the ranking runs over a table orders of magnitude smaller. The trade-off is freshness:
 * the MV only reflects sales up to its last refresh, hence
 * `ensureDailyMedicineSalesView()` / `refreshDailyMedicineSalesView()` below.
 *
 * DDL lives in `models/sql/mv_daily_medicine_sales.sql` (mirrored by `ensureDailyMedicineSalesView`
 * so the app can self-provision it) and must be applied before the endpoint can serve data.
 *
 * Ownership scoping
 * -----------------
 * The MV carries the owner on every row (`created_by`), so scoping is a plain
 * `created_by = $1` filter. Callers must always pass the authenticated user's email as
 * `emailid`; there is no "all users" mode.
 *
 * Business date
 * -------------
 * `day_bucket` is `billing_invoice.invoice_date` (the local business day, NOT NULL, defaulted to
 * CURRENT_DATE at creation), not `created_at`. That keeps the date window aligned to clean local
 * calendar days — the convention used across the dashboard endpoints.
 *
 * All user-supplied values (email, dates, limit) are bound parameters; the only interpolated
 * fragments are fixed literals defined in this file, so the queries are not injectable.
 */

/** Ranking metrics accepted by `topSellingMedicines`, mirroring the controller's `sortBy`. */
const SORT_METRICS = Object.freeze(["quantity", "revenue"]);

/** Default ranking metric when the caller does not supply `sortBy`. */
const DEFAULT_SORT_METRIC = "quantity";

/** Default cap for `limit` when the caller does not supply one (the frontend page-size default). */
const DEFAULT_MEDICINE_LIMIT = 50;

/** Fully-qualified name of the rollup this model reads. */
const MV_NAME = "pharma.mv_daily_medicine_sales";

/** Unique index backing REFRESH ... CONCURRENTLY (see models/sql/mv_daily_medicine_sales.sql). */
const MV_UNIQUE_INDEX = "mv_daily_medicine_sales_uniq";

/**
 * Raised when the rollup is missing or unusable, so the HTTP layer can answer with an
 * actionable message instead of a generic 500. `status` lets the existing controller error
 * mapping (which already understands `err.status`) handle it without special-casing.
 */
class DashboardViewError extends Error {
    constructor(message, { status = 503, hint = null } = {}) {
        super(message);
        this.name = "DashboardViewError";
        this.status = status;
        this.hint = hint;
    }
}

/** True when the error means "pharma.mv_daily_medicine_sales does not exist". */
function isMissingRelation(error) {
    // 42P01 = undefined_table. Guard on the name too so an unrelated missing relation
    // (e.g. billing_items on a fresh DB) is not misreported as a missing rollup.
    return error?.code === "42P01" && String(error.message || "").includes(MV_NAME);
}

class Dashboard {
    /**
     * Creates the rollup (and its unique index) when it does not already exist.
     *
     * Idempotent, and safe to call before a refresh on a database where nobody has applied
     * `models/sql/mv_daily_medicine_sales.sql` yet. Mirrors the DDL in that file — keep the two
     * definitions in sync.
     *
     * @param {object} [client=db] - Pool or transaction client.
     * @returns {Promise<void>}
     */
    static async ensureDailyMedicineSalesView(client = db) {
        await client.query("CREATE SCHEMA IF NOT EXISTS pharma;");
        await client.query(`
      CREATE MATERIALIZED VIEW IF NOT EXISTS ${MV_NAME} AS
      SELECT
        i.invoice_date::date          AS day_bucket,
        i.created_by                  AS created_by,
        bi.medicine_id                AS medicine_id,
        bi.medicine_name              AS medicine_name,
        SUM(bi.qty)::bigint           AS total_quantity_sold,
        SUM(bi.total)::numeric(14, 2) AS total_revenue
      FROM pharma.billing_items bi
      JOIN pharma.billing_invoice i
        ON bi.invoice_number = i.invoice_number
      WHERE i.created_by IS NOT NULL
      GROUP BY
        i.invoice_date::date,
        i.created_by,
        bi.medicine_id,
        bi.medicine_name;
    `);
        // Required for REFRESH ... CONCURRENTLY; without it the refresh would lock readers out.
        await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS ${MV_UNIQUE_INDEX}
        ON ${MV_NAME} (day_bucket, created_by, medicine_id, medicine_name);
    `);
    }

    /**
     * Rebuilds the rollup so it reflects the current contents of the billing tables.
     *
     * Uses `CONCURRENTLY` by default so dashboard reads are not blocked while the view is
     * rebuilt (it needs the unique index, which `ensureDailyMedicineSalesView` guarantees).
     * CONCURRENTLY cannot run inside a transaction block, so this deliberately runs on a
     * pooled (autocommit) connection rather than inside BEGIN/COMMIT.
     *
     * Two fallbacks keep the operation from becoming a dead end:
     *  - if CONCURRENTLY fails (e.g. the index was dropped, or the view has never been
     *    populated in some PostgreSQL versions), retry non-concurrently, then
     *  - `ANALYZE` afterwards so the planner keeps accurate row estimates for the rollup.
     *
     * @param {object} [options]
     * @param {boolean} [options.concurrently=true] - Set false to force the blocking refresh.
     * @param {object} [options.client=db] - Pool or transaction client.
     * @returns {Promise<{concurrently: boolean, durationMs: number}>} How it ran, for logging.
     */
    static async refreshDailyMedicineSalesView({ concurrently = true, client = db } = {}) {
        const startedAt = Date.now();
        let usedConcurrently = false;

        if (concurrently) {
            try {
                await client.query(`REFRESH MATERIALIZED VIEW CONCURRENTLY ${MV_NAME};`);
                usedConcurrently = true;
            } catch (err) {
                // Common causes: missing unique index, or the view was never populated in this
                // database. Fall through to the blocking refresh, which always works.
                console.warn(
                    `REFRESH MATERIALIZED VIEW CONCURRENTLY ${MV_NAME} failed (${err.code || "?"}): ${err.message}. ` +
                    "Retrying without CONCURRENTLY."
                );
            }
        }

        if (!usedConcurrently) {
            await client.query(`REFRESH MATERIALIZED VIEW ${MV_NAME};`);
        }

        await client.query(`ANALYZE ${MV_NAME};`);

        return { concurrently: usedConcurrently, durationMs: Date.now() - startedAt };
    }

    /**
     * Latest business day present in the rollup for an owner — i.e. "sales data is complete up
     * to this date". Lets the UI show an "as of" indicator, because a materialized view can lag
     * the billing tables until its next refresh.
     *
     * @param {string} emailid - Owner email to scope to.
     * @returns {Promise<string|null>} ISO date (YYYY-MM-DD), or null when the owner has no rows.
     */
    static async topSellingDataThrough(emailid) {
        try {
            const result = await db.query(
                `SELECT to_char(MAX(day_bucket), 'YYYY-MM-DD') AS data_through FROM ${MV_NAME} WHERE created_by = $1;`,
                [emailid]
            );
            return result.rows[0]?.data_through || null;
        } catch (err) {
            // Freshness is decorative; a missing/locked rollup must not fail the main request.
            if (isMissingRelation(err)) return null;
            throw err;
        }
    }

    /**
     * Best-selling medicines over an inclusive date range, read from the
     * `pharma.mv_daily_medicine_sales` rollup.
     *
     * Unlike a per-period breakdown, this collapses the whole window into a SINGLE row per
     * medicine, summing units and revenue. That is what a "top products" leaderboard needs: the
     * frontend can sort the returned page by whichever column the user picks (units or revenue)
     * without a second round-trip, while `sortBy` decides which metric the server ranks the
     * (capped) page by so it is a true top-N for that metric.
     *
     * Ranking is deterministic: the requested metric first, then the other metric, then
     * `medicine_name`, then `medicine_id` — so a tie can never flip between calls.
     *
     * @param {object} options
     * @param {string} options.emailid - Owner email (mv.created_by) to scope to.
     * @param {string} options.startDate - Inclusive range start (YYYY-MM-DD).
     * @param {string} options.endDate - Inclusive range end (YYYY-MM-DD).
     * @param {number} [options.limit=50] - Max medicines to return (the frontend "records to show"
     *   page size; the controller caps this at `MAX_TOP_MEDICINES`).
     * @param {"quantity"|"revenue"} [options.sortBy="quantity"] - Metric to rank by.
     * @returns {Promise<Array<{
     *   medicineId: number|null,
     *   medicineName: string,
     *   totalQuantitySold: number,
     *   totalRevenue: number
     * }>>} Highest-to-lowest by `sortBy`.
     * @throws {DashboardViewError} When the rollup has not been provisioned (HTTP 503).
     */
    static async topSellingMedicines({
        emailid,
        startDate,
        endDate,
        limit = DEFAULT_MEDICINE_LIMIT,
        sortBy = DEFAULT_SORT_METRIC,
    } = {}) {
        // Fixed literals only: `sortBy` is matched against the allow-list before use, so the
        // interpolated ORDER BY can never carry anything but these two strings.
        const orderBy =
            sortBy === "revenue"
                ? "total_revenue DESC, total_quantity_sold DESC, medicine_name ASC, medicine_id ASC"
                : "total_quantity_sold DESC, total_revenue DESC, medicine_name ASC, medicine_id ASC";

        const sql = `
      SELECT
        medicine_id,
        medicine_name,
        SUM(total_quantity_sold)::bigint   AS total_quantity_sold,
        SUM(total_revenue)::numeric(14, 2) AS total_revenue
      FROM pharma.mv_daily_medicine_sales
      WHERE created_by = $1
        AND day_bucket >= $2::date
        AND day_bucket <= $3::date
      GROUP BY medicine_id, medicine_name
      ORDER BY ${orderBy}
      LIMIT $4::int;
    `;

        let result;
        try {
            result = await db.query(sql, [emailid, startDate, endDate, limit]);
        } catch (err) {
            // Rollup missing/unusable: raise the typed error the HTTP layer maps to a 503 + hint.
            if (isMissingRelation(err)) {
                throw new DashboardViewError(`Top-selling rollup ${MV_NAME} is not available.`, {
                    hint:
                        "Apply models/sql/mv_daily_medicine_sales.sql, or POST " +
                        "/dashboard/top-selling-medicines/refresh to provision it.",
                });
            }
            throw err;
        }

        return result.rows.map((row) => ({
            medicineId: row.medicine_id === null ? null : Number(row.medicine_id),
            medicineName: row.medicine_name,
            // BIGINT comes back as a string from node-postgres; normalise to a number for charts.
            totalQuantitySold: Number(row.total_quantity_sold),
            totalRevenue: Number(row.total_revenue),
        }));
    }
}

module.exports = Dashboard;
module.exports.SORT_METRICS = SORT_METRICS;
module.exports.DEFAULT_SORT_METRIC = DEFAULT_SORT_METRIC;
module.exports.DEFAULT_MEDICINE_LIMIT = DEFAULT_MEDICINE_LIMIT;
module.exports.MV_NAME = MV_NAME;
module.exports.DashboardViewError = DashboardViewError;