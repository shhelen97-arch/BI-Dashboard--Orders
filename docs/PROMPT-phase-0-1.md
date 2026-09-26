Read PLAN.md in this folder. It is the source of truth for this project.

Implement **Phase 0 and Phase 1 only**. Do not build the dashboard charts yet.

Context: I am a system analyst at a robotic B2C logistics center. Every month I export
"Shipped Orders" from our WMS to Excel. The tool must be a static web page (index.html,
app.js, styles.css), Hebrew RTL UI, no server, no network calls except loading SheetJS
and Chart.js from cdn.jsdelivr.net. The data must never leave the browser.

Phase 0:
- Folder structure, RTL layout, Hebrew Google Font (Heebo), CSS color tokens,
  a clean header ("תמונת מצב הזמנות") and a large, friendly drop zone.

Phase 1:
1. Drag & drop + "בחר קובץ" button for .xlsx / .xls / .csv.
2. Parse with SheetJS (cellDates: true). Use the first sheet that has data.
   Detect the header row even if there are title rows above it.
3. Write `detectColumns(headers, sampleRows)` exactly as described in the
   "Canonical Fields & Auto-Detection" table in PLAN.md:
   - normalize headers (lowercase, trim, remove spaces/underscores/hyphens)
   - match EN + HE synonyms first, then value-based fallback
   - return field → { column, confidence: high | medium | low }
   - never assign the same column to two fields
4. Write a robust `parseDate` (Date object, Excel serial number, ISO string, dd/mm/yyyy).
5. Mapping panel: if a required field (orderId, shipDate, carrier, client) is missing
   or low confidence, show dropdowns in Hebrew so I can pick the column, then
   "המשך". If all is confident, show a collapsible "זוהו X עמודות ✓" summary
   that can still be edited.
6. After mapping, normalize to canonical rows and show a temporary summary:
   row count, date range, months found (with row count per month), distinct carriers.
7. Friendly Hebrew error messages for: non-Excel file, empty sheet, no usable columns.
8. Never display the "Ship To" (recipient name) column anywhere.

Testing: I will test with my real export (headers: Client Code, Order Number, Ship To,
Ship Date, Ship Time, Carrier, Total Lines, Total Packages, Total Eaches, Ship To City,
Carrier Mode, Order Status). Also create a small `test-data/renamed-headers.csv`
(20 fake rows, headers in Hebrew / different English names, fake names only) to prove
detection works on a different format.

Start in Plan mode: show me your plan and file list before writing code.
