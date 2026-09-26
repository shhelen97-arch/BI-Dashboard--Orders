# Project: Orders Snapshot — Drag an Excel, Get a Dashboard

## Overview
A single-page web tool for a robotic B2C logistics center. The analyst drags in the
monthly "Shipped Orders" Excel export and instantly gets a polished Hebrew (RTL)
management dashboard: KPIs, charts and auto-written insights for managers and the CEO.
Everything runs in the browser — the file never leaves the computer.

## Tech Stack
- Frontend: one `index.html` + `app.js` + `styles.css` (vanilla JS, no build step)
- Excel parsing: SheetJS (`xlsx`) from cdn.jsdelivr.net
- Charts: Chart.js from cdn.jsdelivr.net
- Backend / Database / Auth: none (100% client-side, privacy by design)
- Hosting: open locally, optionally GitHub Pages / Vercel (code only, never data)

## Architecture
```
File drop → SheetJS parse → Column detector → Mapping panel (user can fix)
         → Normalizer (canonical rows) → Aggregator → Dashboard renderer
                                                   → Insights generator
```
- `detectColumns(headers, sampleRows)` returns `{field: {column, confidence}}`
- All charts and KPIs read only canonical fields, never raw header names
- Recipient names (`Ship To`) are never displayed (personal data)

## Canonical Fields & Auto-Detection
Detection = header synonyms (EN + HE, case/space/underscore-insensitive) first,
then value-based fallback. Sample file headers shown in **bold**.

| Field | Required | Synonyms (examples) | Value fallback |
|---|---|---|---|
| orderId | yes | **Order Number**, order no, מספר הזמנה | ~unique per row |
| shipDate | yes | **Ship Date**, date, תאריך משלוח | parses as date (Excel serial / ISO / dd/mm/yyyy) |
| carrier | yes | **Carrier**, courier, מוביל, חברת שילוח | text, 2–20 distinct values |
| client | yes | **Client Code**, customer, לקוח | text/number, 5–200 distinct |
| shipType | no | **Carrier Mode**, shipment type, delivery type, סוג משלוח | 2–6 distinct values |
| status | no | **Order Status**, status, סטטוס | values like DELIVERED/SHIPPED |
| city | no | **Ship To City**, city, עיר | many distinct Hebrew text values |
| lines / packages / units | no | **Total Lines**, **Total Packages**, **Total Eaches**, qty, יחידות | numeric |
| shipTime | no | **Ship Time**, time, שעה | HH:MM(:SS) |

- Confidence: exact synonym = high, partial = medium, value-only = low
- If any required field is missing or low-confidence → show mapping panel with
  dropdowns before rendering; otherwise show a collapsible "זוהו העמודות" summary

## Known Data Facts (sample file, 71,106 rows)
- File spans **several months** (Jan–Jul 2026) → month selector is needed;
  default = latest *complete* month (last month may be partial)
- Carriers: CARGO, BUZZ, KATZ, DUMMYDC dominate; tiny ones (LPHARM, GB, EGOLD) → "Other"
- Ship type: ND (home delivery) vs LOCKER — show Hebrew labels, keep raw code in tooltip
- Top 2 clients ≈ 67% of volume → concentration insight is valuable
- Status is ~98% DVS_DELIVERED; non-delivered statuses are the interesting exceptions

## Development Phases

### Phase 0: Setup & Skeleton
**Objective:** Empty but styled RTL page that loads the libraries.
**Features:** folder structure, `lang="he" dir="rtl"`, Hebrew font (Heebo/Assistant),
color tokens, header, empty drop zone.
**Acceptance:** page opens from file system with no console errors.

### Phase 1: Upload + Column Detection + Mapping
**Objective:** Any reasonable orders export is read and mapped to canonical fields.
**Features:** drag & drop + file picker (.xlsx/.xls/.csv), first sheet with data,
header-row detection (skip title rows), `detectColumns`, mapping panel, date parsing,
friendly Hebrew errors (wrong file, empty file, missing required field).
**Acceptance:** sample file maps all 12 columns automatically; renaming headers
(e.g. "Carrier" → "מוביל", "Ship Date" → "Date") still maps; removing a required
column opens the mapping panel.

### Phase 2: Dashboard
**Objective:** One-screen management view for the selected month.
**Features:** month selector; KPI cards (orders, units, avg lines/order, active
clients, locker share); charts: orders by carrier, by ship type, top 5 clients,
daily volume trend; non-delivered status table; 3–5 Hebrew insight sentences.
**Acceptance:** numbers match a pivot table in Excel for the same month.

### Phase 3: Month-over-Month & Export
**Objective:** Compare to the previous month and share with management.
**Features:** Δ% on every KPI (green/red arrows), prev-month bars in carrier chart,
MoM insights; also supports uploading a second file; print-to-PDF stylesheet.
**Acceptance:** Δ values correct; printed A4 page is clean and readable.

### Phase 4: Polish & Delivery
**Objective:** Course-ready and daily-use ready.
**Features:** loading state for large files, mobile layout, empty states, README
with screenshot, optional deploy.
**Acceptance:** 70k-row file renders in < 3 s; tested on 2 different monthly files.

## Risks & Mitigations
- Header names change between exports: synonym list + value fallback + manual mapping
- Dates arrive as Excel serial numbers or text: single robust `parseDate` with tests
- Partial months skew comparisons: flag "חודש חלקי" when days covered < month length
- Personal data (recipient names): never rendered, never stored, no network calls
- Large files freeze UI: parse once, aggregate with plain loops, show spinner
