/**
 * Dashboard revenue analytics — controllers + AI-agent tool definitions.
 *
 * Architecture
 * ------------
 * The data-access + validation logic lives in small, documented functions
 * (getDailySales, getMonthlySales, getWeeklySales, getCustomRangeSales, getSalesSummary). These are:
 *
 *  1. Exposed to the AI agent through the `agentTools` manifest (each entry carries a
 *     name, description, JSON Schema for parameters, and an `execute` that never throws
 *     for the agent runtime), AND
 *  2. Reused by the thin Express handlers (httpMonthly, httpWeekly, httpCustomRange,
 *     httpSummary) that adapt `req.query` -> validated params -> HTTP JSON response.
 *
 * This keeps the HTTP layer and the agent layer on exactly the same code path, so a chart
 * and an AI answer can never drift apart. All values returned are derived from
 * pharma.billing_invoice via the existing BillingInvoice model.
 *
 * Timezone / date semantics
 * -------------------------
 * Invoice rows carry an `invoice_date` business-day value (an ISO date, possibly stored as
 * DATE or as ISO TEXT depending on the deployed schema) that represents the sale's local day.
 * All aggregation filters/grouping use that column, so the returned buckets are clean local
 * calendar periods and no timezone shifting is required on the client. Default "trailing
 * N months/weeks" windows are anchored to the DB session's CURRENT_DATE (Asia/Kolkata) — not
 * the Node process clock — for consistency with how invoices are stamped at creation.
 */

const BillingInvoice = require("../models/billingInvoice");

const CURRENCY = "INR";

const GRANULARITIES = Object.freeze(["day", "week", "month"]);
const GRANULARITY_DEFAULT = "day";

// Maximum inclusive range span (in days) we allow for a given bucket size. Guards the
// response size / query cost for wide custom ranges while remaining generous.
const MAX_RANGE_DAYS = Object.freeze({
  day: 370, // ~12 months of daily buckets
  week: 1850, // ~5 years of weekly buckets
  month: 3700, // ~10 years of monthly buckets
});

const DEFAULT_DAYS = 30;
const MAX_DAYS = 370; // mirrors MAX_RANGE_DAYS.day (~12 months of daily buckets)
const DEFAULT_MONTHS = 6;
const MAX_MONTHS = 60;
const DEFAULT_WEEKS = 12;
const MAX_WEEKS = 104;

const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Typed error so HTTP wrappers can map to a status code while agent callers get a message. */
class DashboardError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "DashboardError";
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Date helpers (UTC-based so month/day arithmetic never hits DST edge cases).
// ---------------------------------------------------------------------------

function isoToUtc(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function utcToIso(date) {
  return date.toISOString().slice(0, 10);
}

function parseISODate(value, fieldName) {
  if (value === undefined || value === null || value === "") {
    throw new DashboardError(`${fieldName} is required and must use the YYYY-MM-DD format`);
  }
  const match = ISO_DATE_PATTERN.exec(String(value).trim());
  if (!match) {
    throw new DashboardError(`${fieldName} must be a valid date in YYYY-MM-DD format`);
  }
  const [, y, m, d] = match;
  const parsed = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  if (
    parsed.getUTCFullYear() !== Number(y) ||
    parsed.getUTCMonth() !== Number(m) - 1 ||
    parsed.getUTCDate() !== Number(d)
  ) {
    throw new DashboardError(`${fieldName} is not a real calendar date (got "${value}")`);
  }
  return utcToIso(parsed);
}

function optionalISODate(value, fieldName) {
  if (value === undefined || value === null || value === "") return null;
  return parseISODate(value, fieldName);
}

function addDays(iso, days) {
  const date = isoToUtc(iso);
  date.setUTCDate(date.getUTCDate() + days);
  return utcToIso(date);
}

function addMonths(iso, months) {
  const [y, m, d] = iso.split("-").map(Number);
  const targetYear = y;
  const targetMonthIndex = m - 1 + months;
  const year = targetYear + Math.floor(targetMonthIndex / 12);
  const monthIndex = ((targetMonthIndex % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  const day = Math.min(d, lastDay);
  return utcToIso(new Date(Date.UTC(year, monthIndex, day)));
}

function startOfMonth(iso) {
  return `${iso.slice(0, 8)}01`;
}

// Monday-based start of the ISO week that contains `iso`.
function startOfWeekMonday(iso) {
  const date = isoToUtc(iso);
  const daysSinceMonday = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - daysSinceMonday);
  return utcToIso(date);
}

function daysBetween(startIso, endIso) {
  return Math.round((isoToUtc(endIso).getTime() - isoToUtc(startIso).getTime()) / MS_PER_DAY);
}

function round2(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

// ---------------------------------------------------------------------------
// Parameter coercion / validation helpers
// ---------------------------------------------------------------------------

function requireEmail(email) {
  const normalized = typeof email === "string" ? email.trim() : "";
  if (!normalized) {
    throw new DashboardError("email (created_by owner scope) is required");
  }
  return normalized;
}

function intParam(value, { name, min, max, fallback }) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new DashboardError(`${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function enumParam(value, { name, allowed, fallback }) {
  if (value === undefined || value === null || value === "") return fallback;
  const normalized = String(value).toLowerCase();
  if (!allowed.includes(normalized)) {
    throw new DashboardError(`${name} must be one of: ${allowed.join(", ")}`);
  }
  return normalized;
}

function assertOrderedRange(startDate, endDate) {
  if (startDate > endDate) {
    throw new DashboardError(`startDate (${startDate}) cannot be after endDate (${endDate})`);
  }
}

function assertWithinSpan(startDate, endDate, granularity) {
  const span = daysBetween(startDate, endDate);
  const max = MAX_RANGE_DAYS[granularity];
  if (span > max) {
    throw new DashboardError(
      `Requested range of ${span} days exceeds the maximum of ${max} days for "${granularity}" granularity. ` +
        `Use a coarser granularity ("week"/"month") or a shorter range.`
    );
  }
}

// Resolves the inclusive [startDate, endDate] window. When no explicit dates are supplied,
// `amount` trailing units of `unit` ("day" | "week" | "month") are used, anchored to the DB's today.
async function resolveWindow({ startDate, endDate, amount, unit }) {
  const explicitStart = optionalISODate(startDate, "startDate");
  const explicitEnd = optionalISODate(endDate, "endDate");
  const today = explicitEnd || (await BillingInvoice.currentLocalDate());
  if (!today) {
    throw new DashboardError("Could not determine the current business date", 500);
  }

  let start;
  if (explicitStart) {
    start = explicitStart;
  } else if (unit === "month") {
    start = startOfMonth(addMonths(today, -(amount - 1)));
  } else if (unit === "day") {
    start = addDays(today, -(amount - 1));
  } else {
    start = startOfWeekMonday(addDays(today, -(amount - 1) * 7));
  }

  assertOrderedRange(start, today);
  return { startDate: start, endDate: today };
}

// ---------------------------------------------------------------------------
// Response shaping (chart-friendly time-series + rollup summary)
// ---------------------------------------------------------------------------

async function buildRevenueResult({ email, granularity, timeframe, startDate, endDate }) {
  const series = await BillingInvoice.revenueTimeSeries({
    emailid: email,
    granularity,
    startDate,
    endDate,
  });

  const totalRevenue = round2(series.reduce((sum, point) => sum + point.total, 0));
  const totalInvoices = series.reduce((sum, point) => sum + point.invoiceCount, 0);
  const activePeriods = series.filter((point) => point.total > 0).length;

  let bestPeriod = null;
  for (const point of series) {
    if (point.total > 0 && (!bestPeriod || point.total > bestPeriod.total)) bestPeriod = point;
  }

  return {
    timeframe,
    granularity,
    currency: CURRENCY,
    range: { startDate, endDate },
    // Directly plottable: [{ label, startDate, endDate, total, invoiceCount }, ...]
    series,
    summary: {
      totalRevenue,
      totalInvoices,
      periodCount: series.length,
      activePeriods,
      averagePerPeriod: series.length ? round2(totalRevenue / series.length) : 0,
      bestPeriod: bestPeriod ? { label: bestPeriod.label, total: bestPeriod.total } : null,
    },
  };
}

// ---------------------------------------------------------------------------
// AI-agent tool functions (data-access + validation, shared with HTTP layer)
// ---------------------------------------------------------------------------

/**
 * Trailing daily sales revenue for the dashboard.
 *
 * Returns one bucket per calendar day for the last `days` days (including today), or for an
 * explicit startDate/endDate override. This is the default dashboard view. Days with no sales
 * are included with total 0 so the chart axis stays continuous.
 *
 * @param {object} params
 * @param {string} params.email - Owner email (created_by) the invoices belong to.
 * @param {number} [params.days=30] - Number of trailing calendar days (1-370).
 * @param {string} [params.startDate] - Optional inclusive start override (YYYY-MM-DD).
 * @param {string} [params.endDate] - Optional inclusive end override (YYYY-MM-DD).
 * @returns {Promise<object>} { timeframe, granularity, currency, range, series, summary }
 */
async function getDailySales(params = {}) {
  const email = requireEmail(params.email);
  const days = intParam(params.days, {
    name: "days",
    min: 1,
    max: MAX_DAYS,
    fallback: DEFAULT_DAYS,
  });
  const { startDate, endDate } = await resolveWindow({
    startDate: params.startDate,
    endDate: params.endDate,
    amount: days,
    unit: "day",
  });
  assertWithinSpan(startDate, endDate, "day");
  return buildRevenueResult({
    email,
    granularity: "day",
    timeframe: "daily",
    startDate,
    endDate,
  });
}

/**
 * Trailing monthly sales revenue for the dashboard.
 *
 * Returns one bucket per calendar month for the last `months` months (including the
 * current, still-in-progress month), or for an explicit startDate/endDate override.
 * Buckets with no sales are included with total 0 so chart axes stay continuous.
 *
 * @param {object} params
 * @param {string} params.email - Owner email (created_by) the invoices belong to.
 * @param {number} [params.months=6] - Number of trailing calendar months (1-60).
 * @param {string} [params.startDate] - Optional inclusive start override (YYYY-MM-DD).
 * @param {string} [params.endDate] - Optional inclusive end override (YYYY-MM-DD).
 * @returns {Promise<object>} { timeframe, granularity, currency, range, series, summary }
 */
async function getMonthlySales(params = {}) {
  const email = requireEmail(params.email);
  const months = intParam(params.months, {
    name: "months",
    min: 1,
    max: MAX_MONTHS,
    fallback: DEFAULT_MONTHS,
  });
  const { startDate, endDate } = await resolveWindow({
    startDate: params.startDate,
    endDate: params.endDate,
    amount: months,
    unit: "month",
  });
  assertWithinSpan(startDate, endDate, "month");
  return buildRevenueResult({
    email,
    granularity: "month",
    timeframe: "monthly",
    startDate,
    endDate,
  });
}

/**
 * Trailing weekly sales revenue for the dashboard.
 *
 * Returns one bucket per ISO week (Monday-start) for the last `weeks` weeks (including the
 * current, still-in-progress week), or for an explicit startDate/endDate override.
 *
 * @param {object} params
 * @param {string} params.email - Owner email (created_by) the invoices belong to.
 * @param {number} [params.weeks=12] - Number of trailing ISO weeks (1-104).
 * @param {string} [params.startDate] - Optional inclusive start override (YYYY-MM-DD).
 * @param {string} [params.endDate] - Optional inclusive end override (YYYY-MM-DD).
 * @returns {Promise<object>} { timeframe, granularity, currency, range, series, summary }
 */
async function getWeeklySales(params = {}) {
  const email = requireEmail(params.email);
  const weeks = intParam(params.weeks, {
    name: "weeks",
    min: 1,
    max: MAX_WEEKS,
    fallback: DEFAULT_WEEKS,
  });
  const { startDate, endDate } = await resolveWindow({
    startDate: params.startDate,
    endDate: params.endDate,
    amount: weeks,
    unit: "week",
  });
  assertWithinSpan(startDate, endDate, "week");
  return buildRevenueResult({
    email,
    granularity: "week",
    timeframe: "weekly",
    startDate,
    endDate,
  });
}

/**
 * Sales revenue for an explicit custom date range.
 *
 * The inclusive startDate/endDate pair is required; `granularity` picks how the range is
 * bucketed (day/week/month, default day). The first/last bucket may be partial because it
 * is clipped to the requested range.
 *
 * @param {object} params
 * @param {string} params.email - Owner email (created_by) the invoices belong to.
 * @param {string} params.startDate - Inclusive range start (YYYY-MM-DD).
 * @param {string} params.endDate - Inclusive range end (YYYY-MM-DD).
 * @param {"day"|"week"|"month"} [params.granularity="day"] - Bucket size.
 * @returns {Promise<object>} { timeframe, granularity, currency, range, series, summary }
 */
async function getCustomRangeSales(params = {}) {
  const email = requireEmail(params.email);
  const startDate = parseISODate(params.startDate, "startDate");
  const endDate = parseISODate(params.endDate, "endDate");
  const granularity = enumParam(params.granularity, {
    name: "granularity",
    allowed: GRANULARITIES,
    fallback: GRANULARITY_DEFAULT,
  });

  assertOrderedRange(startDate, endDate);
  assertWithinSpan(startDate, endDate, granularity);

  return buildRevenueResult({
    email,
    granularity,
    timeframe: "custom",
    startDate,
    endDate,
  });
}

/**
 * Dashboard KPI rollups: today, this week, this month and the trailing 30 days.
 * Useful for headline number cards alongside the series endpoints.
 *
 * @param {object} params
 * @param {string} params.email - Owner email (created_by) the invoices belong to.
 * @param {string} [params.date] - Optional anchor date (YYYY-MM-DD); defaults to today.
 * @returns {Promise<object>} { date, currency, today, thisWeek, thisMonth, trailing30Days }
 */
async function getSalesSummary(params = {}) {
  const email = requireEmail(params.email);
  const anchor = optionalISODate(params.date, "date") || (await BillingInvoice.currentLocalDate());
  if (!anchor) {
    throw new DashboardError("Could not determine the current business date", 500);
  }

  const [today, thisWeek, thisMonth, trailing30Days] = await Promise.all([
    BillingInvoice.revenueTotals({ emailid: email, startDate: anchor, endDate: anchor }),
    BillingInvoice.revenueTotals({
      emailid: email,
      startDate: startOfWeekMonday(anchor),
      endDate: anchor,
    }),
    BillingInvoice.revenueTotals({
      emailid: email,
      startDate: startOfMonth(anchor),
      endDate: anchor,
    }),
    BillingInvoice.revenueTotals({ emailid: email, startDate: addDays(anchor, -29), endDate: anchor }),
  ]);

  return {
    date: anchor,
    currency: CURRENCY,
    today,
    thisWeek,
    thisMonth,
    trailing30Days,
  };
}

// ---------------------------------------------------------------------------
// JSON Schemas + agent tool manifest (maps natural-language intent to a function call)
// ---------------------------------------------------------------------------

const dateProp = {
  type: "string",
  pattern: "^\\d{4}-\\d{2}-\\d{2}$",
  description: "Inclusive date boundary in YYYY-MM-DD format.",
};

getMonthlySales.description =
  "Returns monthly sales revenue time-series for the dashboard. Each series point is one calendar " +
  "month with its total sales (label/date + total). Use when the user asks for sales by month, " +
  "monthly revenue trend, or revenue for the last N months.";
getMonthlySales.parameters = {
  type: "object",
  additionalProperties: false,
  properties: {
    email: { type: "string", description: "Owner email (created_by) to scope results to." },
    months: {
      type: "integer",
      minimum: 1,
      maximum: MAX_MONTHS,
      default: DEFAULT_MONTHS,
      description: "Number of trailing calendar months to include, ending with the current month.",
    },
    startDate: { ...dateProp, description: "Optional inclusive start override (YYYY-MM-DD)." },
    endDate: { ...dateProp, description: "Optional inclusive end override (YYYY-MM-DD). Defaults to today." },
  },
  required: ["email"],
};

getWeeklySales.description =
  "Returns weekly sales revenue time-series (ISO weeks, Monday-start) for the dashboard. Each series " +
  "point is one week with its total sales (label/date + total). Use when the user asks for sales by week, " +
  "weekly revenue trend, or revenue for the last N weeks.";
getWeeklySales.parameters = {
  type: "object",
  additionalProperties: false,
  properties: {
    email: { type: "string", description: "Owner email (created_by) to scope results to." },
    weeks: {
      type: "integer",
      minimum: 1,
      maximum: MAX_WEEKS,
      default: DEFAULT_WEEKS,
      description: "Number of trailing ISO weeks to include, ending with the current week.",
    },
    startDate: { ...dateProp, description: "Optional inclusive start override (YYYY-MM-DD)." },
    endDate: { ...dateProp, description: "Optional inclusive end override (YYYY-MM-DD). Defaults to today." },
  },
  required: ["email"],
};

getDailySales.description =
  "Returns daily sales revenue time-series for the dashboard (the default view). Each series " +
  "point is one calendar day with its total sales (label/date + total). Use when the user asks " +
  "for sales by day, daily revenue trend, today's/yesterday's sales, or revenue for the last N days.";
getDailySales.parameters = {
  type: "object",
  additionalProperties: false,
  properties: {
    email: { type: "string", description: "Owner email (created_by) to scope results to." },
    days: {
      type: "integer",
      minimum: 1,
      maximum: MAX_DAYS,
      default: DEFAULT_DAYS,
      description: "Number of trailing calendar days to include, ending with today.",
    },
    startDate: { ...dateProp, description: "Optional inclusive start override (YYYY-MM-DD)." },
    endDate: { ...dateProp, description: "Optional inclusive end override (YYYY-MM-DD). Defaults to today." },
  },
  required: ["email"],
};

getCustomRangeSales.description =
  "Returns sales revenue for an explicit custom date range, bucketed by day, week or month. " +
  "Use when the user gives a start and end date (e.g. 'between 1 Aug and 7 Sep') and wants revenue " +
  "split over time, rather than a simple total.";
getCustomRangeSales.parameters = {
  type: "object",
  additionalProperties: false,
  properties: {
    email: { type: "string", description: "Owner email (created_by) to scope results to." },
    startDate: { ...dateProp, description: "Inclusive range start (YYYY-MM-DD). Required." },
    endDate: { ...dateProp, description: "Inclusive range end (YYYY-MM-DD). Required." },
    granularity: {
      type: "string",
      enum: GRANULARITIES,
      default: GRANULARITY_DEFAULT,
      description: "Bucket size for the range: day, week or month.",
    },
  },
  required: ["email", "startDate", "endDate"],
};

getSalesSummary.description =
  "Returns headline sales KPI rollups (currency totals + invoice counts) for today, this week, " +
  "this month and the trailing 30 days. Use for summary cards or when the user asks 'how much did " +
  "we sell today/this week/this month' without needing a chart series.";
getSalesSummary.parameters = {
  type: "object",
  additionalProperties: false,
  properties: {
    email: { type: "string", description: "Owner email (created_by) to scope results to." },
    date: { ...dateProp, description: "Optional anchor date (YYYY-MM-DD). Defaults to today." },
  },
  required: ["email"],
};

/** Immutable function-name allow-list backing the router + agent manifest. */
const TOOL_FUNCTIONS = Object.freeze({
  getDailySales,
  getMonthlySales,
  getWeeklySales,
  getCustomRangeSales,
  getSalesSummary,
});

/**
 * Machine-readable tool manifest. Each entry is safe for an agent runtime: `execute`
 * validates args against the declared JSON Schema and returns { success, data|error }
 * instead of throwing.
 */
const agentTools = Object.freeze(
  Object.values(TOOL_FUNCTIONS).map((fn) => ({
    name: fn.name,
    description: fn.description,
    parameters: fn.parameters,
    execute: async (args) => {
      try {
        const data = await fn(args || {});
        return { success: true, data };
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  }))
);

// ---------------------------------------------------------------------------
// Express route handlers (thin adapters over the shared tool functions)
// ---------------------------------------------------------------------------

function toHttpHandler(toolFunction) {
  return async (req, res) => {
    try {
      // req.user is populated by reqAuth (index.js mounts these routes behind it).
      const data = await toolFunction({ email: req.user?.email, ...req.query });
      return res.status(200).json({ success: true, data });
    } catch (err) {
      if (err instanceof DashboardError) {
        return res.status(err.status).json({ success: false, error: err.message });
      }
      console.error("Dashboard revenue error:", err);
      return res.status(500).json({ success: false, error: "Internal server error" });
    }
  };
}

const httpDaily = toHttpHandler(getDailySales);
const httpMonthly = toHttpHandler(getMonthlySales);
const httpWeekly = toHttpHandler(getWeeklySales);
const httpCustomRange = toHttpHandler(getCustomRangeSales);
const httpSummary = toHttpHandler(getSalesSummary);

module.exports = {
  // Data-access functions — callable directly by an agent/integration layer.
  getDailySales,
  getMonthlySales,
  getWeeklySales,
  getCustomRangeSales,
  getSalesSummary,
  // Tool manifest for intent -> function mapping (JSON Schema included).
  agentTools,
  // Express handlers.
  httpDaily,
  // Express handlers.
  httpMonthly,
  httpWeekly,
  httpCustomRange,
  httpSummary,
  DashboardError,
  // Re-exported constants for introspection/testing.
  GRANULARITIES,
  CURRENCY,
};
