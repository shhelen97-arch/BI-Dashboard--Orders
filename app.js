/* =====================================================================
   Orders Snapshot — Phases 0–2
   Upload → parse (SheetJS) → detect columns → mapping panel → normalize
   → month filter → aggregate (pure) → insights (pure) → dashboard render
   100% client-side. No fetch / XHR / storage. The recipient-name column
   ("Ship To") is excluded at detection time and never copied or rendered.
   ===================================================================== */
'use strict';

/* ---------------------------------------------------------------------
   1. Canonical fields (mirrors "Canonical Fields & Auto-Detection" in PLAN.md)
   Synonyms are written already-normalized (see normalizeHeader).
   --------------------------------------------------------------------- */
const FIELDS = [
  { key: 'orderId',  label: 'מספר הזמנה',   required: true,
    synonyms: ['ordernumber', 'orderno', 'ordernum', 'orderid', 'order', 'ordercode',
               'מספרהזמנה', 'מסהזמנה', 'הזמנה', 'קודהזמנה'] },
  { key: 'shipDate', label: 'תאריך משלוח',  required: true,
    synonyms: ['shipdate', 'date', 'shippingdate', 'shippeddate', 'dispatchdate', 'shipmentdate',
               'תאריךמשלוח', 'תאריךשילוח', 'תאריך'] },
  { key: 'carrier',  label: 'מוביל',        required: true,
    synonyms: ['carrier', 'courier', 'carriername', 'carriercode', 'deliverycompany',
               'מוביל', 'חברתשילוח', 'חברתמשלוחים', 'חברתהובלה', 'שליח'] },
  { key: 'client',   label: 'לקוח',         required: true,
    synonyms: ['clientcode', 'client', 'customer', 'customercode', 'clientname', 'clientid',
               'customerid', 'לקוח', 'קודלקוח', 'שםלקוח', 'מספרלקוח'] },
  { key: 'shipType', label: 'סוג משלוח',    required: false,
    synonyms: ['carriermode', 'shipmenttype', 'deliverytype', 'shiptype', 'shippingtype',
               'deliverymethod', 'shippingmethod', 'mode', 'סוגמשלוח', 'סוגמסירה', 'שיטתמשלוח', 'סוגשילוח'] },
  { key: 'status',   label: 'סטטוס',        required: false,
    synonyms: ['orderstatus', 'status', 'shipmentstatus', 'deliverystatus',
               'סטטוס', 'סטטוסהזמנה', 'מצבהזמנה', 'מצב'] },
  { key: 'city',     label: 'עיר',          required: false,
    synonyms: ['shiptocity', 'city', 'destinationcity', 'deliverycity', 'town',
               'עיר', 'ישוב', 'יישוב', 'עירמשלוח', 'עיריעד'] },
  { key: 'lines',    label: 'שורות',        required: false,
    synonyms: ['totallines', 'lines', 'qtylines', 'linecount', 'numlines', 'nooflines',
               'שורות', 'מסשורות', 'כמותשורות', 'סהכשורות'] },
  { key: 'packages', label: 'חבילות',       required: false,
    synonyms: ['totalpackages', 'packages', 'parcels', 'boxes', 'cartons', 'packagecount',
               'חבילות', 'מסחבילות', 'קרטונים', 'סהכחבילות'] },
  { key: 'units',    label: 'יחידות',       required: false,
    synonyms: ['totaleaches', 'eaches', 'units', 'totalunits', 'qty', 'quantity', 'pieces', 'totalqty',
               'יחידות', 'כמות', 'כמותיחידות', 'סהכיחידות'] },
  { key: 'shipTime', label: 'שעת משלוח',    required: false,
    synonyms: ['shiptime', 'time', 'shippingtime', 'dispatchtime', 'שעה', 'שעתמשלוח', 'זמןמשלוח'] },
];
const REQUIRED_KEYS = FIELDS.filter(f => f.required).map(f => f.key);
const FIELD_BY_KEY = Object.fromEntries(FIELDS.map(f => [f.key, f]));

/* Personal-data columns (recipient name). Exact normalized match only, so
   "Ship To City" (shiptocity) is NOT treated as personal data. */
const PII_HEADERS = new Set([
  'shipto', 'shiptoname', 'recipient', 'recipientname', 'consignee', 'consigneename',
  'customername', 'fullname', 'name', 'contactname', 'contact',
  'נמען', 'שםנמען', 'שםהנמען', 'שםמקבל', 'מקבל', 'שם', 'שםמלא', 'איששקשר',
]);

const CONFIDENCE_HE = { high: 'גבוהה', medium: 'בינונית', low: 'נמוכה' };
const MONTHS_HE = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני',
                   'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];

/* ---------------------------------------------------------------------
   2. Small helpers
   --------------------------------------------------------------------- */
function normalizeHeader(h) {
  return String(h == null ? '' : h)
    .toLowerCase()
    .trim()
    .replace(/[\s_\-.'"׳״`’()#:/\\]+/g, '');
}

function isPiiHeader(h) {
  return PII_HEADERS.has(normalizeHeader(h));
}

function isEmpty(v) {
  return v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
}

function toNumber(v) {
  if (typeof v === 'number') return isFinite(v) ? v : null;
  if (isEmpty(v) || v instanceof Date) return null;
  const s = String(v).trim().replace(/,/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  return Number(s);
}

function pad2(n) { return String(n).padStart(2, '0'); }
function formatDate(d) { return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}`; }
function formatInt(n) { return Number(n).toLocaleString('he-IL'); }
function daysInMonth(y, m0) { return new Date(y, m0 + 1, 0).getDate(); }

/* ---------------------------------------------------------------------
   3. parseDate — Date object | Excel serial | ISO | dd/mm/yyyy (day-first)
   Returns a local-time Date or null. Never falls back to new Date(string)
   (that would read 03/04 as March 4, US style).
   --------------------------------------------------------------------- */
function makeDate(y, m, d, hh, mi, ss) {
  y = Number(y); m = Number(m); d = Number(d);
  if (y < 100) y += 2000;
  hh = Number(hh || 0); mi = Number(mi || 0); ss = Number(ss || 0);
  if (m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m - 1)) return null;
  if (hh > 23 || mi > 59 || ss > 59) return null;
  return new Date(y, m - 1, d, hh, mi, ss);
}

function excelSerialToDate(n) {
  if (typeof n !== 'number' || !isFinite(n) || n < 1 || n >= 2958466) return null;
  let days = Math.floor(n);
  const secs = Math.round((n - days) * 86400);
  // Excel's 1900 leap-year bug: serial 60 is the fake 29/02/1900.
  // Serial 1 = 01/01/1900; from serial 61 on, subtract one day.
  let offset = days >= 61 ? days - 1 : days === 60 ? 59 : days;
  const d = new Date(1899, 11, 31 + offset, 0, 0, 0);
  d.setSeconds(secs);
  return d;
}

function parseDate(v) {
  if (isEmpty(v)) return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  if (typeof v === 'number') return excelSerialToDate(v);

  const s = String(v).trim();
  let m;
  // Serial number stored as text ("46023" or "46023.5")
  if (/^\d{4,7}(\.\d+)?$/.test(s)) return excelSerialToDate(parseFloat(s));
  // ISO: yyyy-mm-dd, yyyy/mm/dd, optional time
  m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/);
  if (m) return makeDate(m[1], m[2], m[3], m[4], m[5], m[6]);
  // Day-first: dd/mm/yyyy, dd.mm.yyyy, dd-mm-yyyy, 2-digit years, optional time
  m = s.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2}|\d{4})(?:[\s,T]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (m) return makeDate(m[3], m[2], m[1], m[4], m[5], m[6]);
  return null;
}

/* Time of day from a cell: "14:05", "14:05:33", Excel fraction 0.585, or a Date. */
function parseTime(v) {
  if (isEmpty(v)) return null;
  if (v instanceof Date) return isNaN(v) ? null : `${pad2(v.getHours())}:${pad2(v.getMinutes())}`;
  if (typeof v === 'number') {
    if (v < 0 || v >= 1) return null;
    const mins = Math.round(v * 1440) % 1440;
    return `${pad2(Math.floor(mins / 60))}:${pad2(mins % 60)}`;
  }
  const m = String(v).trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  return `${pad2(m[1])}:${m[2]}`;
}

/* ---------------------------------------------------------------------
   4. SheetJS date drift correction
   SheetJS 0.18.5 with cellDates:true returns dates a few seconds off in
   time zones whose 1899 offset had seconds (Israel: -40 s → midnight
   becomes 23:59:20 of the PREVIOUS day). We measure the drift once by
   round-tripping known serials, then correct every Date read from Excel.
   --------------------------------------------------------------------- */
let _dateDrift = null;
function getSheetJsDrift() {
  if (_dateDrift) return _dateDrift;
  _dateDrift = [];
  try {
    const probes = [[46023, new Date(2026, 0, 1)], [46204, new Date(2026, 6, 1)]]; // winter + summer
    const ws = XLSX.utils.aoa_to_sheet([['d'], [probes[0][0]], [probes[1][0]]]);
    ws.A2.z = 'dd/mm/yyyy'; ws.A3.z = 'dd/mm/yyyy';
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 's');
    const back = XLSX.read(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }), { type: 'array', cellDates: true });
    const rows = XLSX.utils.sheet_to_json(back.Sheets.s, { header: 1, raw: true });
    probes.forEach(([, expected], i) => {
      const got = rows[i + 1][0];
      if (got instanceof Date) _dateDrift.push({ tz: expected.getTimezoneOffset(), ms: got.getTime() - expected.getTime() });
    });
  } catch (e) { console.warn('Date drift calibration skipped', e); }
  return _dateDrift;
}

function correctSheetDate(d) {
  if (!(d instanceof Date) || isNaN(d) || d.getFullYear() < 1901) return d; // time-only cells (1899) are fine
  const drift = getSheetJsDrift();
  if (!drift.length) return d;
  const match = drift.find(x => x.tz === d.getTimezoneOffset()) || drift[0];
  return match.ms ? new Date(d.getTime() - match.ms) : d;
}

/* ---------------------------------------------------------------------
   5. Sheet → table (first sheet with data, header-row detection)
   --------------------------------------------------------------------- */
function rowNonEmptyCount(row) {
  let n = 0;
  for (const c of row || []) if (!isEmpty(c)) n++;
  return n;
}

function isHeaderLikeCell(c) {
  if (typeof c !== 'string') return false;
  const s = c.trim();
  return s !== '' && toNumber(s) === null && parseDate(s) === null;
}

/* Header row = within the first 20 rows, the row with the most text cells that is
   followed by a row with a similar number of filled cells (skips report titles). */
function findHeaderRow(aoa) {
  let best = -1, bestScore = 0;
  const limit = Math.min(aoa.length, 20);
  for (let i = 0; i < limit; i++) {
    const row = aoa[i] || [];
    const textCells = row.filter(isHeaderLikeCell).length;
    if (textCells < 2) continue;
    const filled = rowNonEmptyCount(row);
    let next = null;
    for (let j = i + 1; j < aoa.length && j < i + 5; j++) {
      if (rowNonEmptyCount(aoa[j]) > 0) { next = aoa[j]; break; }
    }
    if (!next || rowNonEmptyCount(next) < Math.max(2, Math.ceil(filled * 0.5))) continue;
    if (textCells > bestScore) { best = i; bestScore = textCells; }
  }
  return best;
}

function buildHeaders(row, width) {
  const seen = new Map();
  const out = [];
  for (let i = 0; i < width; i++) {
    let h = isEmpty(row[i]) ? `עמודה ${i + 1}` : String(row[i]).trim();
    const n = (seen.get(h) || 0) + 1;
    seen.set(h, n);
    if (n > 1) h = `${h} (${n})`;
    out.push(h);
  }
  return out;
}

/* Returns { sheetName, headers, rows } or throws AppError. */
function extractTable(workbook, fromExcel) {
  let sawAnySheet = false;
  for (const name of workbook.SheetNames) {
    const ws = workbook.Sheets[name];
    if (!ws || !ws['!ref']) continue;
    sawAnySheet = true;
    const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '', blankrows: false });
    const nonEmpty = aoa.filter(r => rowNonEmptyCount(r) > 0);
    if (nonEmpty.length < 2) continue;

    const h = findHeaderRow(aoa);
    if (h < 0) continue;
    let width = 0;
    for (let i = h; i < Math.min(aoa.length, h + 50); i++) width = Math.max(width, (aoa[i] || []).length);
    const headers = buildHeaders(aoa[h], width);
    const rows = [];
    for (let i = h + 1; i < aoa.length; i++) {
      const r = aoa[i];
      if (rowNonEmptyCount(r) === 0) continue;
      if (fromExcel) {
        for (let c = 0; c < r.length; c++) if (r[c] instanceof Date) r[c] = correctSheetDate(r[c]);
      }
      rows.push(r);
    }
    if (rows.length === 0) continue;
    return { sheetName: name, headers, rows };
  }
  throw new AppError(sawAnySheet ? 'empty' : 'empty');
}

/* ---------------------------------------------------------------------
   6. detectColumns(headers, sampleRows)
   headers: array of header strings. sampleRows: arrays aligned to headers
   (objects keyed by header are also accepted).
   Returns { field: { column: <header>, confidence: 'high'|'medium'|'low' } }.
   --------------------------------------------------------------------- */
const VALUE_TESTS = {
  orderId(vals, n) {
    if (vals.length < n * 0.9 || vals.length < 3) return false;
    if (vals.some(v => v instanceof Date)) return false;
    return new Set(vals.map(String)).size / vals.length >= 0.95;
  },
  shipDate(vals) {
    if (vals.length < 3) return false;
    const ok = vals.filter(v => {
      if (typeof v === 'number') return v > 20000 && v < 80000;      // plausible serial dates only
      if (v instanceof Date) return v.getFullYear() > 1990;
      return parseDate(v) !== null;
    }).length;
    return ok / vals.length >= 0.8;
  },
  carrier(vals) {
    const text = vals.filter(v => typeof v === 'string' && toNumber(v) === null && parseDate(v) === null);
    if (text.length < vals.length * 0.9 || !text.length) return false;
    const d = new Set(text).size;
    return d >= 2 && d <= 20;
  },
  client(vals) {
    if (vals.some(v => v instanceof Date)) return false;
    const d = new Set(vals.map(String)).size;
    return d >= 5 && d <= 200;
  },
  shipType(vals) {
    const text = vals.filter(v => typeof v === 'string' && toNumber(v) === null);
    if (text.length < vals.length * 0.9 || !text.length) return false;
    const d = new Set(text).size;
    return d >= 2 && d <= 6;
  },
  status(vals) {
    if (!vals.length) return false;
    const hits = vals.filter(v => /deliver|ship|cancel|return|dvs_|נמסר|נשלח|בוטל/i.test(String(v))).length;
    return hits / vals.length >= 0.5;
  },
  city(vals) {
    const heb = vals.filter(v => typeof v === 'string' && /[֐-׿]/.test(v) && toNumber(v) === null);
    if (heb.length < vals.length * 0.8 || !heb.length) return false;
    return new Set(heb).size >= Math.min(20, Math.max(5, Math.ceil(heb.length * 0.3)));
  },
  shipTime(vals) {
    if (!vals.length) return false;
    const ok = vals.filter(v =>
      (v instanceof Date && v.getFullYear() < 1901) ||
      (typeof v === 'number' && v >= 0 && v < 1) ||
      (typeof v === 'string' && parseTime(v) !== null)).length;
    return ok / vals.length >= 0.8;
  },
};
function numericTest(vals) {
  if (!vals.length) return false;
  const nums = vals.map(toNumber).filter(x => x !== null && x >= 0 && Number.isInteger(x));
  return nums.length / vals.length >= 0.9;
}
VALUE_TESTS.lines = numericTest;
VALUE_TESTS.packages = numericTest;
VALUE_TESTS.units = numericTest;

const LEVEL = { high: 3, medium: 2, low: 1 };

function detectColumns(headers, sampleRows) {
  sampleRows = sampleRows || [];
  const getCell = (row, i) => Array.isArray(row) ? row[i] : (row ? row[headers[i]] : undefined);
  const normHeaders = headers.map(normalizeHeader);
  const candidates = [];

  headers.forEach((h, ci) => {
    if (isPiiHeader(h)) return;                              // never a candidate
    const nh = normHeaders[ci];
    let colValues = null;                                    // lazily computed
    const values = () => colValues || (colValues =
      sampleRows.map(r => getCell(r, ci)).filter(v => !isEmpty(v)));

    FIELDS.forEach((f, fi) => {
      let level = 0, synLen = 0;
      if (nh && f.synonyms.includes(nh)) {
        level = LEVEL.high;
      } else if (nh) {
        for (const syn of f.synonyms) {
          if (syn.length >= 3 && nh.includes(syn) && syn.length > synLen) { level = LEVEL.medium; synLen = syn.length; }
        }
      }
      if (!level && VALUE_TESTS[f.key] && values().length && VALUE_TESTS[f.key](values(), sampleRows.length)) {
        level = LEVEL.low;
      }
      if (level) candidates.push({ field: f.key, fi, ci, level, synLen, required: f.required });
    });
  });

  // Greedy: strongest evidence first; required fields win ties; longer synonym wins
  // among partial matches; then field order, then column order.
  candidates.sort((a, b) =>
    b.level - a.level ||
    (b.required - a.required) ||
    b.synLen - a.synLen ||
    a.fi - b.fi ||
    a.ci - b.ci);

  const result = {};
  const usedCols = new Set();
  for (const c of candidates) {
    if (result[c.field] || usedCols.has(c.ci)) continue;     // one column → one field
    result[c.field] = { column: headers[c.ci], confidence: c.level === 3 ? 'high' : c.level === 2 ? 'medium' : 'low' };
    usedCols.add(c.ci);
  }
  return result;
}

function needsMappingAttention(detected) {
  return REQUIRED_KEYS.some(k => !detected[k] || detected[k].confidence === 'low');
}

/* ---------------------------------------------------------------------
   7. Normalizer → canonical rows (Ship To is never read)
   mapping: { field: columnIndex } (−1 / undefined = not mapped)
   --------------------------------------------------------------------- */
function normalizeRows(rows, mapping) {
  const idx = k => (mapping[k] === undefined || mapping[k] === null ? -1 : mapping[k]);
  const I = Object.fromEntries(FIELDS.map(f => [f.key, idx(f.key)]));
  const text = (r, i) => (i < 0 || isEmpty(r[i]) ? '' : String(r[i]).trim());
  const num = (r, i) => (i < 0 ? null : toNumber(r[i]));
  const out = [];
  let skipped = 0, badDates = 0;

  for (const r of rows) {
    const orderId = text(r, I.orderId);
    const shipDate = I.shipDate < 0 ? null : parseDate(r[I.shipDate]);
    if (!shipDate) badDates++;
    if (!orderId || !shipDate) { skipped++; continue; }
    const y = shipDate.getFullYear(), mm = pad2(shipDate.getMonth() + 1);
    out.push({
      orderId,
      shipDate,
      ym: `${y}-${mm}`,                                     // month key, precomputed for fast filtering
      day: `${y}-${mm}-${pad2(shipDate.getDate())}`,        // calendar-day key
      carrier: text(r, I.carrier),
      client: text(r, I.client),
      shipType: text(r, I.shipType),
      status: text(r, I.status),
      city: text(r, I.city),
      lines: num(r, I.lines),
      packages: num(r, I.packages),
      units: num(r, I.units),
      shipTime: I.shipTime < 0 ? null : parseTime(r[I.shipTime]),
    });
  }
  return { rows: out, skipped, badDates };
}

/* ---------------------------------------------------------------------
   7b. Months, filtering, aggregation, insights — PURE (no DOM access)
   --------------------------------------------------------------------- */
const SHIP_TYPE_HE = { ND: 'משלוח עד הבית', LOCKER: 'לוקר' };
const OTHER_THRESHOLD = 0.01;                                // carriers under 1% → "אחר"

function shipTypeLabel(code) {
  const c = String(code || '').trim();
  return SHIP_TYPE_HE[c.toUpperCase()] || c || '(ללא)';
}
function isDelivered(status) { return /DELIVERED/i.test(String(status || '')); }
function isLocker(shipType) { return /LOCKER/i.test(String(shipType || '')); }

/* A month is partial when its last ship date is more than 2 days before month end
   (weekend tolerance) or its first ship date is after day 3. */
function isPartialMonth(y, m0, firstDay, lastDay) {
  return lastDay < daysInMonth(y, m0) - 2 || firstDay > 3;
}

/* [{ ym, y, m, label, orders, rows, firstDay, lastDay, partial }] sorted ascending */
function monthStats(rows) {
  const map = new Map();
  for (const r of rows) {
    let mo = map.get(r.ym);
    if (!mo) {
      const y = r.shipDate.getFullYear(), m = r.shipDate.getMonth();
      map.set(r.ym, mo = { ym: r.ym, y, m, rows: 0, ids: new Set(), firstDay: 32, lastDay: 0 });
    }
    mo.rows++;
    mo.ids.add(r.orderId);
    const d = r.shipDate.getDate();
    if (d < mo.firstDay) mo.firstDay = d;
    if (d > mo.lastDay) mo.lastDay = d;
  }
  return [...map.values()].sort((a, b) => a.ym.localeCompare(b.ym)).map(mo => ({
    ym: mo.ym, y: mo.y, m: mo.m, label: `${MONTHS_HE[mo.m]} ${mo.y}`,
    orders: mo.ids.size, rows: mo.rows, firstDay: mo.firstDay, lastDay: mo.lastDay,
    partial: isPartialMonth(mo.y, mo.m, mo.firstDay, mo.lastDay),
  }));
}

/* Latest complete month; if every month is partial, the latest month. */
function pickDefaultMonth(months) {
  if (!months.length) return null;
  for (let i = months.length - 1; i >= 0; i--) if (!months[i].partial) return months[i].ym;
  return months[months.length - 1].ym;
}

function filterByMonth(rows, ym) {
  return rows.filter(r => r.ym === ym);
}

function countMapToSorted(map, total) {
  return [...map.entries()]
    .map(([name, orders]) => ({ name, orders, share: total ? orders / total : 0 }))
    .sort((a, b) => b.orders - a.orders || String(a.name).localeCompare(String(b.name)));
}

/* aggregate(rows, ym?) → plain metrics object. One pass over rows.
   Orders = distinct orderId; order-level attributes come from the order's first row;
   units / lines are summed over all rows. `ym` (optional) fills every calendar day. */
function aggregate(rows, ym) {
  const seen = new Set();
  const carriers = new Map(), clients = new Map(), types = new Map(), days = new Map();
  const exc = new Map(), excByCarrier = new Map(), excByStatus = new Map();
  let units = 0, lines = 0, hasUnits = false, hasLines = false;
  let hasShipType = false, hasStatus = false, typed = 0, lockers = 0;

  for (const r of rows) {
    if (r.units !== null && r.units !== undefined) { units += r.units; hasUnits = true; }
    if (r.lines !== null && r.lines !== undefined) { lines += r.lines; hasLines = true; }
    if (seen.has(r.orderId)) continue;
    seen.add(r.orderId);

    const carrier = r.carrier || '(ללא מוביל)';
    carriers.set(carrier, (carriers.get(carrier) || 0) + 1);
    const client = r.client || '(ללא לקוח)';
    clients.set(client, (clients.get(client) || 0) + 1);
    days.set(r.day, (days.get(r.day) || 0) + 1);

    if (r.shipType) {
      hasShipType = true; typed++;
      const code = r.shipType.toUpperCase();
      types.set(code, (types.get(code) || 0) + 1);
      if (isLocker(code)) lockers++;
    }
    if (r.status) {
      hasStatus = true;
      if (!isDelivered(r.status)) {
        const k = `${r.status}\u0000${carrier}`;
        exc.set(k, (exc.get(k) || 0) + 1);
        excByCarrier.set(carrier, (excByCarrier.get(carrier) || 0) + 1);
        excByStatus.set(r.status, (excByStatus.get(r.status) || 0) + 1);
      }
    }
  }

  const orders = seen.size;

  // Carriers: ≥1% listed, the rest folded into "אחר"
  const allCarriers = countMapToSorted(carriers, orders);
  const main = allCarriers.filter(c => c.share >= OTHER_THRESHOLD);
  const small = allCarriers.filter(c => c.share < OTHER_THRESHOLD);
  const otherOrders = small.reduce((s, c) => s + c.orders, 0);

  // Clients
  const allClients = countMapToSorted(clients, orders);
  const top5 = allClients.slice(0, 5);
  const shareOf = list => list.reduce((s, c) => s + c.share, 0);

  // Daily series: every calendar day of the month (0 when no shipments)
  let dayKeys;
  if (ym && /^\d{4}-\d{2}$/.test(ym)) {
    const [y, m] = ym.split('-').map(Number);
    dayKeys = Array.from({ length: daysInMonth(y, m - 1) }, (_, i) => `${ym}-${pad2(i + 1)}`);
  } else {
    dayKeys = [...days.keys()].sort();
  }
  const daily = dayKeys.map(date => ({ date, orders: days.get(date) || 0 }));
  let peak = null;
  for (const d of daily) if (!peak || d.orders > peak.orders) peak = d;
  const activeDays = days.size;

  // Exceptions (non-delivered, non-empty status)
  let exceptions = null;
  if (hasStatus) {
    const total = [...excByCarrier.values()].reduce((s, n) => s + n, 0);
    const byCarrier = countMapToSorted(excByCarrier, total);
    exceptions = {
      total,
      rate: orders ? total / orders : 0,
      rows: [...exc.entries()].map(([k, n]) => {
        const [status, carrier] = k.split('\u0000');
        return { status, carrier, orders: n };
      }).sort((a, b) => b.orders - a.orders || a.status.localeCompare(b.status)),
      byStatus: countMapToSorted(excByStatus, total),
      byCarrier,
      topCarrier: byCarrier[0] || null,
    };
  }

  return {
    orders,
    rows: rows.length,
    units: hasUnits ? units : null,
    lines: hasLines ? lines : null,
    avgLinesPerOrder: hasLines && orders ? lines / orders : null,
    avgUnitsPerOrder: hasUnits && orders ? units / orders : null,
    activeClients: clients.size,
    activeDays,
    lockerShare: hasShipType && typed ? lockers / typed : null,
    lockerOrders: hasShipType ? lockers : null,
    hasShipType, hasStatus, hasUnits, hasLines,
    carriers: {
      items: main,
      other: small.length ? { orders: otherOrders, share: orders ? otherOrders / orders : 0, members: small } : null,
      leader: allCarriers[0] || null,
      count: allCarriers.length,
    },
    shipTypes: hasShipType
      ? countMapToSorted(types, typed).map(t => ({ code: t.name, label: shipTypeLabel(t.name), orders: t.orders, share: t.share }))
      : null,
    topClients: {
      items: top5,
      top5Share: shareOf(top5),
      top2Share: shareOf(allClients.slice(0, 2)),
    },
    daily: {
      days: daily,
      peak,
      avgPerActiveDay: activeDays ? orders / activeDays : 0,
    },
    exceptions,
  };
}

/* ---- formatting shared by insights and render (pure) ---- */
const NF0 = new Intl.NumberFormat('he-IL', { maximumFractionDigits: 0 });
const NF2 = new Intl.NumberFormat('he-IL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function fmtInt(n) { return NF0.format(n); }
function fmtDec(n) { return NF2.format(n); }
function fmtPct(x) { return x > 0 && x < 0.0005 ? '<0.1%' : `${(x * 100).toFixed(1)}%`; }
/* Bidi isolate: keeps Latin names (KATZ, PR922) from swallowing the numbers next to them in RTL text. */
function iso(s) { return `\u2068${s}\u2069`; }
function fmtDayKey(key) { const [, m, d] = key.split('-'); return `${d}/${m}`; }

/* buildInsights(metrics) → [{ tone: 'info'|'warn'|'good', text }]  (3–5 items, rule-based) */
function buildInsights(m) {
  const out = [];
  if (!m || !m.orders) return out;

  // 1. Carrier leader
  const cs = m.carriers.items;
  if (m.carriers.leader) {
    const lead = m.carriers.leader;
    let t = `${iso(lead.name)} הוביל עם ${fmtPct(lead.share)} מההזמנות (${fmtInt(lead.orders)})`;
    if (cs[1]) t += `, ואחריו ${iso(cs[1].name)} עם ${fmtPct(cs[1].share)}`;
    out.push({ tone: 'info', text: t + '.' });
  }

  // 2. Client concentration
  if (m.activeClients >= 2) {
    const t2 = m.topClients.top2Share, t5 = m.topClients.top5Share;
    if (t2 > 0.5) {
      out.push({ tone: 'warn', text: `2 הלקוחות הגדולים אחראים ל-${fmtPct(t2)} מההזמנות (5 המובילים: ${fmtPct(t5)}) — תלות גבוהה במעט לקוחות.` });
    } else {
      out.push({ tone: 'info', text: `5 הלקוחות המובילים אחראים ל-${fmtPct(t5)} מההזמנות, מתוך ${fmtInt(m.activeClients)} לקוחות פעילים.` });
    }
  }

  // 3. Peak day vs daily average
  const p = m.daily.peak, avg = m.daily.avgPerActiveDay;
  if (p && p.orders > 0 && m.activeDays >= 2 && avg > 0) {
    const ratio = p.orders / avg;
    out.push({
      tone: ratio > 1.5 ? 'warn' : 'info',
      text: `יום השיא: ${fmtDayKey(p.date)} עם ${fmtInt(p.orders)} הזמנות — פי ${ratio.toFixed(1)} מהממוצע היומי (${fmtInt(avg)}).`,
    });
  }

  // 4. Locker share
  if (m.lockerShare !== null) {
    out.push({ tone: 'info', text: `${fmtPct(m.lockerShare)} מההזמנות נשלחו ללוקרים (${fmtInt(m.lockerOrders)} הזמנות).` });
  }

  // 5. Exceptions
  const e = m.exceptions;
  if (e) {
    if (e.total === 0) {
      out.push({ tone: 'good', text: 'כל ההזמנות בחודש במצב "נמסר" — אין חריגות.' });
    } else {
      const top = e.topCarrier;
      const concentrated = top && top.share > 0.5;
      let t = `${fmtInt(e.total)} הזמנות אינן במצב "נמסר" (${fmtPct(e.rate)} מההזמנות)`;
      if (top) {
        t += concentrated
          ? `, רובן אצל ${iso(top.name)} — ${fmtInt(top.orders)} מתוך ${fmtInt(e.total)} (${fmtPct(top.share)})`
          : `, הכי הרבה אצל ${iso(top.name)} (${fmtInt(top.orders)})`;
      }
      out.push({ tone: e.rate >= 0.01 || concentrated ? 'warn' : 'info', text: t + '.' });
    }
  }
  return out.slice(0, 5);
}

/* ---------------------------------------------------------------------
   8. Errors (friendly Hebrew)
   --------------------------------------------------------------------- */
const ERRORS = {
  type:      ['סוג קובץ לא נתמך', 'הקובץ "{name}" אינו קובץ Excel או CSV. יש לייצא את הדוח מה-WMS כקובץ ‎.xlsx‎ (או ‎.xls / .csv‎) ולגרור אותו שוב.'],
  unreadable:['לא הצלחנו לקרוא את הקובץ', 'ייתכן שהקובץ פגום או מוגן בסיסמה. פתחו אותו ב-Excel, שמרו מחדש ונסו שוב.'],
  empty:     ['הקובץ ריק', 'לא נמצאו שורות נתונים באף גיליון בקובץ. ודאו שהייצוא מה-WMS כולל הזמנות.'],
  nocolumns: ['לא זוהו עמודות מתאימות', 'לא מצאנו בקובץ עמודות של הזמנות (מספר הזמנה, תאריך משלוח, מוביל, לקוח). ודאו שזה ייצוא "Shipped Orders".'],
  nodates:   ['לא נמצאו תאריכים תקינים', 'בעמודה שנבחרה כ"תאריך משלוח" אין תאריכים שניתן לקרוא. בחרו עמודה אחרת ולחצו "המשך".'],
  nolib:     ['רכיב קריאת האקסל לא נטען', 'בפתיחה הראשונה נדרש חיבור לאינטרנט כדי לטעון את רכיב הקריאה (הנתונים עצמם לא נשלחים). בדקו את החיבור ורעננו את הדף.'],
};
class AppError extends Error {
  constructor(code, vars) { super(code); this.code = code; this.vars = vars || {}; }
}

/* ---------------------------------------------------------------------
   9. File reading
   --------------------------------------------------------------------- */
function fileExt(name) {
  const m = String(name).toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : '';
}

function decodeCsv(buf) {
  let text = new TextDecoder('utf-8').decode(buf);
  if (text.includes('�')) {
    try { text = new TextDecoder('windows-1255').decode(buf); } catch (e) { /* keep utf-8 */ }
  }
  return text.replace(/^﻿/, '');
}

async function readWorkbook(file) {
  const ext = fileExt(file.name);
  if (!['xlsx', 'xls', 'csv'].includes(ext)) throw new AppError('type', { name: file.name });
  if (typeof XLSX === 'undefined') throw new AppError('nolib');
  if (file.size === 0) throw new AppError('empty');
  const buf = await file.arrayBuffer();
  try {
    if (ext === 'csv') {
      // raw:true keeps text as-is so our day-first parseDate decides (SheetJS would read 03/04 as March 4).
      return { wb: XLSX.read(decodeCsv(buf), { type: 'string', raw: true }), fromExcel: false };
    }
    return { wb: XLSX.read(new Uint8Array(buf), { type: 'array', cellDates: true }), fromExcel: true };
  } catch (e) {
    console.error('SheetJS read failed:', e);
    throw new AppError('unreadable');
  }
}

/* ---------------------------------------------------------------------
   10. UI
   --------------------------------------------------------------------- */
const state = { fileName: '', table: null, detected: null, mapping: {}, manual: new Set(),
                canon: null, months: [], ym: null, metrics: null, skipped: 0 };
const $ = id => document.getElementById(id);
function el(tag, attrs, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') n.className = v; else if (k === 'text') n.textContent = v; else n.setAttribute(k, v);
  }
  for (const c of children) if (c != null) n.append(c);
  return n;
}

function showError(code, vars) {
  const [title, text] = ERRORS[code] || ERRORS.unreadable;
  $('errorTitle').textContent = title;
  $('errorText').textContent = text.replace('{name}', (vars && vars.name) || '');
  $('errorBox').hidden = false;
}
function hideError() { $('errorBox').hidden = true; }
function setLoading(on, text) {
  $('loading').hidden = !on;
  if (text) $('loadingText').textContent = text;
}

function resetUI() {
  destroyCharts();
  state.fileName = ''; state.table = null; state.detected = null; state.mapping = {}; state.manual = new Set();
  state.canon = null; state.months = []; state.ym = null; state.metrics = null;
  $('fileInput').value = '';
  $('dropZone').hidden = false;
  $('resetBtn').hidden = true;
  $('fileInfo').hidden = true;
  $('mappingSection').hidden = true;
  $('dashboard').hidden = true;
  hideError();
}

async function handleFile(file) {
  if (!file) return;
  hideError();
  $('mappingSection').hidden = true;
  $('dashboard').hidden = true;
  setLoading(true, `קורא את הקובץ ${file.name}…`);
  await new Promise(r => setTimeout(r, 30));               // let the spinner paint
  try {
    const { wb, fromExcel } = await readWorkbook(file);
    const table = extractTable(wb, fromExcel);
    const sample = table.rows.slice(0, 500);
    const detected = detectColumns(table.headers, sample);
    // "No usable columns": nothing matched by header name and no column even looks like a date.
    const anyByName = Object.values(detected).some(d => d.confidence !== 'low');
    if (!anyByName && !detected.shipDate) throw new AppError('nocolumns');

    state.fileName = file.name;
    state.table = table;
    state.detected = detected;
    state.manual = new Set();
    state.mapping = {};
    FIELDS.forEach(f => {
      state.mapping[f.key] = detected[f.key] ? table.headers.indexOf(detected[f.key].column) : -1;
    });

    $('dropZone').hidden = true;
    $('resetBtn').hidden = false;
    $('fileInfo').hidden = false;
    $('fileInfo').replaceChildren(
      'קובץ: ', el('b', { text: file.name }),
      ` · גיליון: ${table.sheetName} · ${formatInt(table.rows.length)} שורות נתונים`);

    const attention = needsMappingAttention(detected);
    renderMapping(attention);
    if (!attention) applyMapping();
  } catch (e) {
    if (e instanceof AppError) showError(e.code, e.vars);
    else { console.error(e); showError('unreadable'); }
  } finally {
    setLoading(false);
  }
}

function renderMapping(attention) {
  const { headers } = state.table;
  const grid = $('mappingGrid');
  grid.replaceChildren();

  FIELDS.forEach(f => {
    const id = `map-${f.key}`;
    const select = el('select', { id, 'data-field': f.key });
    select.append(el('option', { value: '-1', text: f.required ? '— בחרו עמודה —' : '— ללא —' }));
    headers.forEach((h, i) => {
      if (isPiiHeader(h)) return;                          // personal data never offered
      select.append(el('option', { value: String(i), text: h }));
    });
    select.value = String(state.mapping[f.key]);
    select.addEventListener('change', () => {
      state.mapping[f.key] = Number(select.value);
      state.manual.add(f.key);
      updateMappingState();
    });
    const row = el('div', { class: 'map-row', 'data-field': f.key },
      el('label', { for: id }, f.label, f.required ? el('span', { class: 'req', text: '*' }) : null),
      el('span', { class: 'badge' }),
      select);
    grid.append(row);
  });

  const piiHidden = headers.some(isPiiHeader);
  $('mappingIntro').textContent = attention
    ? 'לא הצלחנו לזהות בוודאות את כל העמודות הנדרשות. בחרו לכל שדה את העמודה המתאימה בקובץ ולחצו "המשך". שדות עם * הם חובה.'
    : 'אפשר לשנות כל שיוך ולחצו "עדכן".';
  if (piiHidden) $('mappingIntro').textContent += ' עמודת שם הנמען הוסתרה (מידע אישי) ואינה בשימוש.';

  $('mappingContinue').textContent = attention ? 'המשך' : 'עדכן';
  $('mappingDetails').open = attention;
  $('mappingSection').hidden = false;
  updateMappingState();
}

function currentMappingIssues() {
  const missing = REQUIRED_KEYS.filter(k => !(state.mapping[k] >= 0));
  const byCol = new Map();
  FIELDS.forEach(f => {
    const c = state.mapping[f.key];
    if (c >= 0) byCol.set(c, [...(byCol.get(c) || []), f.label]);
  });
  const dupes = [...byCol.entries()].filter(([, labels]) => labels.length > 1);
  return { missing, dupes };
}

function updateMappingState() {
  const { headers } = state.table;
  FIELDS.forEach(f => {
    const row = $('mappingGrid').querySelector(`.map-row[data-field="${f.key}"]`);
    const badge = row.querySelector('.badge');
    const col = state.mapping[f.key];
    let cls, txt;
    if (!(col >= 0)) { cls = 'badge-none'; txt = f.required ? 'חסר' : 'לא משויך'; }
    else if (state.manual.has(f.key)) { cls = 'badge-manual'; txt = 'נבחר ידנית'; }
    else {
      const conf = (state.detected[f.key] || {}).confidence || 'low';
      cls = `badge-${conf}`; txt = `ודאות ${CONFIDENCE_HE[conf]}`;
    }
    badge.className = `badge ${cls}`;
    badge.textContent = txt;
    const lowReq = f.required && (!(col >= 0) || (!state.manual.has(f.key) && (state.detected[f.key] || {}).confidence === 'low'));
    row.classList.toggle('is-missing', lowReq);
  });

  const { missing, dupes } = currentMappingIssues();
  const errEl = $('mappingError');
  if (dupes.length) {
    errEl.textContent = `אותה עמודה נבחרה ליותר משדה אחד: ${dupes.map(([c, l]) => `"${headers[c]}" (${l.join(', ')})`).join('; ')}`;
    errEl.hidden = false;
  } else if (missing.length) {
    errEl.textContent = `יש לבחור עמודה עבור: ${missing.map(k => FIELD_BY_KEY[k].label).join(', ')}`;
    errEl.hidden = false;
  } else {
    errEl.hidden = true;
  }
  $('mappingContinue').disabled = missing.length > 0 || dupes.length > 0;

  const mappedCount = FIELDS.filter(f => state.mapping[f.key] >= 0).length;
  const summary = $('mappingSummary');
  const attention = !$('dashboard').hidden ? false : needsMappingAttentionNow();
  summary.className = attention ? 'summary-warn' : 'summary-ok';
  summary.textContent = attention ? '⚠ נדרשת התאמת עמודות' : `זוהו ${mappedCount} עמודות ✓`;
}

function needsMappingAttentionNow() {
  return REQUIRED_KEYS.some(k => !(state.mapping[k] >= 0) ||
    (!state.manual.has(k) && (state.detected[k] || {}).confidence === 'low'));
}

function applyMapping() {
  const { missing, dupes } = currentMappingIssues();
  if (missing.length || dupes.length) return;
  hideError();
  const result = normalizeRows(state.table.rows, state.mapping);
  if (result.rows.length === 0) {
    showError(result.badDates >= state.table.rows.length ? 'nodates' : 'nocolumns');
    $('mappingDetails').open = true;
    $('dashboard').hidden = true;
    return;
  }
  state.canon = result.rows;
  state.skipped = result.skipped;
  state.months = monthStats(result.rows);
  state.ym = pickDefaultMonth(state.months);
  $('dashboard').hidden = false;
  renderMonthSelect();
  renderDashboard();
  updateMappingState();
  $('mappingDetails').open = false;
}

/* ---------------------------------------------------------------------
   11. Dashboard rendering — these functions only draw; all numbers come
   from the metrics object produced by aggregate().
   --------------------------------------------------------------------- */
const PALETTE = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'];
const OTHER_COLOR = '#a3adbd';
const INK = '#1a2233', MUTED = '#5d6b82', GRID = '#eef1f5';
const WEEKDAYS_HE = ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳'];
const charts = {};

function destroyCharts() {
  for (const k of Object.keys(charts)) { charts[k].destroy(); delete charts[k]; }
}

let _chartDefaultsSet = false;
function chartReady() {
  if (typeof Chart === 'undefined') return false;
  if (!_chartDefaultsSet) {
    Chart.defaults.font.family = "'Heebo', 'Segoe UI', Arial, sans-serif";
    Chart.defaults.font.size = 12;
    Chart.defaults.color = MUTED;
    Chart.defaults.animation = false;
    Chart.defaults.maintainAspectRatio = false;
    Chart.defaults.plugins.tooltip.rtl = true;
    Chart.defaults.plugins.tooltip.textDirection = 'rtl';
    Chart.defaults.plugins.tooltip.backgroundColor = 'rgba(26,34,51,.92)';
    Chart.defaults.plugins.tooltip.padding = 10;
    Chart.defaults.plugins.legend.rtl = true;
    Chart.defaults.plugins.legend.labels.boxWidth = 12;
    Chart.defaults.plugins.legend.labels.boxHeight = 12;
    _chartDefaultsSet = true;
  }
  return true;
}

/* Chart card helper: shows the canvas or a Hebrew empty-state message. */
function chartCard(id, hasData, emptyText) {
  const card = $(id);
  const box = card.querySelector('.chart-box');
  const empty = card.querySelector('.chart-empty');
  const ok = hasData && chartReady();
  box.hidden = !ok;
  empty.hidden = ok;
  if (!ok) empty.textContent = !hasData ? (emptyText || 'אין נתונים לחודש זה') : 'רכיב הגרפים לא נטען — בדקו חיבור לאינטרנט ורעננו.';
  return ok ? card.querySelector('canvas') : null;
}

/* Draws "count · share" at the end of each horizontal bar (no extra plugin library). */
function barEndLabels(textFor) {
  return {
    id: 'barEndLabels',
    afterDatasetsDraw(chart) {
      const { ctx } = chart;
      ctx.save();
      ctx.direction = 'ltr';
      ctx.font = `600 12px ${Chart.defaults.font.family}`;
      ctx.fillStyle = INK;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'right';
      chart.getDatasetMeta(0).data.forEach((bar, i) => {
        const t = textFor(i);
        if (t) ctx.fillText(t, bar.x - 6, bar.y);
      });
      ctx.restore();
    },
  };
}

function horizontalBarOptions(tooltipLabel, tooltipAfter) {
  return {
    indexAxis: 'y',
    layout: { padding: { left: 118, right: 4, top: 4, bottom: 4 } },
    scales: {
      x: { reverse: true, beginAtZero: true, display: false, grace: '2%' },
      y: { position: 'right', grid: { display: false }, border: { display: false },
           ticks: { color: INK, font: { weight: 600 } } },
    },
    plugins: {
      legend: { display: false },
      tooltip: { callbacks: { label: tooltipLabel, afterBody: tooltipAfter } },
    },
    datasets: { bar: { borderRadius: 4, borderSkipped: false, maxBarThickness: 30, barPercentage: 0.75 } },
  };
}

function renderMonthSelect() {
  const sel = $('monthSelect');
  sel.replaceChildren(...state.months.map(mo => el('option', {
    value: mo.ym,
    text: `${mo.label} · ${fmtInt(mo.orders)} הזמנות${mo.partial ? ' (חלקי)' : ''}`,
  })));
  sel.value = state.ym;
}

function renderDashboard() {
  const t0 = performance.now();
  destroyCharts();
  const mo = state.months.find(x => x.ym === state.ym);
  const rows = filterByMonth(state.canon, state.ym);
  const metrics = aggregate(rows, state.ym);
  const insights = buildInsights(metrics);
  state.metrics = metrics;

  const badge = $('partialBadge');
  badge.hidden = !mo.partial;
  if (mo.partial) {
    const mm = pad2(mo.m + 1);
    badge.textContent = `⚠ חודש חלקי — נתונים מ-${pad2(mo.firstDay)}/${mm} עד ${pad2(mo.lastDay)}/${mm}`;
  }
  $('dashTitle').textContent = `תמונת מצב — ${mo.label}`;

  renderKpis(metrics, mo);
  renderInsights(insights);
  renderCarrierChart(metrics);
  renderShipTypeChart(metrics);
  renderTopClients(metrics);
  renderDailyChart(metrics);
  renderExceptions(metrics);

  const ms = Math.round(performance.now() - t0);
  $('dashboard').dataset.renderMs = String(ms);
}

function renderKpis(m, mo) {
  const kpi = (label, value, sub) => el('div', { class: 'kpi' },
    el('div', { class: 'kpi-label', text: label }),
    el('div', { class: 'kpi-value', text: value }),
    sub ? el('div', { class: 'kpi-sub', text: sub }) : null);
  const cards = [
    kpi('סה"כ הזמנות', fmtInt(m.orders), `ממוצע ${fmtInt(m.daily.avgPerActiveDay)} ליום פעילות`),
    m.units !== null ? kpi('סה"כ יחידות', fmtInt(m.units), `${fmtDec(m.avgUnitsPerOrder)} יחידות להזמנה`) : null,
    m.avgLinesPerOrder !== null ? kpi('ממוצע שורות להזמנה', fmtDec(m.avgLinesPerOrder), `${fmtInt(m.lines)} שורות סה"כ`) : null,
    kpi('לקוחות פעילים', fmtInt(m.activeClients), `5 המובילים: ${fmtPct(m.topClients.top5Share)}`),
    m.lockerShare !== null ? kpi('אחוז לוקרים', fmtPct(m.lockerShare), `${fmtInt(m.lockerOrders)} הזמנות ללוקר`) : null,
    kpi('ימי פעילות', fmtInt(m.activeDays), `מתוך ${daysInMonth(mo.y, mo.m)} ימים בחודש`),
  ].filter(Boolean);
  $('kpiGrid').replaceChildren(...cards);
}

function renderInsights(list) {
  const icon = { info: 'ℹ', warn: '⚠', good: '✓' };
  const toneHe = { info: 'מידע', warn: 'לתשומת לב', good: 'חיובי' };
  $('insightsCard').hidden = list.length === 0;
  $('insights').replaceChildren(...list.map(i => el('li', { class: `insight insight-${i.tone}` },
    el('span', { class: 'insight-icon', 'aria-label': toneHe[i.tone], text: icon[i.tone] }),
    el('span', { text: i.text }))));
}

function renderCarrierChart(m) {
  const items = m.carriers.items.slice();
  const other = m.carriers.other;
  const labels = items.map(c => c.name);
  const data = items.map(c => c.orders);
  const shares = items.map(c => c.share);
  const colors = items.map(() => PALETTE[0]);
  if (other) { labels.push('אחר'); data.push(other.orders); shares.push(other.share); colors.push(OTHER_COLOR); }
  $('carrierSub').textContent = `${fmtInt(m.carriers.count)} מובילים${other ? ` · מובילים מתחת ל-1% מקובצים ל"אחר"` : ''}`;

  const canvas = chartCard('carrierCard', data.length > 0);
  if (!canvas) return;
  const opts = horizontalBarOptions(
    ctx => `${fmtInt(ctx.raw)} הזמנות · ${fmtPct(shares[ctx.dataIndex])}`,
    items => {
      const i = items[0].dataIndex;
      if (other && i === labels.length - 1) return ['כולל:', ...other.members.map(c => `${c.name}: ${fmtInt(c.orders)}`)];
      return [];
    });
  charts.carrier = new Chart(canvas, {
    type: 'bar',
    data: { labels, datasets: [{ data, backgroundColor: colors }] },
    options: opts,
    plugins: [barEndLabels(i => `${fmtInt(data[i])} · ${fmtPct(shares[i])}`)],
  });
}

function shipTypeColors(types) {
  const fixed = { ND: PALETTE[0], LOCKER: PALETTE[1] };
  const extras = types.map(t => t.code).filter(c => !fixed[c]).sort();
  return types.map(t => fixed[t.code] || PALETTE[2 + (extras.indexOf(t.code) % (PALETTE.length - 2))]);
}

function renderShipTypeChart(m) {
  $('shipTypeCard').hidden = !m.hasShipType;
  if (!m.hasShipType) return;
  const types = m.shipTypes;
  const canvas = chartCard('shipTypeCard', types.length > 0);
  if (!canvas) return;
  charts.shipType = new Chart(canvas, {
    type: 'doughnut',
    data: {
      labels: types.map(t => `${t.label} · ${fmtPct(t.share)}`),
      datasets: [{ data: types.map(t => t.orders), backgroundColor: shipTypeColors(types),
                   borderColor: '#ffffff', borderWidth: 2, hoverOffset: 6 }],
    },
    options: {
      cutout: '62%',
      layout: { padding: 8 },
      plugins: {
        legend: { position: 'bottom', labels: { color: INK, padding: 16, font: { size: 13 } } },
        tooltip: { callbacks: {
          label: ctx => `${types[ctx.dataIndex].label} (${types[ctx.dataIndex].code}): ${fmtInt(ctx.raw)} · ${fmtPct(types[ctx.dataIndex].share)}`,
        } },
      },
    },
  });
}

function renderTopClients(m) {
  const items = m.topClients.items;
  $('clientsSub').textContent = items.length
    ? `5 הלקוחות המובילים = ${fmtPct(m.topClients.top5Share)} מההזמנות`
    : '';
  const canvas = chartCard('clientsCard', items.length > 0);
  if (!canvas) return;
  const data = items.map(c => c.orders);
  charts.clients = new Chart(canvas, {
    type: 'bar',
    data: { labels: items.map(c => c.name), datasets: [{ data, backgroundColor: PALETTE[0] }] },
    options: horizontalBarOptions(ctx => `${fmtInt(ctx.raw)} הזמנות · ${fmtPct(items[ctx.dataIndex].share)}`),
    plugins: [barEndLabels(i => `${fmtInt(data[i])} · ${fmtPct(items[i].share)}`)],
  });
}

function renderDailyChart(m) {
  const days = m.daily.days;
  const peak = m.daily.peak;
  const avg = m.daily.avgPerActiveDay;
  $('dailySub').textContent = peak && peak.orders
    ? `שיא: ${fmtDayKey(peak.date)} עם ${fmtInt(peak.orders)} הזמנות · ממוצע ${fmtInt(avg)} ליום פעילות`
    : '';
  const canvas = chartCard('dailyCard', days.some(d => d.orders > 0));
  if (!canvas) return;
  const peakIdx = days.findIndex(d => d.date === peak.date);
  const peakLabel = {
    id: 'peakLabel',
    afterDatasetsDraw(chart) {
      const bar = chart.getDatasetMeta(0).data[peakIdx];
      if (!bar) return;
      const { ctx } = chart;
      ctx.save();
      ctx.direction = 'ltr';
      ctx.font = `700 12px ${Chart.defaults.font.family}`;
      ctx.fillStyle = INK;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText(fmtInt(peak.orders), bar.x, bar.y - 4);
      ctx.restore();
    },
  };
  charts.daily = new Chart(canvas, {
    type: 'bar',
    data: {
      labels: days.map(d => String(Number(d.date.slice(8)))),
      datasets: [
        { label: 'הזמנות ביום', data: days.map(d => d.orders), order: 2,
          backgroundColor: days.map((d, i) => (i === peakIdx ? PALETTE[1] : PALETTE[0])),
          borderRadius: 3, borderSkipped: 'bottom', barPercentage: 0.8, categoryPercentage: 0.9 },
        { type: 'line', label: `ממוצע ליום פעילות (${fmtInt(avg)})`, data: days.map(() => avg), order: 1,
          borderColor: MUTED, borderWidth: 1.5, borderDash: [5, 4], pointRadius: 0, pointHitRadius: 0, fill: false },
      ],
    },
    options: {
      layout: { padding: { top: 18 } },
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true, autoSkipPadding: 6 } },
        y: { position: 'right', beginAtZero: true, grid: { color: GRID }, border: { display: false },
             ticks: { callback: v => fmtInt(v), maxTicksLimit: 6 } },
      },
      plugins: {
        legend: { position: 'top', align: 'start', labels: { color: INK } },
        tooltip: {
          filter: item => item.datasetIndex === 0,
          callbacks: {
            title: items => {
              const d = days[items[0].dataIndex];
              const [y, mm, dd] = d.date.split('-').map(Number);
              return `יום ${WEEKDAYS_HE[new Date(y, mm - 1, dd).getDay()]} ${fmtDayKey(d.date)}`;
            },
            label: ctx => `${fmtInt(ctx.raw)} הזמנות${ctx.dataIndex === peakIdx ? ' · יום השיא' : ''}`,
          },
        },
      },
    },
    plugins: [peakLabel],
  });
}

function renderExceptions(m) {
  const card = $('exceptionsCard');
  card.hidden = !m.hasStatus;
  if (!m.hasStatus) return;
  const e = m.exceptions;
  const table = $('excTable');
  $('excEmpty').hidden = e.total > 0;
  table.hidden = e.total === 0;
  $('excSub').textContent = e.total
    ? `${fmtInt(e.total)} הזמנות (${fmtPct(e.rate)} מההזמנות) בסטטוס שאינו DELIVERED`
    : '';
  if (!e.total) return;
  table.querySelector('tbody').replaceChildren(...e.rows.map(r => el('tr', {},
    el('td', {}, el('bdi', { text: r.status })),
    el('td', { text: r.carrier }),
    el('td', { class: 'num', text: fmtInt(r.orders) }),
    el('td', { class: 'num', text: fmtPct(r.orders / e.total) }))));
  table.querySelector('tfoot').replaceChildren(el('tr', {},
    el('td', { text: 'סה"כ' }),
    el('td', { text: e.topCarrier ? `הכי הרבה: ${e.topCarrier.name} (${fmtInt(e.topCarrier.orders)})` : '' }),
    el('td', { class: 'num', text: fmtInt(e.total) }),
    el('td', { class: 'num', text: '100%' })));
}

function initUI() {
  const dz = $('dropZone'), input = $('fileInput');
  $('pickBtn').addEventListener('click', e => { e.stopPropagation(); input.click(); });
  dz.addEventListener('click', () => input.click());
  dz.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); }
  });
  input.addEventListener('change', () => handleFile(input.files[0]));

  ['dragenter', 'dragover'].forEach(t => dz.addEventListener(t, e => {
    e.preventDefault(); dz.classList.add('is-dragover');
  }));
  ['dragleave', 'dragend'].forEach(t => dz.addEventListener(t, () => dz.classList.remove('is-dragover')));
  dz.addEventListener('drop', e => {
    e.preventDefault(); dz.classList.remove('is-dragover');
    handleFile(e.dataTransfer.files[0]);
  });
  // A file dropped outside the zone must not make the browser navigate away.
  ['dragover', 'drop'].forEach(t => window.addEventListener(t, e => e.preventDefault()));

  $('errorClose').addEventListener('click', hideError);
  $('resetBtn').addEventListener('click', resetUI);
  $('mappingContinue').addEventListener('click', applyMapping);
  $('monthSelect').addEventListener('change', e => { state.ym = e.target.value; renderDashboard(); });
}

/* ---------------------------------------------------------------------
   Boot (browser) / export (Node tests)
   --------------------------------------------------------------------- */
if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => { if (document.getElementById('dropZone')) initUI(); });
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    FIELDS, normalizeHeader, isPiiHeader, parseDate, parseTime, excelSerialToDate,
    findHeaderRow, detectColumns, needsMappingAttention, normalizeRows,
    isPartialMonth, monthStats, pickDefaultMonth, filterByMonth, aggregate, buildInsights,
    shipTypeLabel, isDelivered,
    correctSheetDate, extractTable,
  };
}
