# Plan — Orders Snapshot, Phase 2: Dashboard

## Context
Phases 0–1 are done (upload → detect → map → canonical rows → temporary summary). PLAN.md (unchanged
since Phase 1) says Phase 2 is a one-screen management view for a selected month: month selector,
KPIs, 4 charts, a table of non-delivered orders, and 3–5 Hebrew insights. The success check is that the
numbers match an Excel pivot table. Month-over-month, second-file upload and print/PDF stay in Phase 3.
Same stack: index.html + app.js + styles.css, opens from file://, and only SheetJS + Chart.js load
from the CDN. The "Ship To" column is still excluded from detection and never copied.

## File changes
| File | Change |
|---|---|
| `app.js` | Canonical rows gain `ym` + `day` keys (so filtering costs nothing). New pure section: `monthStats`, `isPartialMonth`, `pickDefaultMonth`, `filterByMonth`, `aggregate`, `buildInsights`, `shipTypeLabel`, `isDelivered`. New render section: `renderDashboard`, `renderMonthSelect`, `renderKpis`, `renderCarrierChart`, `renderShipTypeChart`, `renderTopClients`, `renderDailyChart`, `renderExceptions`, `renderInsights`, `destroyCharts`. Phase-1 `summarize`/`renderSummary` removed. Exports extended for tests. |
| `index.html` | Temporary summary section replaced by `#dashboard`: toolbar (month `<select>`, partial badge), KPI grid, insights list, 2×2 chart grid (each card has a `<canvas>` and an empty state), exceptions table. Header button renamed "החלף קובץ". The mapping `<details>` stays. |
| `styles.css` | Chart-palette tokens, KPI grid 6→3→2, chart grid 2→1, insight tone borders (info/warn/good), badge, empty state, fixed-height chart boxes. |
| `tests/tests.html` | New tests (see §7). It will load `../test-data/missing-required.csv` inline as a fixture string, because browsers block file:// fetch. |

## Metrics object — `aggregate(rows)` (pure, no DOM, one pass + small sorts)
```js
{
  orders: 13335,              // distinct orderId
  rows: 13335,                // raw row count (≠ orders if an order spans rows)
  units: 48509 | null,        // Σ units; null if no units column is mapped → card hidden
  lines: 38271 | null,        // Σ lines; null if lines not mapped
  avgLinesPerOrder: 2.87 | null,
  activeClients: 25,
  activeDays: 23,
  lockerShare: 0.172 | null,  // orders whose shipType contains "LOCKER" ÷ orders with a shipType; null if unmapped
  hasShipType, hasStatus, hasUnits, hasLines,   // booleans that decide visibility
  carriers: {
    items: [{ name:'CARGO', orders:5554, share:0.4165 }, …],   // ≥1% share, desc
    other: { orders:5, share:0.0004, members:[{name:'GB',orders:3},…] } | null,
    leader: { name, orders, share }
  },
  shipTypes: [{ code:'ND', label:'משלוח עד הבית', orders, share }, …] | null,
  topClients: { items:[{ name:'PR922', orders:5749, share }, …5], top5Share, top2Share },
  daily: { days:[{ date:'2026-06-01', orders }, …] /* every calendar day of the month, 0 if none */,
           peak:{ date, orders }, avgPerActiveDay },
  exceptions: { total:37, byStatus:[{status, orders}], byCarrier:[{carrier, orders}],
                rows:[{status, carrier, orders}] /* status×carrier, desc */, topCarrier } | null
}
```
Order-level rules: a distinct orderId counts once. Carrier, client, type and status are taken from the
order's first row. Units and lines are summed over all rows. Non-delivered = status does not contain
"DELIVERED" (case-insensitive). Empty status is not counted as an exception.

## 1. Month selector
- `monthStats(rows)`: the list of `{ym, y, m, orders, firstDay, lastDay, partial}`.
- `isPartialMonth`: `lastDay < daysInMonth − 2` OR `firstDay > 3`. July ending on the 28th (31−28=3 > 2) is partial.
- `pickDefaultMonth`: the latest month that is not partial. If every month is partial, the latest month.
- `<select>` options read "יוני 2026 · 13,335 הזמנות", and partial months add "(חלקי)". When a partial
  month is selected, a warning badge "חודש חלקי — נתונים עד 28/07" appears next to it.
- On change: `destroyCharts()`, then `filterByMonth` → `aggregate` → `buildInsights` → render.

## 2. KPI cards
סה"כ הזמנות · סה"כ יחידות · ממוצע שורות להזמנה · לקוחות פעילים · אחוז לוקרים · ימי פעילות.
Numbers are formatted with he-IL `Intl.NumberFormat`: averages to 2 decimals, percentages to 1 decimal. A card
is removed (not zeroed) when its field is unmapped: units → יחידות, lines → ממוצע שורות,
shipType → אחוז לוקרים.

## 3. Charts (Chart.js 4, defaults set once)
- Global settings: Heebo font, muted grid lines, `animation:false` (speed), tooltips in RTL (`rtl:true`,
  `textDirection:'rtl'`), and horizontal bars with the category axis on the right (`position:'right'`)
  and `x.reverse:true`, so bars grow right→left.
- Palette from the dataviz reference (validated order): blue `#2a78d6`, orange `#eb6834`, aqua `#1baf7a`,
  yellow `#eda100`, magenta `#e87ba4`, green `#008300`, violet `#4a3aa7`, red `#e34948`. The "אחר" bar is gray.
  Single-series bars all use slot 1 (blue). Colors stay fixed to the entity, never to its rank.
- **Carriers**: horizontal bars sorted desc, with "אחר" last. A small inline plugin (no extra CDN) draws the label
  "5,554 · 41.6%" at each bar's end. The "אחר" tooltip lists its members.
- **Ship type**: doughnut with a fixed color per code (ND=slot1, LOCKER=slot2, unknown codes → next slots).
  The Hebrew label is shown and the raw code appears in the tooltip. The legend is at the bottom. Hidden if shipType is unmapped.
- **Top 5 clients**: horizontal bars with "orders · share%" labels. A line under the title reads
  "5 הלקוחות המובילים = X% מההזמנות".
- **Daily volume**: bars for each calendar day (days with no shipments show as 0, so gaps are honest). The peak
  day is drawn in the accent color with a label, plus a dashed line for the average of active days. Tooltip: "יום ג' 09/06 · 812 הזמנות".
- Every chart card has a Hebrew empty state ("אין נתונים לחודש זה").

## 4. Exceptions table
A status × carrier table with counts, sorted desc, plus a total row. If there are none, it shows "אין חריגות 🎉".
If status is unmapped, the card is hidden.

## 5. Insights — `buildInsights(metrics)` → `[{tone:'info'|'warn'|'good', text}]`, 3–5 items
Rules are checked in order, and the first 5 that apply are kept:
1. Carrier leader: "CARGO הוביל עם 41.6% מההזמנות (5,554), ואחריו BUZZ עם 26.4%." (info)
2. Concentration: top-2 share > 50% → warn "2 הלקוחות הגדולים = 67.2% מהנפח — תלות גבוהה"; otherwise info.
3. Peak day: "שיא ב-09/06 עם 812 הזמנות — 1.4× מהממוצע היומי (580)." (info; warn if > 1.5×)
4. Lockers (if shipType is mapped): "17.2% מההזמנות נשלחו ללוקרים." (info)
5. Exceptions (if status is mapped): 0 → good "כל ההזמנות נמסרו"; otherwise warn "37 הזמנות לא במצב נמסר
   (0.3%), הרוב אצל BUZZ (14)." Tone is warn when the rate is ≥ 1%, info when lower.
All numbers come from the metrics object, and the function never crashes when optional fields are missing.

## 6. Layout & performance
- KPI grid is 6 columns on desktop, 3 at ≤1100px, and 2 at ≤640px. Charts are 2 per row, 1 at ≤900px. Chart boxes have a fixed height of 300px
  (`maintainAspectRatio:false`).
- Speed: `ym` and `day` are precomputed at normalization. The month map is built once. Switching month = filter (~70k
  comparisons) + one aggregate pass + 4 chart draws with no animation. Target is < 1 s, and I will measure it.

## 7. Tests (added to tests/tests.html)
- `aggregate` on a 10-row fixture with hand-computed totals: orders, units, avg lines, clients, lockers,
  days, peak, and exceptions by status×carrier.
- `isPartialMonth` / `pickDefaultMonth`: July ending on the 28th → partial, and the default is June. A first day of 4 → partial.
- "אחר" grouping: a carrier below 1% is folded into "אחר" with its members listed. Nothing is folded when all carriers are ≥ 1%.
- Missing optional fields: normalize `missing-required.csv` with only the required fields plus a manual carrier
  choice, then check that `aggregate` returns null metrics and `buildInsights` returns 3+ strings without throwing.
- `filterByMonth` returns only rows from that month.

## Verification
1. `tests.html` passes in headless Chromium (Asia/Jerusalem time zone).
2. **Real file (approved):** copy `Shipped_Orders.xlsx` into my workspace, run it through the page, and
   compare June 2026 with your figures: 13,335 / 48,509 / 2.87 / 25 / 17.2% / 23 days /
   CARGO 5,554, BUZZ 3,524, KATZ 2,826, DUMMYDC 1,426, other 5 / PR922 5,749 / 37 exceptions, with June as the default month.
   No names are printed. The workspace copy is deleted afterwards.
3. Time month switching on the real file (goal < 1 s). Confirm no console errors and that no Ship To values appear on the page.
4. Screenshots of the dashboard (desktop + mobile width), then copy the updated files into your folder.
