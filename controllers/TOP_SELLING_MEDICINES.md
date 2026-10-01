# Best-Selling Medicines — API, Response View & Render Contract

Answers **"which medicines sold the most over a period?"** It returns a single ranked
**leaderboard**: one row per medicine with its total **units sold** and total **revenue** over a
date window — **last 30 days by default**, or any custom `startDate`/`endDate` range. There is no
DAY/WEEK/MONTH bucketing; the frontend sorts the list by units or revenue as it likes.

Data is served from the materialized view **`pharma.mv_daily_medicine_sales`**, not from the
live `billing_items`/`billing_invoice` tables — the same pattern the revenue endpoints use with
`pharma.mv_daily_revenue`. See §4 for provisioning and refresh.

> This backend exposes JSON only — there is no server-rendered template. The "view" is the
> stable response contract below plus the render snippets at the end, which the SPA/dashboard
> consumes directly.

---

## 1. Files

| File | Responsibility |
| --- | --- |
| `models/sql/mv_daily_medicine_sales.sql` | DDL for the rollup + its unique index, plus refresh/cron notes. Apply once. |
| `models/dashboard.js` | `Dashboard.topSellingMedicines()` (reads the rollup), `topSellingDataThrough()`, `ensureDailyMedicineSalesView()`, `refreshDailyMedicineSalesView()`. |
| `controllers/dashboard.js` | `getTopSellingMedicines()` (validation + shaping), `refreshTopSellingMedicines()` (debounced rebuild), JSON Schema, `agentTools` entry, HTTP handlers. |
| `routes/dashboard.js` | `GET /dashboard/top-selling-medicines`, `POST /dashboard/top-selling-medicines/refresh`. |
| `index.js` | Unchanged — already mounts the router behind `reqAuth`. |

---

## 2. Endpoint

```
GET /dashboard/top-selling-medicines?days=30&limit=50&sortBy=quantity
Authorization: Bearer <token>
```

Behind `reqAuth`, so results are always scoped to the **logged-in user**:
`pharma.billing_items` rows are joined to `pharma.billing_invoice` and filtered by
`created_by = req.user.email`. There is no way to request another user's data.

| Query param | Type | Default | Validation |
| --- | --- | --- | --- |
| `days` | integer | `30` | 1–370 — trailing calendar days, ending today |
| `limit` | integer | `50` | 1–200 — **page size**: max medicines returned |
| `sortBy` | enum | `quantity` | `quantity` \| `revenue` — metric the server ranks the page by |
| `startDate` | `YYYY-MM-DD` | — | optional inclusive override |
| `endDate` | `YYYY-MM-DD` | today (DB session date, Asia/Kolkata) | optional inclusive override |

`startDate`/`endDate` override the trailing window; the span is capped like the other
dashboard endpoints (`MAX_RANGE_DAYS.day` ≈ 12 months).

### 2.0 Page size ("records to show") dropdown

`limit` is the page size behind the frontend's **records-to-show dropdown**. It defaults to
`50`; the suggested dropdown values are exported as `TOP_MEDICINE_OPTIONS` (`[10, 25, 50, 100]`)
and echoed in every response as `data.pageSize`, so the UI can render the dropdown from the API
instead of hardcoding a list that could drift from server validation:

```json
"pageSize": { "limit": 50, "options": [10, 25, 50, 100], "max": 200 }
```

The list holds at most `limit` medicines, ranked by `sortBy`. Anything above `200` is a `400`.
The frontend can re-sort the returned rows client-side by `totalQuantitySold` or `totalRevenue`
for its own toggle; match `sortBy` to the metric you need the true top-N for.

```bash
# Frontend dropdown change -> just re-request with the chosen page size
curl "http://localhost:8080/dashboard/top-selling-medicines?days=30&limit=10" \
  -H "Authorization: Bearer <token>"
```

```bash
# Last 30 days, ranked by revenue instead of units
curl "http://localhost:8080/dashboard/top-selling-medicines?sortBy=revenue" \
  -H "Authorization: Bearer <token>"
```

```bash
# Custom range explicitly overriding the trailing window
curl "http://localhost:8080/dashboard/top-selling-medicines?startDate=2026-08-01&endDate=2026-09-07" \
  -H "Authorization: Bearer <token>"
```

### 2.1 `POST /dashboard/top-selling-medicines/refresh`

Rebuilds `pharma.mv_daily_medicine_sales` so the GET above picks up new sales. Also creates the
rollup if it does not exist yet, so calling this once provisions a fresh database.

| Body/query param | Type | Default | Notes |
| --- | --- | --- | --- |
| `force` | boolean | `false` | Bypass the debounce window and rebuild now. |
| `concurrently` | boolean | `true` | `false` forces a blocking rebuild. |

```bash
curl -X POST "http://localhost:8080/dashboard/top-selling-medicines/refresh" \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" -d '{"force":true}'
```

```json
{ "success": true, "data": { "refreshed": true, "concurrently": true, "durationMs": 412, "lastRefreshedAt": "2026-09-30T09:12:04.881Z", "nextAllowedInSeconds": 300 } }
```

It is a **maintenance** action, not a per-user read — one rebuild covers every owner — so it is
debounced to at most once per `MV_REFRESH_MIN_INTERVAL_SECONDS` (default `300`, `0` disables)
and concurrent callers share a single in-flight rebuild. A debounced call answers
`refreshed: false` with a `reason` and the previous rebuild's timings rather than doing work.
It is intentionally **not** exposed in the `agentTools` manifest.

---

## 3. Response view

```json
{
  "success": true,
  "data": {
    "currency": "INR",
    "range": { "startDate": "2026-09-02", "endDate": "2026-10-01" },
    "lookbackDays": 30,
    "dataThrough": "2026-09-30",
    "source": "pharma.mv_daily_medicine_sales",
    "sort": { "by": "quantity", "options": ["quantity", "revenue"] },
    "pageSize": { "limit": 50, "options": [10, 25, 50, 100], "max": 200 },
    "series": [
      { "rank": 1, "medicineId": 412, "medicineName": "Paracetamol 650mg", "totalQuantitySold": 3480, "totalRevenue": 104400 },
      { "rank": 2, "medicineId": 205, "medicineName": "Azithromycin 500mg", "totalQuantitySold": 2100, "totalRevenue": 94500 }
    ],
    "summary": {
      "medicineCount": 42,
      "totalQuantitySold": 15820,
      "totalRevenue": 486500,
      "bestByQuantity": { "rank": 1, "medicineId": 412, "medicineName": "Paracetamol 650mg", "totalQuantitySold": 3480, "totalRevenue": 104400 },
      "bestByRevenue": { "rank": 2, "medicineId": 205, "medicineName": "Azithromycin 500mg", "totalQuantitySold": 2100, "totalRevenue": 94500 }
    }
  }
}
```

Field semantics:

| Field | Notes |
| --- | --- |
| `range` | Inclusive window actually queried (`startDate`..`endDate`). |
| `lookbackDays` | The trailing-day count used when no explicit range was supplied. |
| `series` | The leaderboard, ordered highest-to-lowest by `sort.by`. `rank` is 1-based and matches that order. |
| `totalQuantitySold` | Units of the medicine sold in the window (`SUM(billing_items.qty)`). |
| `totalRevenue` | Sum of `billing_items.total` (line total, net of line discount) for that medicine in the window. |
| `dataThrough` | Latest business day present in the rollup for this owner — render it as **"as of `<dataThrough>`"**. The rollup is a snapshot, so this can trail today's sales until the next refresh. `null` when the owner has no rows. |
| `source` | Name of the rollup the numbers came from, for debugging/telemetry. |
| `sort` | `by` echoes the applied ranking metric; `options` lists the accepted values. |
| `pageSize` | The applied page size plus the dropdown options. `limit` is the value used, `options` is the suggested dropdown list, `max` is the hard cap (`series.length <= limit`). |
| `summary.bestByQuantity` / `bestByRevenue` | The #1 medicine by each metric, so a card can label the toggle without re-deriving it. |

Empty result (no sales in the window) is a **success**, not a 404: `series: []`,
`summary.medicineCount: 0`, and both `bestBy*` are `null`.

Errors use the standard envelope (with `hint` on the rollup error):

| Status | Cause |
| --- | --- |
| `401` | Missing/invalid token (`reqAuth`). |
| `400` | Bad `days`/`limit`/`sortBy`/date format, `startDate` after `endDate`, or span too wide. |
| `503` | `pharma.mv_daily_medicine_sales` has not been provisioned. The response carries a `hint` telling you to apply `models/sql/mv_daily_medicine_sales.sql` or POST the refresh endpoint. |

---

## 4. The rollup (`pharma.mv_daily_medicine_sales`)

One row per **(day, owner, medicine)**:

| Column | Type | Notes |
| --- | --- | --- |
| `day_bucket` | `date` | `billing_invoice.invoice_date` — the local business day. |
| `created_by` | `varchar(150)` | Owner the sales belong to. |
| `medicine_id` | `bigint` | Nullable (legacy line items). |
| `medicine_name` | `varchar(200)` | Snapshot name from the sale line. |
| `total_quantity_sold` | `bigint` | `SUM(qty)`. |
| `total_revenue` | `numeric(14,2)` | `SUM(total)`. |

**Why:** ranking medicines over a date window against raw line items means a two-table join plus
grouping over every sale, on every request. The rollup turns that into a scan of one row per
(day, owner, medicine), so the per-medicine totals run over a table orders of magnitude smaller —
exactly what `pharma.mv_daily_revenue` does for the revenue endpoints.

**Provision it once:**

```bash
psql "$DATABASE_URL" -f models/sql/mv_daily_medicine_sales.sql
```

Or let the app do it: `POST /dashboard/top-selling-medicines/refresh` calls
`ensureDailyMedicineSalesView()` first, so one call both creates and populates the rollup on a
fresh database.

**Keep it fresh.** Because it is a snapshot, the dashboard lags the billing tables between
refreshes. Two options:

- On demand — `POST /dashboard/top-selling-medicines/refresh` (debounced to one rebuild per
  `MV_REFRESH_MIN_INTERVAL_SECONDS`, default 5 minutes).
- On a schedule — the refresh is `CONCURRENTLY`, so readers are never blocked:

```cron
*/15 * * * * psql "$DATABASE_URL" -c 'REFRESH MATERIALIZED VIEW CONCURRENTLY pharma.mv_daily_medicine_sales'
```

Remember to refresh after any **backdated** invoice insert/update/delete, otherwise the
dashboard will not show it. `dataThrough` in the response tells you how far the rollup has
caught up.

---

## 5. View rendering

### 5.1 Sortable top-medicines table with a units/revenue toggle

The list arrives pre-ranked and every row carries **both** metrics, so the toggle is pure
client-side re-sorting — no refetch:

```jsx
const [metric, setMetric] = React.useState("totalQuantitySold"); // or "totalRevenue"
const { series, summary, currency, dataThrough } = data;

const rows = [...series].sort((a, b) => b[metric] - a[metric]);

return (
  <div>
    <div className="flex gap-2">
      <button onClick={() => setMetric("totalQuantitySold")}>Units sold</button>
      <button onClick={() => setMetric("totalRevenue")}>Revenue</button>
      <span>as of {dataThrough}</span>
    </div>
    <table>
      <thead>
        <tr><th>#</th><th>Medicine</th><th>Units</th><th>Revenue</th></tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={r.medicineId ?? r.medicineName}>
            <td>{i + 1}</td>
            <td>{r.medicineName}</td>
            <td>{r.totalQuantitySold}</td>
            <td>{currency} {r.totalRevenue}</td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);
```

### 5.2 Bar chart of the top N medicines (Chart.js)

```js
import { Bar } from "react-chartjs-2";

const rows = [...series].sort((a, b) => b.totalQuantitySold - a.totalQuantitySold).slice(0, 10);

<Bar
  data={{
    labels: rows.map((r) => r.medicineName),
    datasets: [{ label: "Units sold", data: rows.map((r) => r.totalQuantitySold) }],
  }}
/>;
```

### 5.3 Headline cards from `summary`

```jsx
const { bestByQuantity, bestByRevenue, currency } = summary;
// "Top seller (units): <bestByQuantity.medicineName> — {bestByQuantity.totalQuantitySold} units"
// "Top seller (revenue): <bestByRevenue.medicineName> — {currency} {bestByRevenue.totalRevenue}"
```

---

## 6. Notes & edge cases

- **One row per medicine.** The window is collapsed into a single row per medicine, so
  `summary.totalQuantitySold` / `summary.totalRevenue` are the sums across the whole leaderboard.
- **Staleness.** All figures come from the rollup, so they are accurate as of `dataThrough`, not
  "now". Surface that in the UI rather than implying live data.
- **Ranking.** Ordered by the requested metric first (`total_quantity_sold DESC` or
  `total_revenue DESC`), then the other metric, then `medicine_name`, then `medicine_id` —
  deterministic, so a tie never flips the order between calls.
- **`medicineId` may be `null`** on legacy line items; `medicineName` is always present.
- **Business date.** `day_bucket` comes from `billing_invoice.invoice_date` (local business day),
  matching the other dashboard endpoints — not `created_at`, so the window is clean local calendar
  days with no client-side timezone shifting.
- **First deploy.** Until the rollup exists the endpoint answers `503` with a `hint` (never a
  bare `500`), so the failure is self-explanatory in logs and clients.
