# Dashboard Revenue Analytics — API & AI-Agent Tool Reference

Sales-revenue analytics over `pharma.billing_invoice`, powered by the existing
`models/billingInvoice.js` model. Exposes both HTTP endpoints (for the dashboard UI/charts)
and a machine-readable tool manifest (`dashboard.agentTools`) that an AI agent can use to map
natural-language intent directly to a function call.

> All data is **read-only** and scoped to the authenticated owner (`created_by = <email>`).

---

## 1. Files

| File | Responsibility |
| --- | --- |
| `models/billingInvoice.js` | Added read-only statics: `currentLocalDate()`, `revenueTimeSeries()`, `revenueTotals()`. |
| `controllers/dashboard.js` | Validation, date math, tool functions, JSON Schemas, `agentTools` manifest, Express handlers. |
| `routes/dashboard.js` | Router wiring for the five endpoints below. |
| `index.js` | Mounts the router: `app.use("/dashboard/", reqAuth, dashboardRoutes)`. |

No changes were required to invoice **creation** — the analytics read only from the existing
table via the existing model.

---

## 2. HTTP Endpoints

Base URL: `http://localhost:8080` (all routes are behind `reqAuth`, so send `Authorization:
Bearer <token>` or the session cookie).

### 2.1 `GET /dashboard/revenue/daily`

Trailing calendar days of sales revenue (default **30**), ending **today**. This is the
**default dashboard view**. An explicit `startDate`/`endDate` pair overrides the trailing window.

| Query param | Type | Default | Validation |
| --- | --- | --- | --- |
| `days` | integer | `30` | 1–370 |
| `startDate` | `YYYY-MM-DD` | — | real calendar date; optional override |
| `endDate` | `YYYY-MM-DD` | today (Asia/Kolkata) | real calendar date; optional override |

```bash
curl "http://localhost:8080/dashboard/revenue/daily?days=30" \
  -H "Authorization: Bearer <token>"
```

### 2.2 `GET /dashboard/revenue/monthly`

Trailing calendar months of sales revenue (default **6**), ending with the current month.
An explicit `startDate`/`endDate` pair overrides the trailing window.

| Query param | Type | Default | Validation |
| --- | --- | --- | --- |
| `months` | integer | `6` | 1–60 |
| `startDate` | `YYYY-MM-DD` | — | real calendar date; optional override |
| `endDate` | `YYYY-MM-DD` | today (Asia/Kolkata) | real calendar date; optional override |

```bash
curl "http://localhost:8080/dashboard/revenue/monthly?months=6" \
  -H "Authorization: Bearer <token>"
```

### 2.3 `GET /dashboard/revenue/weekly`

Trailing ISO weeks (**Monday–Sunday**) of sales revenue (default **12**), ending with the
current week. Optional `startDate`/`endDate` override.

| Query param | Type | Default | Validation |
| --- | --- | --- | --- |
| `weeks` | integer | `12` | 1–104 |
| `startDate` | `YYYY-MM-DD` | — | optional override |
| `endDate` | `YYYY-MM-DD` | today | optional override |

### 2.4 `GET /dashboard/revenue/range`

Explicit, inclusive custom date range bucketed by `day` | `week` | `month`.

| Query param | Type | Default | Validation |
| --- | --- | --- | --- |
| `startDate` | `YYYY-MM-DD` | — | **required** |
| `endDate` | `YYYY-MM-DD` | — | **required**, must be `>= startDate` |
| `granularity` | enum | `day` | `day` \| `week` \| `month` |

Range-span guardrails (reject oversized payloads with a 400):

- `day` → ≤ 370 days
- `week` → ≤ ~5 years
- `month` → ≤ ~10 years

```bash
curl "http://localhost:8080/dashboard/revenue/range?startDate=2026-08-01&endDate=2026-09-07&granularity=day" \
  -H "Authorization: Bearer <token>"
```

### 2.5 `GET /dashboard/summary`

Headline KPI rollups for today / this week / this month / trailing 30 days
(total + invoice count each). Optional `date` anchor (defaults to today).

---

## 3. Response shape (chart-ready)

Every series endpoint returns the same envelope:

```jsonc
{
  "success": true,
  "data": {
    "timeframe": "daily",          // daily | monthly | weekly | custom
    "granularity": "day",          // day | week | month
    "currency": "INR",
    "range": { "startDate": "2026-08-09", "endDate": "2026-09-07" },
    "series": [                     // ← drop straight into a line/bar chart
      {
        "label": "2026-08",         // x-axis key  (2026-08 | 2026-W35 | 2026-08-22)
        "startDate": "2026-08-01",  // bucket start (YYYY-MM-DD)
        "endDate": "2026-08-31",    // bucket end   (YYYY-MM-DD)
        "total": 3010,              // revenue (sum of final_payable, net of discounts)
        "invoiceCount": 15
      }
      // ...zero-sale buckets are present too (total: 0) so the axis has no gaps
    ],
    "summary": {
      "totalRevenue": 5030,
      "totalInvoices": 26,
      "periodCount": 3,
      "activePeriods": 2,
      "averagePerPeriod": 1676.67,
      "bestPeriod": { "label": "2026-08", "total": 3010 }
    }
  }
}
```

Error responses follow the app convention: `{ "success": false, "error": "<message>" }`
with status 400 (validation), 401 (auth middleware), 500 (server).

---

## 4. AI-agent tool definitions

`controllers/dashboard.js` exports a manifest (`dashboard.agentTools`) where every entry has:

- `name` — the function to call,
- `description` — when to use it (intent matching),
- `parameters` — a JSON Schema for validating extracted arguments,
- `execute(args)` — safe wrapper returning `{ success, data }` or `{ success: false, error }`
  (it never throws, so an agent runtime can call it blindly).

The same functions back the HTTP endpoints, so the agent answer and the chart can never drift.

### 4.1 Manifest

```js
const dashboard = require("../controllers/dashboard");
console.log(dashboard.agentTools);
// [
//   { name: "getDailySales",        description: "...", parameters: { JSON Schema }, execute },
//   { name: "getMonthlySales",      description: "...", parameters: { JSON Schema }, execute },
//   { name: "getWeeklySales",       description: "...", parameters: { JSON Schema }, execute },
//   { name: "getCustomRangeSales",  description: "...", parameters: { JSON Schema }, execute },
//   { name: "getSalesSummary",      description: "...", parameters: { JSON Schema }, execute }
// ]
```

### 4.2 Tool catalog

#### `getDailySales`
- **Use when:** user asks for sales by day / daily revenue trend / "today's sales" /
  "last N days". This is the dashboard's default view.
- **Inputs:** `email` (required), `days` (1–370, default 30), optional `startDate`, `endDate`.

#### `getMonthlySales`
- **Use when:** user asks for sales by month / monthly revenue trend / "last N months".
- **Inputs:** `email` (required), `months` (1–60, default 6), optional `startDate`, `endDate`.
- **JSON Schema:**
  ```json
  {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "email":     { "type": "string", "description": "Owner email (created_by) to scope results to." },
      "months":    { "type": "integer", "minimum": 1, "maximum": 60, "default": 6 },
      "startDate": { "type": "string", "pattern": "^\\d{4}-\\d{2}-\\d{2}$" },
      "endDate":   { "type": "string", "pattern": "^\\d{4}-\\d{2}-\\d{2}$" }
    },
    "required": ["email"]
  }
  ```

#### `getWeeklySales`
- **Use when:** user asks for sales by week / weekly revenue trend / "last N weeks".
- **Inputs:** `email` (required), `weeks` (1–104, default 12), optional `startDate`, `endDate`.

#### `getCustomRangeSales`
- **Use when:** user supplies a start **and** end date ("between 20 Aug and 7 Sep") and wants
  revenue split over time.
- **Inputs:** `email`, `startDate`, `endDate` (all required), `granularity`
  (`day`|`week`|`month`, default `day`).

#### `getSalesSummary`
- **Use when:** user asks "how much did we sell today / this week / this month" (KPI cards).
- **Inputs:** `email` (required), optional `date` anchor.

### 4.3 Example agent call

```js
const tool = dashboard.agentTools.find((t) => t.name === "getMonthlySales");
const result = await tool.execute({ email: user.email, months: 6 });

// result.success === true
// result.data.series  -> array of { label, startDate, endDate, total, invoiceCount }
```

### 4.4 Example intent → tool mapping

| User says | Tool | Params |
| --- | --- | --- |
| "Show me the last 30 days of sales" | `getDailySales` | `{ days: 30 }` |
| "Show sales for the last 6 months" | `getMonthlySales` | `{ months: 6 }` |
| "What's my weekly revenue trend?" | `getWeeklySales` | `{ weeks: 12 }` |
| "Revenue between 20 Aug and 7 Sep, daily" | `getCustomRangeSales` | `{ startDate: "2026-08-20", endDate: "2026-09-07", granularity: "day" }` |
| "How much did we sell this month?" | `getSalesSummary` | `{}` (uses `today` anchor) |

---

## 5. Timezone & date semantics

- Invoice rows carry an `invoice_date` business day (stored as ISO date). All analytics filter
  and group on **that** column — never on `created_at` — so buckets are clean local calendar
  periods with zero timezone shifting on the client.
- "Today" / trailing windows are anchored to the DB session's `CURRENT_DATE`, which is pinned
  to **Asia/Kolkata** via the pool options (`-c timezone=Asia/Kolkata`) — not to the Node
  process clock — keeping boundaries consistent with how invoices are stamped at creation.
- Weeks are ISO (Monday–Sunday); the series is gap-filled with `generate_series`, so days/weeks/
  months with no sales appear as `total: 0` instead of missing rows.
- `invoice_date` may be physically stored as `DATE` or as ISO `TEXT` (both have existed in this
  schema). The queries normalize it with an explicit `::date` cast so they are type-safe
  regardless of the deployed column type. All user input is parameterized; the only string
  interpolations come from a fixed in-code allow-list of bucket definitions.

## 6. Guardrails / error handling

- Input validation happens **before** SQL: real calendar dates, ordered ranges, bounded spans,
  integer/enum ranges. Invalid input → `400 { success: false, error }`.
- All queries are **parameterized** (`$1, $2, …`); no user text ever reaches SQL text.
- Server errors are logged and returned as `500`; the model never mutates invoice data.
- Read endpoints intentionally do **not** auto-create tables — they assume the billing flow has
  already run `ensureTablesExist()` (invoice creation does this automatically).
