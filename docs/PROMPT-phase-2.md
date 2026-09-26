Phase 0 and Phase 1 are done and all tests pass. Read PLAN.md again.

Implement **Phase 2: Dashboard** only. Do not build month-over-month deltas, second-file
upload or print/PDF yet (that is Phase 3). Keep the same stack: plain index.html + app.js
+ styles.css, no build step, must still open from file:// with a double-click.

Architecture rules:
- Build on the existing canonical rows from Phase 1. Charts and KPIs read canonical
  fields only, never raw header names.
- Split the logic into pure functions: `filterByMonth(rows, ym)`, `aggregate(rows)` →
  plain metrics object, `buildInsights(metrics)` → array of Hebrew strings, and render
  functions that only draw. Aggregation must not touch the DOM.
- Optional fields (shipType, status, units, lines) may be missing: hide the matching KPI
  card / chart instead of crashing or showing zeros.
- Never render the "Ship To" column. No network calls except the two CDN libraries.

1. Month selector
   - Dropdown of all months found in the file, Hebrew labels ("יוני 2026") + order count.
   - Default = latest *complete* month. A month is partial if its last ship date is
     more than 2 days before the month's end (weekends allowed for), or its first date
     is after day 3.
     Partial months stay selectable, marked "(חלקי)", and show a small warning badge.
   - Changing the month re-renders everything (destroy old Chart.js instances first).
   - Replace the temporary Phase 1 summary with the dashboard; keep a small
     "החלף קובץ" button and the collapsible column-mapping summary.

2. KPI cards (top row)
   סה"כ הזמנות | סה"כ יחידות | ממוצע שורות להזמנה | לקוחות פעילים | אחוז לוקרים |
   ימי פעילות. Numbers with thousands separators (he-IL), percentages with 1 decimal.

3. Charts (Chart.js, RTL-friendly, same color palette everywhere)
   - Orders by carrier: horizontal bar, sorted desc, carriers under 1% grouped as "אחר"
     (tooltip lists which ones), labels show count + %.
   - Orders by ship type: doughnut. Map known codes to Hebrew: ND → "משלוח עד הבית",
     LOCKER → "לוקר"; unknown codes shown as-is.
   - Top 5 clients: horizontal bar with share %, plus a line "5 הלקוחות המובילים = X%".
   - Daily volume: line/bar by ship date for the selected month; highlight the peak day.

4. Exceptions table
   - Orders whose status is not a delivered status (anything not containing "DELIVERED"),
     grouped by status × carrier with counts. Show "אין חריגות 🎉" when empty.

5. Automatic insights (3–5 short Hebrew sentences, rule-based, no AI API)
   Examples of rules: carrier share leader; client concentration (top 2 share > 50% →
   warning tone); peak day vs daily average; locker share; exceptions count and the
   carrier with most exceptions. Each insight has a tone (info / warn / good) with a
   matching colored border. Numbers inside sentences come from the metrics object.

6. Layout & polish
   - Responsive grid: KPIs 6→3→2 columns, charts 2 per row on desktop, 1 on mobile.
   - Card style consistent with Phase 0 tokens; chart titles in Hebrew; empty states.
   - Performance: 70k rows must switch months in under 1 second.

7. Tests
   - Add to tests/tests.html: `aggregate` on a tiny fixture with known totals,
     partial-month detection, "אחר" grouping, and insights not crashing when optional
     fields are missing (use test-data/missing-required.csv after mapping).

Expected values for my real file, June 2026 (use these to self-check, do not hard-code):
orders 13,335 · units 48,509 · avg lines 2.87 · active clients 25 · locker 17.2% ·
active days 23 · carriers CARGO 5,554 / BUZZ 3,524 / KATZ 2,826 / DUMMYDC 1,426 /
other 5 · top client PR922 5,749 · non-delivered orders 37.
Default month should be June 2026 (July ends on the 28th → partial).

Start in Plan mode: show me the plan, the metrics object shape and the file changes
before writing code.
