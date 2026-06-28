import { useState, useEffect, useMemo, useRef, Fragment } from "react";
import { loadCloudData, saveDailyEntries, saveBulkOrders, saveGoalAmount } from "./lib/cloudData";
import { BarChart, Bar, Cell, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from "recharts";

const G = {
  dark:  "#1A3A2A",
  mid:   "#2D6A4F",
  light: "#52B788",
  gold:  "#D4A017",
  goldL: "#F0C842",
  cream: "#FDF8EE",
  ink:   "#1C1C1E",
  muted: "#6B7280",
  card:  "#FFFFFF",
  red:   "#DC2626",
};

const fmt = (n) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n);

const TODAY = (() => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
})();
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

function getMonthKey(date) { return date.slice(0, 7); }
function getMonthLabel(key) {
  const [y, m] = key.split("-");
  return `${MONTHS[parseInt(m) - 1]} ${y}`;
}

// Parse MM/DD/YYYY or M/D/YY → YYYY-MM-DD
// Returns { date, warning } where warning is set if format looks like DD/MM/YYYY
function parseDate(raw) {
  if (!raw) return { date: null, warning: null };
  const s = raw.trim();

  // M/D/YY or MM/DD/YY (2-digit year) — normalise to 4-digit year first
  const shortYear = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/);
  if (shortYear) {
    const yy = parseInt(shortYear[3]);
    const fullYear = yy <= 79 ? 2000 + yy : 1900 + yy; // 00-79 -> 2000s, 80-99 -> 1900s
    return parseDate(`${shortYear[1]}/${shortYear[2]}/${fullYear}`);
  }

  // MM/DD/YYYY (required format)
  const m1 = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m1) {
    const mm = parseInt(m1[1]), dd = parseInt(m1[2]), yyyy = m1[3];
    // Only block clearly wrong: month part > 12 means it's DD/MM/YYYY (Indian format).
    if (mm > 12) {
      return { date: null, warning: `"${s}" looks like DD/MM/YYYY (Indian format). Required format is MM/DD/YYYY. Did you mean ${m1[2].padStart(2,"0")}/${m1[1].padStart(2,"0")}/${yyyy}?` };
    }
    // Day > 12 with valid month = unambiguous MM/DD.
    // Both <= 12 = technically ambiguous, but per DBA instructions we trust MM/DD/YYYY.
    // No warning issued — the format is authoritative.
    return {
      date: `${yyyy}-${m1[1].padStart(2,"0")}-${m1[2].padStart(2,"0")}`,
      warning: null
    };
  }

  // DD-MM-YYYY (Indian dash format — flag it)
  const m2 = s.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (m2) {
    const dd = parseInt(m2[1]), mm = parseInt(m2[2]);
    if (dd > 12) {
      // Clearly DD-MM-YYYY
      return { date: `${m2[3]}-${m2[2]}-${m2[1]}`, warning: `"${s}" appears to be in DD-MM-YYYY format (Indian). Required format is MM/DD/YYYY. Imported as ${m2[3]}-${m2[2]}-${m2[1]} — please verify.` };
    }
    return { date: `${m2[3]}-${m2[2]}-${m2[1]}`, warning: `"${s}" uses dashes instead of slashes. Required format is MM/DD/YYYY. Imported as ${m2[3]}-${m2[2]}-${m2[1]} — please verify.` };
  }

  // YYYY-MM-DD (ISO — acceptable, no warning)
  const m3 = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m3) return { date: s, warning: null };

  // Completely unrecognised
  return { date: null, warning: `"${s}" is not a recognised date format. Required: MM/DD/YYYY (e.g. 06/12/2026).` };
}

function parseMoney(raw) {
  if (!raw) return 0;
  const n = parseFloat(String(raw).replace(/[$,\s]/g, ""));
  return isNaN(n) ? 0 : n;
}

// RFC-4180 compliant single-row CSV splitter. Handles quoted fields containing commas
// and escaped double-quotes ("" -> ") correctly — a plain regex/split cannot do this and
// will silently misalign every column after a field like "15\"\"" (representing 15").
function splitCSVRow(line) {
  const result = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') { field += '"'; i++; } // escaped quote
        else { inQuotes = false; }
      } else {
        field += c;
      }
    } else {
      if (c === '"') { inQuotes = true; }
      else if (c === ',') { result.push(field); field = ""; }
      else { field += c; }
    }
  }
  result.push(field);
  return result;
}

// Parse the Kaziranga CSV format
// Map the literal "Channel" column value to a normalised channel label.
// Per business rule: "Kaziranga Outfitters" = In-Store, "Kaziranga Pro Cricket Outfitters" = Online
// "Invoice Sales" (seen in real exports) = Bulk/Invoice — handled as its own bucket so it
// doesn't get silently misclassified as Unknown or merged into retail channels.
function normaliseChannel(raw) {
  if (!raw) return "Unknown";
  const s = raw.trim().toLowerCase();
  if (s === "kaziranga pro cricket outfitters") return "Online";
  if (s === "kaziranga outfitters") return "In-Store";
  if (s === "invoice sales" || s.includes("invoice")) return "Invoice";
  if (s.includes("payment link")) return "Payment Links";
  // Fallback fuzzy match in case of minor variations
  if (s.includes("pro cricket")) return "Online";
  if (s.includes("kaziranga")) return "In-Store";
  return "Unknown";
}

// Convert 0-based column index to Excel-style letter (0->A, 1->B, ..., 25->Z, 26->AA)
function colLetter(idx) {
  if (idx < 0) return "?";
  let s = "";
  let n = idx;
  while (n >= 0) {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  }
  return s;
}

function parseCSV(text) {
  // Normalise Windows (\r\n) and old Mac (\r) line endings to \n before splitting,
  // otherwise a trailing \r sticks to the last column on every row (e.g. Channel becomes
  // 'Kaziranga Outfitters\r') and silently breaks exact-match comparisons.
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim().split("\n").filter(Boolean);
  if (lines.length < 2) return { error: "CSV appears empty." };

  const header = splitCSVRow(lines[0]).map(h => h.trim().toLowerCase());
  const col = (name) => header.findIndex(h => h.includes(name));

  const idxDate    = col("date");
  const idxCost    = col("cost of good"); // updated column name
  const idxNet     = col("net sales");
  const idxProfit  = col("net profit");
  const idxGross   = col("gross sales");
  const idxDisc    = col("discounts");
  const idxItem    = col("item");
  const idxCat     = col("category");
  const idxQty     = col("qty");
  const idxTax     = col("tax");
  const idxCust    = col("customer");
  const idxRepeat  = col("returning customer"); // updated column name
  const idxChannel = col("channel");
  const idxEvent   = col("event type"); // Payment vs Return

  if (idxDate === -1) return { error: "Couldn't find a Date column." };

  // Group by date
  const byDate = {};
  const itemRows = [];
  const dateErrors = [];
  const dateWarnings = [];
  const unknownChannels = new Set();
  const blankCostItems = [];
  const missingValues = []; // critical fields missing — blocks import

  // Columns that must NOT be blank. Maps column-index -> human-readable label.
  // Customer Name is deliberately allowed to be blank (walk-in customers with no name captured).
  const REQUIRED_FIELDS = [
    { idx: idxDate,    label: "Date" },
    { idx: idxCat,     label: "Category" },
    { idx: idxItem,    label: "Item" },
    { idx: idxQty,     label: "Qty" },
    { idx: idxCost,    label: "Cost of Good" },
    { idx: idxGross,   label: "Gross Sales" },
    { idx: idxNet,     label: "Net Sales" },
    { idx: idxTax,     label: "Tax" },
    { idx: idxProfit,  label: "Net Profit After Tax" },
    { idx: idxEvent,   label: "Event Type" },
    { idx: idxRepeat,  label: "Returning Customer" },
    { idx: idxChannel, label: "Channel" },
  ];

  for (let i = 1; i < lines.length; i++) {
    // Properly handle quoted fields (commas inside quotes, escaped "" quotes, etc.)
    const cols = splitCSVRow(lines[i]);
    const get = (idx) => idx >= 0 ? (cols[idx] || "").replace(/\r/g, "").trim() : "";

    const rawDate = get(idxDate);
    const { date, warning: dateWarning } = parseDate(rawDate);
    if (!date) {
      dateErrors.push("Row " + i + ": " + (dateWarning || 'Unrecognised date "' + rawDate + '"'));
      continue;
    }
    if (dateWarning && !dateWarnings.find(w => w.includes(rawDate))) {
      dateWarnings.push(dateWarning);
    }

    // Check every required field for blank values BEFORE parsing.
    // Use spreadsheet-style cell refs (e.g. "F12") so the DBA can locate them quickly.
    const csvRowNum = i + 1; // +1 because i=1 corresponds to spreadsheet row 2 (header is row 1)
    for (const field of REQUIRED_FIELDS) {
      if (field.idx === -1) continue; // column not present in CSV — separate concern
      const v = (cols[field.idx] || "").replace(/\r/g, "").trim();
      if (v === "") {
        missingValues.push({
          row: csvRowNum,
          cell: colLetter(field.idx) + csvRowNum,
          field: field.label,
          itemContext: (cols[idxItem] || "").replace(/\r/g, "").trim() || "(unknown item)",
          dateContext: (cols[idxDate] || "").replace(/\r/g, "").trim() || "(no date)"
        });
      }
    }

    const rawCost = get(idxCost);
    const costIsBlank = rawCost === "" || rawCost === null || rawCost === undefined;
    let cost   = parseMoney(rawCost);
    let net    = parseMoney(get(idxNet));
    let profit = parseMoney(get(idxProfit));
    let gross  = parseMoney(get(idxGross));
    let tax    = parseMoney(get(idxTax));

    // Event Type: Payment (default) or Return/Refund.
    // Square already encodes returns with negative Gross/Net/Tax/Profit values in the export,
    // so no sign-flipping is needed here — summing them naturally deducts from the day's totals.
    // Cost of Good on a return row is reported as a positive number in Square's export even though
    // the row represents a deduction, so cost must be negated to correctly reduce total cost too.
    const rawEvent = get(idxEvent).toLowerCase();
    const isReturn = rawEvent.includes("return") || rawEvent.includes("refund");
    if (isReturn && cost > 0) {
      cost = -cost;
    }

    if (!byDate[date]) byDate[date] = { revenue: 0, cost: 0, profit: 0, tax: 0, items: [] };
    byDate[date].revenue += net;
    byDate[date].cost    += cost;
    byDate[date].profit  += profit;
    byDate[date].tax     += tax;

    const rawChannel = get(idxChannel);
    const channel = normaliseChannel(rawChannel);
    if (channel === "Unknown" && rawChannel) unknownChannels.add(rawChannel);

    const itemRecord = {
      item:     get(idxItem),
      category: get(idxCat),
      qty:      get(idxQty),
      gross, net, cost, profit, tax,
      customer: get(idxCust),
      repeat:   get(idxRepeat),
      channel,
      isReturn,
      costIsBlank,
    };
    byDate[date].items.push(itemRecord);
    itemRows.push({ date, ...itemRecord });
    if (costIsBlank) blankCostItems.push({ date, item: get(idxItem), row: i });
  }

  if (Object.keys(byDate).length === 0) {
    const errMsg = dateErrors.length > 0
      ? "No valid rows imported. Date errors found — check your date format (required: MM/DD/YYYY)."
      : "No valid rows found. Check date format — required: MM/DD/YYYY.";
    return { error: errMsg };
  }
  return { byDate, itemRows, dateErrors, dateWarnings, unknownChannels: Array.from(unknownChannels), blankCostItems, missingValues };
}

const SEED = {};
const STORAGE_KEY = "kaz_profit_v5";

export default function App() {
  const [entries, setEntries] = useState(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      return stored ? JSON.parse(stored) : SEED;
    } catch { return SEED; }
  });
  const [form, setForm]             = useState({ date: TODAY, revenue: "", cost: "" });
  const [activeMonth, setActiveMonth] = useState(getMonthKey(TODAY));
  const [toast, setToast]           = useState(null);
  const [importPreview, setImportPreview] = useState(null);
  const [activeTab, setActiveTab]   = useState("dashboard");
  const [expandedDate, setExpandedDate] = useState(null);
  const fileRef = useRef();
  const [cloudReady, setCloudReady] = useState(false);
  const didLoadCloud = useRef(false);

  // ── Bulk orders ──────────────────────────────────────────────
  const [bulkOrders, setBulkOrders] = useState(() => {
    try { const s = localStorage.getItem("kaz_bulk_v1"); return s ? JSON.parse(s) : []; } catch { return []; }
  });
  const EMPTY_BULK_FORM = {
    date: TODAY, club: "", items: "", qty: "", revenue: "",
    costGoods: "",      // cost of goods
    costShipping: "",   // shipping expense
    costPackaging: "",  // packaging
    costTax: "",        // tax on the order
    costOther: "",      // other costs
    costOtherLabel: "", // label for other cost
    status: "Paid", notes: ""
  };
  const [bulkForm, setBulkForm] = useState(EMPTY_BULK_FORM);
  const [editingBulk, setEditingBulk] = useState(null); // id being edited
  const [showBulkForm, setShowBulkForm] = useState(false);

  useEffect(() => {
    try { localStorage.setItem("kaz_bulk_v1", JSON.stringify(bulkOrders)); } catch {}
  }, [bulkOrders]);

  const saveBulkOrder = () => {
    if (!bulkForm.date || !bulkForm.club || !bulkForm.revenue) {
      showToast("Date, Club name and Revenue are required.", false); return;
    }
    const rev          = parseFloat(bulkForm.revenue) || 0;
    const costGoods    = parseFloat(bulkForm.costGoods)    || 0;
    const costShipping = parseFloat(bulkForm.costShipping) || 0;
    const costPackaging= parseFloat(bulkForm.costPackaging)|| 0;
    const costTax      = parseFloat(bulkForm.costTax)      || 0;
    const costOther    = parseFloat(bulkForm.costOther)    || 0;
    const totalCostLine = costGoods + costShipping + costPackaging + costTax + costOther;
    if (isNaN(rev)) { showToast("Enter a valid revenue amount.", false); return; }
    const orderData = {
      ...bulkForm, revenue: rev,
      cost: totalCostLine,
      costGoods, costShipping, costPackaging, costTax, costOther,
      profit: rev - totalCostLine
    };
    if (editingBulk !== null) {
      setBulkOrders(prev => prev.map(o => o.id === editingBulk ? { ...o, ...orderData } : o));
      setEditingBulk(null);
      showToast("Bulk order updated ✓");
    } else {
      setBulkOrders(prev => [{ id: Date.now(), ...orderData }, ...prev]);
      showToast("Bulk order saved ✓");
    }
    setBulkForm(EMPTY_BULK_FORM);
    setShowBulkForm(false);
  };

  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  const [clearStep, setClearStep] = useState(0); // 0 = idle, 1 = first confirm, 2 = final confirm
  const [reportDate, setReportDate] = useState(TODAY);
  const deleteBulkOrder = (id) => {
    setBulkOrders(prev => prev.filter(o => o.id !== id));
    setConfirmDeleteId(null);
    showToast("Bulk order deleted");
  };

  // ── Time range filter ────────────────────────────────────────
  const [timeRange, setTimeRange] = useState("30");   // "7" | "30" | "90" | "custom"
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo]   = useState(TODAY);
  const [showCustom, setShowCustom] = useState(false);

  const filteredDates = useMemo(() => {
    const now = new Date(TODAY);
    if (timeRange === "custom") {
      if (!customFrom || !customTo) return null; // null = all
      return { from: customFrom, to: customTo };
    }
    const days = parseInt(timeRange);
    const from = new Date(now);
    from.setDate(from.getDate() - days + 1);
    return { from: from.toISOString().slice(0, 10), to: TODAY };
  }, [timeRange, customFrom, customTo]);

  // ── Persist to localStorage ──────────────────────────────────
  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(entries)); } catch {}
  }, [entries]);

  const showToast = (msg, ok = true) => {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 3000);
  };

  // ── CSV import ──────────────────────────────────────────────
  const handleFile = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const result = parseCSV(ev.target.result);
      if (result.error) { showToast(result.error, false); return; }
      setImportPreview({ ...result, fileName: file.name });
      setActiveTab("import");
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  const confirmImport = () => {
    if (!importPreview) return;
    const dates = Object.keys(importPreview.byDate);
    const replaced = dates.filter(d => entries[d]).length;
    setEntries(prev => {
      const next = { ...prev };
      Object.entries(importPreview.byDate).forEach(([date, data]) => {
        // Always overwrite — replaces duplicates cleanly
        next[date] = data;
      });
      return next;
    });
    const msg = replaced > 0
      ? `Imported ${importPreview.itemRows.length} items — ${replaced} day(s) replaced with fresh data ✓`
      : `Imported ${importPreview.itemRows.length} items across ${dates.length} day(s) ✓`;
    showToast(msg);
    setImportPreview(null);
    setActiveTab("dashboard");
    // Jump to the most recent imported month
    const latest = dates.sort().pop();
    if (latest) setActiveMonth(getMonthKey(latest));
  };

  // ── Manual save ─────────────────────────────────────────────
  const handleSave = () => {
    if (!form.date || form.revenue === "" || form.cost === "") { showToast("Fill in all fields.", false); return; }
    const rev = parseFloat(form.revenue), cost = parseFloat(form.cost);
    if (isNaN(rev) || isNaN(cost)) { showToast("Enter valid numbers.", false); return; }
    setEntries(prev => ({ ...prev, [form.date]: { revenue: rev, cost, profit: rev - cost, tax: 0, items: [] } }));
    showToast(`Saved ${form.date} ✓`);
  };

  const handleDelete = (date) => {
    setEntries(prev => { const n = { ...prev }; delete n[date]; return n; });
    showToast(`Deleted ${date}`);
  };

  // ── Derived ─────────────────────────────────────────────────
  const allDailyRows = useMemo(() =>
    Object.entries(entries).map(([date, d]) => ({
      date, revenue: d.revenue, cost: d.cost,
      profit: (d.profit !== undefined && d.profit !== null) ? d.profit : (d.revenue - d.cost),
      tax: d.tax || 0, noSale: d.noSale || false,
      items: d.items || [],
      margin: d.revenue > 0 ? ((((d.profit !== undefined && d.profit !== null ? d.profit : (d.revenue - d.cost))) / d.revenue) * 100).toFixed(1) : "0.0"
    })).sort((a, b) => b.date.localeCompare(a.date)),
    [entries]
  );

  const dailyRows = useMemo(() => {
    if (!filteredDates) return allDailyRows;
    return allDailyRows.filter(r => r.date >= filteredDates.from && r.date <= filteredDates.to);
  }, [allDailyRows, filteredDates]);

  // ── Bulk order stats (filtered by time range) ───────────────
  const filteredBulkOrders = useMemo(() => {
    if (!filteredDates) return bulkOrders;
    return bulkOrders.filter(o => o.date >= filteredDates.from && o.date <= filteredDates.to);
  }, [bulkOrders, filteredDates]);

  const bulkStats = useMemo(() => {
    const paid    = filteredBulkOrders.filter(o => o.status === "Paid");
    const pending = filteredBulkOrders.filter(o => o.status === "Pending");
    const partial = filteredBulkOrders.filter(o => o.status === "Partial");
    const totalRev    = filteredBulkOrders.reduce((s, o) => s + o.revenue, 0);
    const totalProfit = filteredBulkOrders.reduce((s, o) => s + o.profit, 0);
    const pendingRev  = [...pending, ...partial].reduce((s, o) => s + o.revenue, 0);
    return { total: filteredBulkOrders.length, paid: paid.length, pending: pending.length, partial: partial.length,
      totalRev, totalProfit, pendingRev,
      margin: totalRev > 0 ? ((totalProfit / totalRev) * 100).toFixed(1) : "0.0" };
  }, [filteredBulkOrders]);

  const monthlyData = useMemo(() => {
    const map = {};
    // Daily/CSV entries
    dailyRows.forEach(({ date, revenue, cost, profit, tax }) => {
      const mk = getMonthKey(date);
      if (!map[mk]) map[mk] = { revenue: 0, cost: 0, profit: 0, tax: 0, days: 0, bulkRevenue: 0, bulkProfit: 0 };
      map[mk].revenue += revenue; map[mk].cost += cost;
      map[mk].profit += profit;  map[mk].tax += tax;
      map[mk].days++;
    });
    // Merge bulk orders (filtered by time range)
    filteredBulkOrders.forEach(o => {
      const mk = getMonthKey(o.date);
      if (!map[mk]) map[mk] = { revenue: 0, cost: 0, profit: 0, tax: 0, days: 0, bulkRevenue: 0, bulkProfit: 0 };
      map[mk].revenue      += o.revenue;
      map[mk].cost         += o.cost;   // include bulk cost in monthly cost
      map[mk].profit       += o.profit;
      map[mk].bulkRevenue  += o.revenue;
      map[mk].bulkProfit   += o.profit;
    });
    return Object.entries(map).map(([key, v]) => ({
      key, label: getMonthLabel(key), ...v,
      margin: v.revenue > 0 ? ((v.profit / v.revenue) * 100).toFixed(1) : "0.0"
    })).sort((a, b) => a.key.localeCompare(b.key));
  }, [dailyRows, filteredBulkOrders]);

  const currentMonth  = monthlyData.find(m => m.key === activeMonth);
  const activeDayRows = dailyRows.filter(r => getMonthKey(r.date) === activeMonth);
  const chartMonthly  = monthlyData.map(m => ({ name: m.label, Revenue: m.revenue, Cost: m.cost, Profit: m.profit, Bulk: m.bulkRevenue }));
  const chartDaily    = [...activeDayRows].sort((a,b)=>a.date.localeCompare(b.date))
    .map(r => ({ name: r.date.slice(5), Profit: r.profit, Revenue: r.revenue }));

  // Combined totals (retail + bulk)
  const retailRevenue = dailyRows.reduce((s, r) => s + r.revenue, 0);
  const retailProfit  = dailyRows.reduce((s, r) => s + r.profit, 0);
  const retailCost    = dailyRows.reduce((s, r) => s + r.cost, 0);
  const totalTaxCollected = dailyRows.reduce((s, r) => s + (r.tax || 0), 0);
  const totalRevenue  = retailRevenue + bulkStats.totalRev;
  const totalCost     = retailCost + filteredBulkOrders.reduce((s, o) => s + o.cost, 0);
  // Use Square's Net Profit After Tax directly for retail — already accounts for tax per line item
  const totalProfit   = retailProfit + bulkStats.totalProfit;
  const totalMargin   = totalRevenue > 0 ? ((totalProfit / totalRevenue) * 100).toFixed(1) : "0.0";
  const taxRate       = retailRevenue > 0 ? ((totalTaxCollected / retailRevenue) * 100).toFixed(1) : "0.0";

  const marginBadge = (pct) => ({
    background: pct >= 30 ? "#D1FAE5" : pct >= 15 ? "#FEF3C7" : "#FEE2E2",
    color: pct >= 30 ? G.mid : pct >= 15 ? "#92400E" : G.red,
  });

  // ── Category breakdown from items (all-time for comparison) ─
  const categoryBreakdown = useMemo(() => {
    const map = {};
    // Use ALL entries for all-time category comparison
    dailyRows.forEach(row => {
      (row.items || []).forEach(item => {
        const cat = item.category || "Uncategorized";
        if (!map[cat]) map[cat] = { revenue: 0, cost: 0, profit: 0, qty: 0 };
        map[cat].revenue += item.net;
        map[cat].cost    += item.cost;
        map[cat].profit  += item.profit;
        map[cat].qty     += parseInt(item.qty) || 1;
      });
    });
    return Object.entries(map).map(([cat, d]) => ({
      cat,
      ...d,
      margin: d.revenue > 0 ? ((d.profit / d.revenue) * 100).toFixed(1) : "0.0"
    })).sort((a,b) => b.profit - a.profit);
  }, [dailyRows]);

  // ── Category breakdown for active month only ─────────────────
  const categoryBreakdownMonth = useMemo(() => {
    const map = {};
    activeDayRows.forEach(row => {
      (row.items || []).forEach(item => {
        const cat = item.category || "Uncategorized";
        if (!map[cat]) map[cat] = { revenue: 0, cost: 0, profit: 0, qty: 0 };
        map[cat].revenue += item.net;
        map[cat].cost    += item.cost;
        map[cat].profit  += item.profit;
        map[cat].qty     += parseInt(item.qty) || 1;
      });
    });
    return Object.entries(map).map(([cat, d]) => ({
      cat,
      ...d,
      margin: d.revenue > 0 ? ((d.profit / d.revenue) * 100).toFixed(1) : "0.0"
    })).sort((a,b) => b.profit - a.profit);
  }, [activeDayRows]);

  const CAT_COLORS = ["#2D6A4F","#D4A017","#52B788","#E07B39","#6B7280","#1D4ED8"];

  const [goalAmount, setGoalAmount] = useState(() => {
    try { return parseFloat(localStorage.getItem("kaz_goal") || "5000"); } catch { return 5000; }
  });
  const [editingGoal, setEditingGoal] = useState(false);
  const [goalInput, setGoalInput] = useState("");
  const saveGoal = (val) => {
    const n = parseFloat(val);
    if (!isNaN(n) && n > 0) {
      setGoalAmount(n);
      try { localStorage.setItem("kaz_goal", n); } catch {}
    }
    setEditingGoal(false);
  };


  // ── Supabase cloud load/save ───────────────────────────────────
  useEffect(() => {
    let cancelled = false;

    async function run() {
      try {
        const data = await loadCloudData();

        if (cancelled) return;

        setEntries(data.entries);
        setBulkOrders(data.bulkOrders);
        setGoalAmount(data.goalAmount);

        didLoadCloud.current = true;
        setCloudReady(true);
      } catch (err) {
        console.error("Cloud load failed:", err);

        didLoadCloud.current = true;
        setCloudReady(true);

        showToast("Could not load cloud data. Check Supabase connection.", false);
      }
    }

    run();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!cloudReady || !didLoadCloud.current) return;

    const timeout = setTimeout(() => {
      saveDailyEntries(entries).catch((err) => {
        console.error("Daily entries cloud save failed:", err);
        showToast("Could not save daily entries to cloud.", false);
      });
    }, 700);

    return () => clearTimeout(timeout);
  }, [entries, cloudReady]);

  useEffect(() => {
    if (!cloudReady || !didLoadCloud.current) return;

    const timeout = setTimeout(() => {
      saveBulkOrders(bulkOrders).catch((err) => {
        console.error("Bulk orders cloud save failed:", err);
        showToast("Could not save bulk orders to cloud.", false);
      });
    }, 700);

    return () => clearTimeout(timeout);
  }, [bulkOrders, cloudReady]);

  useEffect(() => {
    if (!cloudReady || !didLoadCloud.current) return;

    const timeout = setTimeout(() => {
      saveGoalAmount(goalAmount).catch((err) => {
        console.error("Goal cloud save failed:", err);
        showToast("Could not save goal to cloud.", false);
      });
    }, 700);

    return () => clearTimeout(timeout);
  }, [goalAmount, cloudReady]);

  // ── Best selling items (all-time by profit) ──────────────────
  const topItems = useMemo(() => {
    const map = {};
    dailyRows.forEach(row => {
      (row.items || []).forEach(item => {
        const key = item.item || "Unknown";
        if (!map[key]) map[key] = { name: key, category: item.category, revenue: 0, cost: 0, profit: 0, qty: 0 };
        map[key].revenue += item.net;
        map[key].cost    += item.cost;
        map[key].profit  += item.profit;
        map[key].qty     += parseInt(item.qty) || 1;
      });
    });
    return Object.values(map)
      .map(d => ({ ...d, margin: d.revenue > 0 ? ((d.profit / d.revenue) * 100).toFixed(1) : "0.0" }))
      .sort((a, b) => b.profit - a.profit)
      .slice(0, 10);
  }, [dailyRows]);

  // ── Repeat customer rate ─────────────────────────────────────
  const customerStats = useMemo(() => {
    const map = {};
    dailyRows.forEach(row => {
      (row.items || []).forEach(item => {
        if (!item.customer) return;
        const key = item.customer.toLowerCase().trim();
        if (!map[key]) map[key] = { name: item.customer, isRepeat: item.repeat && item.repeat.toLowerCase() === "yes", revenue: 0, profit: 0, visits: new Set() };
        map[key].revenue += item.net;
        map[key].profit  += item.profit;
        map[key].visits.add(row.date);
      });
    });
    const customers = Object.values(map).map(c => ({ ...c, visits: c.visits.size }));
    const total     = customers.length;
    const returning = customers.filter(c => c.isRepeat).length;
    const newCust   = total - returning;
    const retRevenue = customers.filter(c => c.isRepeat).reduce((s,c) => s + c.revenue, 0);
    const newRevenue = customers.filter(c => !c.isRepeat).reduce((s,c) => s + c.revenue, 0);
    const totalRev   = retRevenue + newRevenue;
    return { total, returning, newCust, retRevenue, newRevenue, totalRev,
      retPct: total > 0 ? ((returning / total) * 100).toFixed(0) : 0,
      retRevPct: totalRev > 0 ? ((retRevenue / totalRev) * 100).toFixed(0) : 0,
      top: customers.sort((a,b) => b.revenue - a.revenue).slice(0, 8)
    };
  }, [dailyRows]);

  // ── Margin dip alerts ────────────────────────────────────────
  const MARGIN_THRESHOLD = 20;
  const marginAlerts = useMemo(() =>
    dailyRows.filter(r => r.revenue > 0 && parseFloat(r.margin) < MARGIN_THRESHOLD)
      .sort((a,b) => parseFloat(a.margin) - parseFloat(b.margin))
      .slice(0, 10),
    [dailyRows]
  );

  // ── Category leaders ────────────────────────────────────────
  const categoryLeaders = useMemo(() => {
    const map = {};
    dailyRows.forEach(row => {
      (row.items || []).forEach(item => {
        const cat = item.category || "Uncategorized";
        if (!map[cat]) map[cat] = { cat, revenue: 0, profit: 0, qty: 0 };
        map[cat].revenue += item.net;
        map[cat].profit  += item.profit;
        map[cat].qty     += parseInt(item.qty) || 1;
      });
    });
    const cats = Object.values(map);
    if (cats.length === 0) return null;
    return {
      byQty:     [...cats].sort((a,b) => b.qty     - a.qty    )[0],
      byRevenue: [...cats].sort((a,b) => b.revenue - a.revenue)[0],
      byProfit:  [...cats].sort((a,b) => b.profit  - a.profit )[0],
      all: cats.sort((a,b) => b.profit - a.profit),
    };
  }, [dailyRows]);

  // ── Channel stats ────────────────────────────────────────────
  const channelStats = useMemo(() => {
    const map = { "In-Store": { revenue: 0, cost: 0, profit: 0, qty: 0, orders: 0 }, "Online": { revenue: 0, cost: 0, profit: 0, qty: 0, orders: 0 } };
    let hasChannelData = false;
    dailyRows.forEach(row => {
      (row.items || []).forEach(item => {
        const ch = item.channel || "Unknown";
        if (ch === "Unknown") return;
        hasChannelData = true;
        if (!map[ch]) map[ch] = { revenue: 0, cost: 0, profit: 0, qty: 0, orders: 0 };
        map[ch].revenue += item.net;
        map[ch].cost    += item.cost;
        map[ch].profit  += item.profit;
        map[ch].qty     += parseInt(item.qty) || 1;
        map[ch].orders  += 1;
      });
    });
    if (!hasChannelData) return null;
    const channels = Object.entries(map).map(([name, d]) => ({
      name, ...d,
      margin: d.revenue > 0 ? ((d.profit / d.revenue) * 100).toFixed(1) : "0.0"
    }));
    const totalRev = channels.reduce((s, c) => s + c.revenue, 0);
    return { channels, totalRev };
  }, [dailyRows]);

  // ── Day of week analysis ────────────────────────────────────
  const DAY_NAMES  = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
  const DAY_STATUS = {
    0: { label: "Appt Only", color: "#6B7280", bg: "#F3F4F6" },  // Sunday
    1: { label: "Closed",    color: "#DC2626", bg: "#FEE2E2" },  // Monday
  };

  const dayOfWeekStats = useMemo(() => {
    const map = {};
    // Init all days
    DAY_NAMES.forEach((name, i) => {
      map[i] = { day: i, name, revenue: 0, profit: 0, count: 0, avgRevenue: 0, avgProfit: 0 };
    });
    dailyRows.forEach(row => {
      if (row.noSale || row.revenue === 0) return;
      const d = new Date(row.date + "T00:00:00");
      const dow = d.getDay();
      map[dow].revenue += row.revenue;
      map[dow].profit  += row.profit;
      map[dow].count   += 1;
    });
    return Object.values(map).map(d => ({
      ...d,
      avgRevenue: d.count > 0 ? d.revenue / d.count : 0,
      avgProfit:  d.count > 0 ? d.profit  / d.count : 0,
    }));
  }, [dailyRows]);

  // ── Render ───────────────────────────────────────────────────

  if (!cloudReady) {
    return (
      <div style={{
        minHeight: "100vh",
        background: G.cream,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: G.dark,
        fontFamily: "'Segoe UI', system-ui, sans-serif",
        fontWeight: 800,
      }}>
        Loading your saved dashboard...
      </div>
    );
  }

  return (
    <div style={{ minHeight: "100vh", background: G.cream, fontFamily: "'Segoe UI', system-ui, sans-serif", color: G.ink }}>

      {/* Header */}
      <div style={{ background: G.dark, padding: "16px 24px", display: "flex", alignItems: "center", gap: 12, boxShadow: "0 2px 12px #0004" }}>
        <div style={{ width: 36, height: 36, borderRadius: 10, background: G.gold, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18 }}>🦏</div>
        <div>
          <div style={{ color: G.goldL, fontWeight: 700, fontSize: 16 }}>Kaziranga Pro Cricket Outfitters</div>
          <div style={{ color: "#94A89A", fontSize: 11 }}>Profit Intelligence Dashboard</div>
        </div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
          {["dashboard","insights","bulk","eod","import"].map(tab => (
            <button key={tab} onClick={() => setActiveTab(tab)} style={{
              padding: "6px 16px", borderRadius: 20, border: "none", cursor: "pointer", fontSize: 12, fontWeight: 600,
              background: activeTab === tab ? G.gold : "#2D4A3A",
              color: activeTab === tab ? G.dark : G.goldL,
            }}>{tab === "dashboard" ? "📊 Dashboard" : tab === "insights" ? "💡 Insights" : tab === "bulk" ? "📦 Bulk Orders" : tab === "eod" ? "🗓 End of Day" : "📥 Import CSV"}</button>
          ))}
        </div>
      </div>

      {/* ── TIME RANGE BAR ── */}
      {activeTab !== "import" && (
        <div style={{ background: "#F0F7F3", borderBottom: "1px solid #D8EDE3", padding: "10px 24px", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: G.dark, marginRight: 4 }}>📅 Time Range:</span>
          {[
            { label: "Last 7 Days",  val: "7" },
            { label: "Last 30 Days", val: "30" },
            { label: "Last 90 Days", val: "90" },
            { label: "Custom",       val: "custom" },
          ].map(({ label, val }) => (
            <button key={val} onClick={() => { setTimeRange(val); setShowCustom(val === "custom"); }} style={{
              padding: "5px 14px", borderRadius: 20, border: "none", cursor: "pointer", fontSize: 12, fontWeight: 600,
              background: timeRange === val ? G.dark : "#fff",
              color: timeRange === val ? G.goldL : G.muted,
              boxShadow: "0 1px 3px #0001"
            }}>{label}</button>
          ))}
          {showCustom && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginLeft: 4 }}>
              <input type="date" value={customFrom} max={customTo || TODAY}
                onChange={e => setCustomFrom(e.target.value)}
                style={{ padding: "4px 8px", borderRadius: 8, border: `1px solid ${G.mid}`, fontSize: 12, color: G.dark, outline: "none" }} />
              <span style={{ color: G.muted, fontSize: 12 }}>to</span>
              <input type="date" value={customTo} min={customFrom} max={TODAY}
                onChange={e => setCustomTo(e.target.value)}
                style={{ padding: "4px 8px", borderRadius: 8, border: `1px solid ${G.mid}`, fontSize: 12, color: G.dark, outline: "none" }} />
            </div>
          )}
          {filteredDates && (
            <span style={{ marginLeft: "auto", fontSize: 11, color: G.muted }}>
              Showing {dailyRows.length} day{dailyRows.length !== 1 ? "s" : ""} · {filteredDates.from} → {filteredDates.to}
            </span>
          )}
        </div>
      )}

      {/* ── IMPORT TAB ── */}
      {activeTab === "import" && (
        <div style={{ maxWidth: 820, margin: "0 auto", padding: "28px 16px" }}>

          {/* Drop zone */}
          <div
            onClick={() => fileRef.current.click()}
            style={{ border: `2px dashed ${G.mid}`, borderRadius: 16, padding: "36px 24px", textAlign: "center", cursor: "pointer", background: "#F0F7F3", marginBottom: 24 }}
          >
            <div style={{ fontSize: 36, marginBottom: 10 }}>📂</div>
            <div style={{ fontWeight: 700, color: G.dark, fontSize: 16 }}>Drop your daily CSV report here</div>
            <div style={{ color: G.muted, fontSize: 13, marginTop: 6 }}>Supports the Kaziranga item sale export format</div>
            <div style={{ marginTop: 14, display: "inline-block", padding: "8px 22px", background: G.gold, color: G.dark, borderRadius: 20, fontWeight: 700, fontSize: 13 }}>Choose File</div>
            <input ref={fileRef} type="file" accept=".csv" onChange={handleFile} style={{ display: "none" }} />
          </div>

          {/* Preview */}
          {importPreview && (
            <div style={{ background: G.card, borderRadius: 14, padding: "22px", boxShadow: "0 1px 6px #0001" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
                <div>
                  <div style={{ fontWeight: 700, color: G.dark, fontSize: 15 }}>Preview — {importPreview.fileName}</div>
                  <div style={{ color: G.muted, fontSize: 12, marginTop: 3 }}>{importPreview.itemRows.length} line items across {Object.keys(importPreview.byDate).length} day(s)</div>
                </div>
                {(() => {
                  const hasDupes      = Object.keys(importPreview.byDate).some(d => entries[d]);
                  const hasDayFlag    = Object.keys(importPreview.byDate).some(d => [0,1].includes(new Date(d + "T00:00:00").getDay()));
                  const hasDateErr    = importPreview.dateErrors && importPreview.dateErrors.length > 0;
                  const hasDateWarn   = importPreview.dateWarnings && importPreview.dateWarnings.length > 0;
                  const hasMissing    = importPreview.missingValues && importPreview.missingValues.length > 0;
                  // Missing values are a soft flag — handled in its own banner with its own Import Anyway button.
                  // Date errors and Sunday/Monday flags are also handled by their own banners.
                  const blocked       = hasDateErr || hasDateWarn || hasDayFlag || hasMissing;
                  // Show normal import button only when nothing blocks it
                  if (!blocked && !hasDupes) {
                    return (
                      <button onClick={confirmImport} style={{ padding: "9px 22px", background: G.mid, color: "#fff", border: "none", borderRadius: 10, fontWeight: 700, cursor: "pointer", fontSize: 14 }}>
                        ✓ Import to Dashboard
                      </button>
                    );
                  }
                  return null;
                })()}
              </div>

              {/* Duplicate warning with Go Ahead / Cancel buttons */}
              {Object.keys(importPreview.byDate).some(d => entries[d]) && (
                <div style={{ background: "#FEF3C7", border: "1px solid #F59E0B", borderRadius: 10, padding: "14px 16px", marginBottom: 16, fontSize: 13, color: "#92400E" }}>
                  <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                    <span style={{ fontSize: 20 }}>⚠️</span>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 700, marginBottom: 4 }}>Duplicate data detected</div>
                      <div style={{ marginBottom: 12 }}>
                        <strong>{Object.keys(importPreview.byDate).filter(d => entries[d]).join(", ")}</strong> already exist in your dashboard.
                        Do you want to replace the existing data with this file?
                      </div>
                      {!(importPreview.dateErrors && importPreview.dateErrors.length > 0) && !(importPreview.dateWarnings && importPreview.dateWarnings.length > 0) && !(importPreview.missingValues && importPreview.missingValues.length > 0) && (
                        <div style={{ display: "flex", gap: 10 }}>
                          <button onClick={confirmImport} style={{
                            padding: "8px 20px", background: "#D97706", color: "#fff", border: "none",
                            borderRadius: 8, fontWeight: 700, cursor: "pointer", fontSize: 13
                          }}>✓ Yes, replace it</button>
                          <button onClick={() => { setImportPreview(null); setActiveTab("import"); }} style={{
                            padding: "8px 20px", background: "#fff", color: "#92400E",
                            border: "1px solid #F59E0B", borderRadius: 8, fontWeight: 700, cursor: "pointer", fontSize: 13
                          }}>✕ Cancel, keep existing</button>
                        </div>
                      )}
                      {(importPreview.dateErrors && importPreview.dateErrors.length > 0 || importPreview.dateWarnings && importPreview.dateWarnings.length > 0 || importPreview.missingValues && importPreview.missingValues.length > 0) && (
                        <div style={{ fontSize: 12, color: "#92400E", fontWeight: 600 }}>🚫 Fix errors above before importing.</div>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* Date format warnings */}
              {importPreview.dateWarnings && importPreview.dateWarnings.length > 0 && (
                <div style={{ background: "#FFFBEB", border: "1px solid #F59E0B", borderRadius: 10, padding: "14px 16px", marginBottom: 16, fontSize: 13, color: "#78350F" }}>
                  <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                    <span style={{ fontSize: 20 }}>⚠️</span>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 700, marginBottom: 6 }}>Date format warning</div>
                      <div style={{ marginBottom: 10 }}>Some dates in this file may be in the wrong format. The required format is <strong>MM/DD/YYYY</strong> (US format), not DD/MM/YYYY (Indian format).</div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 5, marginBottom: 12 }}>
                        {importPreview.dateWarnings.map((w, i) => (
                          <div key={i} style={{ background: "#FEF3C7", borderRadius: 6, padding: "5px 10px", fontSize: 12 }}>⚠ {w}</div>
                        ))}
                      </div>
                      <div style={{ fontSize: 12, color: "#92400E" }}>
                        🚫 <strong>Import blocked.</strong> Please ask your DBA to fix the date format to <strong>MM/DD/YYYY</strong> and re-send the file.
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Date format errors - rows that could not be parsed */}
              {importPreview.dateErrors && importPreview.dateErrors.length > 0 && (
                <div style={{ background: "#FEF2F2", border: "1px solid #DC2626", borderRadius: 10, padding: "14px 16px", marginBottom: 16, fontSize: 13, color: "#7F1D1D" }}>
                  <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                    <span style={{ fontSize: 20 }}>🚫</span>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 700, marginBottom: 6 }}>{importPreview.dateErrors.length} row{importPreview.dateErrors.length > 1 ? "s" : ""} skipped — unrecognised date format</div>
                      <div style={{ marginBottom: 10 }}>These rows could not be imported because the date format was not recognised. Required format: <strong>MM/DD/YYYY</strong></div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 8 }}>
                        {importPreview.dateErrors.slice(0, 5).map((e, i) => (
                          <div key={i} style={{ background: "#FEE2E2", borderRadius: 6, padding: "4px 10px", fontSize: 12 }}>✗ {e}</div>
                        ))}
                        {importPreview.dateErrors.length > 5 && <div style={{ fontSize: 11, color: "#9A1C1C" }}>...and {importPreview.dateErrors.length - 5} more skipped rows</div>}
                      </div>
                      <div style={{ fontSize: 12 }}>
                        🚫 <strong>Import blocked.</strong> Ask your DBA to fix the date column to <strong>MM/DD/YYYY</strong> and re-send the file.
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Missing values — HARD BLOCK */}
              {importPreview.missingValues && importPreview.missingValues.length > 0 && (() => {
                // Group by field for a cleaner summary, but also show individual cells.
                const byField = {};
                importPreview.missingValues.forEach(m => {
                  if (!byField[m.field]) byField[m.field] = [];
                  byField[m.field].push(m);
                });
                return (
                  <div style={{ background: "#FFF7ED", border: "1px solid #F59E0B", borderRadius: 10, padding: "14px 16px", marginBottom: 16, fontSize: 13, color: "#7C2D12" }}>
                    <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                      <span style={{ fontSize: 20 }}>⚠️</span>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontWeight: 700, marginBottom: 6, fontSize: 14 }}>{importPreview.missingValues.length} missing value{importPreview.missingValues.length !== 1 ? "s" : ""} found</div>
                        <div style={{ marginBottom: 12 }}>
                          The CSV has blank values in required columns. You can still import — but profit calculations for these rows may be inaccurate.
                          Ideally, ask your DBA to fill in the cells below and re-send the file.
                          Cell references are in spreadsheet format — open the CSV in Excel/Sheets and go directly to each cell.
                        </div>

                        {/* Summary by field */}
                        <div style={{ background: "#FEF3C7", borderRadius: 8, padding: "10px 12px", marginBottom: 10 }}>
                          <div style={{ fontWeight: 700, marginBottom: 6, fontSize: 12 }}>Summary by column:</div>
                          <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                            {Object.entries(byField).map(([field, items]) => (
                              <div key={field} style={{ fontSize: 12 }}>
                                <strong>{field}:</strong> {items.length} blank cell{items.length !== 1 ? "s" : ""}
                              </div>
                            ))}
                          </div>
                        </div>

                        {/* Cell-level detail */}
                        <div style={{ fontSize: 11, fontWeight: 700, marginBottom: 6, color: "#7C2D12" }}>Individual missing cells (first 50):</div>
                        <div style={{ maxHeight: 220, overflowY: "auto", background: "#fff", border: "1px solid #FDE68A", borderRadius: 6 }}>
                          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                            <thead style={{ position: "sticky", top: 0, background: "#FEF3C7" }}>
                              <tr>
                                {["Cell","CSV Row","Date","Item","Missing Field"].map(h => (
                                  <th key={h} style={{ padding: "5px 8px", textAlign: "left", color: "#7C2D12", fontWeight: 700 }}>{h}</th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {importPreview.missingValues.slice(0, 50).map((m, i) => (
                                <tr key={i} style={{ borderTop: "1px solid #FDE68A" }}>
                                  <td style={{ padding: "4px 8px", fontFamily: "monospace", fontWeight: 700, color: "#D97706" }}>{m.cell}</td>
                                  <td style={{ padding: "4px 8px", color: G.muted }}>{m.row}</td>
                                  <td style={{ padding: "4px 8px" }}>{m.dateContext}</td>
                                  <td style={{ padding: "4px 8px", maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={m.itemContext}>{m.itemContext}</td>
                                  <td style={{ padding: "4px 8px", fontWeight: 600 }}>{m.field}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                        {importPreview.missingValues.length > 50 && (
                          <div style={{ fontSize: 11, color: "#92400E", marginTop: 6 }}>...and {importPreview.missingValues.length - 50} more missing cells not shown</div>
                        )}

                        <div style={{ marginTop: 14, display: "flex", gap: 10, flexWrap: "wrap" }}>
                          <button onClick={confirmImport} style={{
                            padding: "8px 18px", background: "#D97706", color: "#fff", border: "none",
                            borderRadius: 8, fontWeight: 700, cursor: "pointer", fontSize: 13
                          }}>⚠️ Import Anyway</button>
                          <button onClick={() => { setImportPreview(null); setActiveTab("import"); }} style={{
                            padding: "8px 18px", background: "#fff", color: "#92400E",
                            border: "1px solid #F59E0B", borderRadius: 8, fontWeight: 700, cursor: "pointer", fontSize: 13
                          }}>✕ Cancel & Re-check</button>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })()}

              {/* Unknown channel warning */}
              {importPreview.unknownChannels && importPreview.unknownChannels.length > 0 && (
                <div style={{ background: "#FFF7ED", border: "1px solid #F97316", borderRadius: 10, padding: "14px 16px", marginBottom: 16, fontSize: 13, color: "#7C2D12" }}>
                  <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                    <span style={{ fontSize: 20 }}>❓</span>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 700, marginBottom: 6 }}>Unrecognised Channel value{importPreview.unknownChannels.length > 1 ? "s" : ""}</div>
                      <div style={{ marginBottom: 10 }}>
                        Expected <strong>"Kaziranga Outfitters"</strong> (In-Store) or <strong>"Kaziranga Pro Cricket Outfitters"</strong> (Online), but found:
                      </div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 8 }}>
                        {importPreview.unknownChannels.map((c, i) => (
                          <div key={i} style={{ background: "#FFEDD5", borderRadius: 6, padding: "4px 10px", fontSize: 12 }}>❓ "{c}"</div>
                        ))}
                      </div>
                      <div style={{ fontSize: 12 }}>These rows will import but show as "Unknown" channel — they won't count toward In-Store or Online totals. Ask your DBA to verify the Channel column.</div>
                    </div>
                  </div>
                </div>
              )}

              {/* Day of week warnings */}
              {(() => {
                const flagged = Object.keys(importPreview.byDate).filter(date => {
                  const dow = new Date(date + "T00:00:00").getDay();
                  return dow === 0 || dow === 1;
                });
                if (flagged.length === 0) return null;
                return (
                  <div style={{ background: "#FFF7ED", border: "1px solid #F97316", borderRadius: 10, padding: "14px 16px", marginBottom: 16, fontSize: 13, color: "#7C2D12" }}>
                    <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                      <span style={{ fontSize: 20 }}>🚫</span>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontWeight: 700, marginBottom: 6 }}>Store hours conflict detected</div>
                        <div style={{ marginBottom: 12 }}>
                          The following date{flagged.length > 1 ? "s" : ""} fall on a day when the store is closed or by appointment only:
                        </div>
                        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 14 }}>
                          {flagged.map(date => {
                            const dow = new Date(date + "T00:00:00").getDay();
                            const isMonday = dow === 1;
                            return (
                              <div key={date} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                                <span style={{
                                  background: isMonday ? "#FEE2E2" : "#FEF3C7",
                                  color: isMonday ? "#DC2626" : "#92400E",
                                  borderRadius: 8, padding: "2px 10px", fontSize: 11, fontWeight: 700
                                }}>
                                  {isMonday ? "🔴 CLOSED" : "📞 APPT ONLY"}
                                </span>
                                <span style={{ fontWeight: 600 }}>{date}</span>
                                <span style={{ color: "#9A3412" }}>({isMonday ? "Monday — store is closed" : "Sunday — by appointment only"})</span>
                              </div>
                            );
                          })}
                        </div>
                        <div style={{ fontSize: 12, color: "#9A3412", marginBottom: 12 }}>
                          This may indicate a data error in the export. Please verify with your DBA before importing.
                        </div>
                        <div style={{ display: "flex", gap: 10 }}>
                          <button onClick={confirmImport} style={{
                            padding: "7px 18px", background: "#EA580C", color: "#fff", border: "none",
                            borderRadius: 8, fontWeight: 700, cursor: "pointer", fontSize: 12
                          }}>⚠️ Import Anyway</button>
                          <button onClick={() => { setImportPreview(null); setActiveTab("import"); }} style={{
                            padding: "7px 18px", background: "#fff", color: "#7C2D12",
                            border: "1px solid #F97316", borderRadius: 8, fontWeight: 700, cursor: "pointer", fontSize: 12
                          }}>✕ Cancel & Re-check</button>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })()}

              {/* Daily summary from CSV */}
              {Object.entries(importPreview.byDate).map(([date, data]) => (
                <div key={date} style={{ marginBottom: 16 }}>
                  <div style={{ background: G.dark, color: G.goldL, padding: "8px 14px", borderRadius: "8px 8px 0 0", fontWeight: 600, fontSize: 13, display: "flex", gap: 24 }}>
                    <span>📅 {date}</span>
                    <span>Revenue: {fmt(data.revenue)}</span>
                    <span>Cost: {fmt(data.cost)}</span>
                    <span style={{ color: data.profit >= 0 ? G.goldL : "#FCA5A5" }}>Profit: {fmt(data.profit)}</span>
                    <span>Tax: {fmt(data.tax)}</span>
                    {data.items.filter(i => i.isReturn).length > 0 && (
                      <span style={{ color: "#FCA5A5" }}>↩ {data.items.filter(i => i.isReturn).length} Return{data.items.filter(i => i.isReturn).length > 1 ? "s" : ""}</span>
                    )}
                  </div>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                    <thead>
                      <tr style={{ background: "#F3F4F6" }}>
                        {["Event","Item","Category","Channel","Net Sales","Cost","Profit","Customer",""].map(h => (
                          <th key={h} style={{ padding: "6px 10px", textAlign: "left", color: G.muted, fontWeight: 600 }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {data.items.map((item, i) => (
                        <tr key={i} style={{ borderBottom: "1px solid #F0F0F0", background: item.isReturn ? "#FEF2F2" : "transparent" }}>
                          <td style={{ padding: "7px 10px" }}>
                            {item.isReturn ? (
                              <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 8, background: "#FEE2E2", color: G.red }}>↩ Return</span>
                            ) : (
                              <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 8, background: "#D1FAE5", color: G.mid }}>✓ Payment</span>
                            )}
                          </td>
                          <td style={{ padding: "7px 10px", maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={item.item}>{item.item}</td>
                          <td style={{ padding: "7px 10px", color: G.muted }}>{item.category}</td>
                          <td style={{ padding: "7px 10px" }}>
                            {item.channel && item.channel !== "Unknown" ? (
                              <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 8, background: item.channel === "Online" ? "#DBEAFE" : "#D1FAE5", color: item.channel === "Online" ? "#1D4ED8" : G.mid }}>
                                {item.channel === "Online" ? "🌐" : "🏪"} {item.channel}
                              </span>
                            ) : <span style={{ color: G.muted, fontSize: 11 }}>❓ Unknown</span>}
                          </td>
                          <td style={{ padding: "7px 10px", color: item.net < 0 ? G.red : G.ink }}>{fmt(item.net)}</td>
                          <td style={{ padding: "7px 10px", color: item.costIsBlank ? "#D97706" : G.muted }}>
                            {item.costIsBlank ? <span title="Cost of Good was blank in the CSV">⚠️ $0.00</span> : fmt(item.cost)}
                          </td>
                          <td style={{ padding: "7px 10px", fontWeight: 600, color: item.profit >= 0 ? G.mid : G.red }}>{fmt(item.profit)}</td>
                          <td style={{ padding: "7px 10px", color: G.muted }}>{item.customer}</td>
                          <td style={{ padding: "7px 10px" }}>
                            {item.customer && (
                              <span style={{
                                fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 10,
                                background: item.repeat && item.repeat.toLowerCase() === "yes" ? "#DBEAFE" : "#D1FAE5",
                                color: item.repeat && item.repeat.toLowerCase() === "yes" ? "#1D4ED8" : G.mid,
                              }}>
                                {item.repeat && item.repeat.toLowerCase() === "yes" ? "↩ Returning" : "★ New"}
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
            </div>
          )}

          {!importPreview && (
            <div style={{ color: G.muted, fontSize: 13, textAlign: "center", marginTop: 8 }}>
              Expected columns: Date (MM/DD/YYYY), Category, Item, Qty, Price Point Name, Cost of Good, Gross Sales, Discounts, Net Sales, Tax, Net Profit After Tax, Event Type (Payment/Return), Customer Name, Returning Customer, Channel
            </div>
          )}

          {/* Danger zone — clear all data */}
          <div style={{ marginTop: 48, borderTop: "1px dashed #E0E0E0", paddingTop: 24 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: G.muted, letterSpacing: 1, marginBottom: 10, textTransform: "uppercase" }}>⚠️ Danger Zone</div>
            <div style={{ background: "#FEF2F2", border: "1px solid #FECACA", borderRadius: 12, padding: "16px 20px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 20, flexWrap: "wrap" }}>
              <div>
                <div style={{ fontWeight: 700, color: "#7F1D1D", fontSize: 13, marginBottom: 4 }}>Clear All Dashboard Data</div>
                <div style={{ color: "#9A3412", fontSize: 12 }}>Permanently deletes all imported sales data. This cannot be undone.</div>
              </div>
              {clearStep === 0 && (
                <button onClick={() => setClearStep(1)} style={{
                  padding: "9px 20px", background: "#fff", color: "#DC2626",
                  border: "2px solid #DC2626", borderRadius: 8,
                  fontWeight: 700, cursor: "pointer", fontSize: 13, whiteSpace: "nowrap"
                }}>🗑 Clear All Data</button>
              )}
              {clearStep === 1 && (
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <span style={{ fontSize: 12, color: "#7F1D1D", fontWeight: 700 }}>Delete all data?</span>
                  <button onClick={() => setClearStep(2)} style={{
                    padding: "7px 14px", background: "#DC2626", color: "#fff", border: "none",
                    borderRadius: 6, fontWeight: 700, cursor: "pointer", fontSize: 12
                  }}>Yes, continue</button>
                  <button onClick={() => setClearStep(0)} style={{
                    padding: "7px 14px", background: "#fff", color: G.muted, border: "1px solid #E0E0E0",
                    borderRadius: 6, cursor: "pointer", fontSize: 12, fontWeight: 600
                  }}>Cancel</button>
                </div>
              )}
              {clearStep === 2 && (
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <span style={{ fontSize: 12, color: "#7F1D1D", fontWeight: 700 }}>⚠️ Final confirmation — this cannot be undone:</span>
                  <button onClick={() => {
                    try { localStorage.removeItem(STORAGE_KEY); } catch {}
                    setEntries(SEED);
                    setBulkOrders([]);
                    try { localStorage.removeItem("kaz_bulk_v1"); } catch {}
                    setClearStep(0);
                    showToast("All data cleared");
                  }} style={{
                    padding: "7px 14px", background: "#DC2626", color: "#fff", border: "none",
                    borderRadius: 6, fontWeight: 700, cursor: "pointer", fontSize: 12
                  }}>🗑 Delete Everything</button>
                  <button onClick={() => setClearStep(0)} style={{
                    padding: "7px 14px", background: "#fff", color: G.muted, border: "1px solid #E0E0E0",
                    borderRadius: 6, cursor: "pointer", fontSize: 12, fontWeight: 600
                  }}>Cancel</button>
                </div>
              )}
            </div>
          </div>

        </div>
      )}

      {/* ── INSIGHTS TAB ── */}
      {activeTab === "insights" && (
        <div style={{ maxWidth: 980, margin: "0 auto", padding: "24px 16px" }}>

          {/* Day of Week Heatmap */}
          <div style={{ background: G.card, borderRadius: 14, padding: "20px 22px", marginBottom: 24, boxShadow: "0 1px 6px #0001" }}>
            <div style={{ fontWeight: 700, color: G.dark, fontSize: 15, marginBottom: 4 }}>📅 Busiest Days of the Week</div>
            <div style={{ color: G.muted, fontSize: 12, marginBottom: 20 }}>All-time average revenue per day · Mon = Closed · Sun = By Appointment Only</div>

            {/* Day cards */}
            {(() => {
              const opDays = dayOfWeekStats.filter(d => d.day !== 0 && d.day !== 1);
              const maxAvg = Math.max(...opDays.map(d => d.avgRevenue), 1);
              const opDaysWithData = opDays.filter(d => d.count > 0);
              const busiest = opDaysWithData.length > 0 ? opDaysWithData.reduce((a, b) => a.avgRevenue > b.avgRevenue ? a : b) : null;
              return (
                <Fragment>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 8, marginBottom: 20 }}>
                    {dayOfWeekStats.map(d => {
                      const isClosed = d.day === 1;
                      const isAppt   = d.day === 0;
                      const isOp     = !isClosed && !isAppt;
                      const barH     = isOp && maxAvg > 0 ? Math.max((d.avgRevenue / maxAvg) * 100, 4) : 0;
                      const isBest   = isOp && busiest && d.day === busiest.day;
                      return (
                        <div key={d.day} style={{ textAlign: "center" }}>
                          {/* Bar */}
                          <div style={{ height: 80, display: "flex", alignItems: "flex-end", justifyContent: "center", marginBottom: 6 }}>
                            {isOp ? (
                              <div style={{
                                width: "70%", height: `${barH}%`, minHeight: d.count > 0 ? 6 : 0,
                                borderRadius: "4px 4px 0 0",
                                background: isBest ? G.gold : G.light,
                                position: "relative", transition: "height 0.3s"
                              }}>
                                {isBest && (
                                  <div style={{ position: "absolute", top: -20, left: "50%", transform: "translateX(-50%)", fontSize: 14 }}>⭐</div>
                                )}
                              </div>
                            ) : (
                              <div style={{ width: "70%", height: "30%", borderRadius: "4px 4px 0 0", background: isClosed ? "#FEE2E2" : "#F3F4F6" }} />
                            )}
                          </div>
                          {/* Day name */}
                          <div style={{ fontSize: 11, fontWeight: 700, color: isClosed ? G.red : isAppt ? G.muted : G.dark, marginBottom: 3 }}>
                            {d.name.slice(0, 3).toUpperCase()}
                          </div>
                          {/* Status or avg revenue */}
                          {isClosed ? (
                            <div style={{ fontSize: 9, background: "#FEE2E2", color: G.red, borderRadius: 6, padding: "2px 4px", fontWeight: 700 }}>CLOSED</div>
                          ) : isAppt ? (
                            <div style={{ fontSize: 9, background: "#F3F4F6", color: G.muted, borderRadius: 6, padding: "2px 4px", fontWeight: 600 }}>APPT</div>
                          ) : d.count === 0 ? (
                            <div style={{ fontSize: 10, color: G.muted }}>No data</div>
                          ) : (
                            <Fragment>
                              <div style={{ fontSize: 11, fontWeight: 700, color: G.mid }}>{fmt(d.avgRevenue)}</div>
                              <div style={{ fontSize: 10, color: G.muted }}>{d.count} day{d.count !== 1 ? "s" : ""}</div>
                            </Fragment>
                          )}
                        </div>
                      );
                    })}
                  </div>

                  {/* Detailed table */}
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                    <thead>
                      <tr style={{ background: G.dark, color: G.goldL }}>
                        {["Day","Status","Days of Data","Avg Revenue","Avg Profit","Total Revenue","Total Profit"].map(h => (
                          <th key={h} style={{ padding: "8px 12px", textAlign: "left", fontWeight: 600, whiteSpace: "nowrap" }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {dayOfWeekStats.map((d, i) => {
                        const isClosed = d.day === 1;
                        const isAppt   = d.day === 0;
                        const isBest   = busiest != null && d.day === busiest.day;
                        return (
                          <tr key={d.day} style={{ background: isBest ? "#FFFBEB" : i % 2 === 0 ? "#F9FBFA" : G.card, borderBottom: "1px solid #F0F0F0" }}>
                            <td style={{ padding: "8px 12px", fontWeight: 700, color: G.dark }}>
                              {isBest && <span style={{ marginRight: 6 }}>⭐</span>}{d.name}
                            </td>
                            <td style={{ padding: "8px 12px" }}>
                              {isClosed ? (
                                <span style={{ background: "#FEE2E2", color: G.red, borderRadius: 10, padding: "2px 9px", fontSize: 11, fontWeight: 700 }}>🔴 Closed</span>
                              ) : isAppt ? (
                                <span style={{ background: "#F3F4F6", color: G.muted, borderRadius: 10, padding: "2px 9px", fontSize: 11, fontWeight: 600 }}>📞 Appt Only</span>
                              ) : (
                                <span style={{ background: "#D1FAE5", color: G.mid, borderRadius: 10, padding: "2px 9px", fontSize: 11, fontWeight: 600 }}>✅ Open</span>
                              )}
                            </td>
                            <td style={{ padding: "8px 12px", color: G.muted }}>{d.count > 0 ? d.count : "—"}</td>
                            <td style={{ padding: "8px 12px", fontWeight: 600, color: isClosed || isAppt ? G.muted : G.mid }}>{d.count > 0 ? fmt(d.avgRevenue) : "—"}</td>
                            <td style={{ padding: "8px 12px", color: isClosed || isAppt ? G.muted : d.avgProfit >= 0 ? G.mid : G.red }}>{d.count > 0 ? fmt(d.avgProfit) : "—"}</td>
                            <td style={{ padding: "8px 12px", color: G.muted }}>{d.count > 0 ? fmt(d.revenue) : "—"}</td>
                            <td style={{ padding: "8px 12px", color: G.muted }}>{d.count > 0 ? fmt(d.profit) : "—"}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>

                  {/* Insight */}
                  {busiest != null && busiest.count > 0 && (
                    <div style={{ marginTop: 14, background: "#FFFBEB", borderRadius: 10, padding: "12px 16px", fontSize: 13, color: G.dark, borderLeft: `3px solid ${G.gold}` }}>
                      💡 <strong>{busiest.name}</strong> is your busiest day with an average of <strong>{fmt(busiest.avgRevenue)}</strong> in revenue.
                      {(() => {
                        const qdArr = opDays.filter(d => d.count > 0); const quietest = qdArr.length > 0 ? qdArr.reduce((a, b) => a.avgRevenue < b.avgRevenue ? a : b) : null;
                        return quietest && quietest.day !== busiest.day
                          ? <span>&nbsp;<strong>{quietest.name}</strong> is the slowest open day at <strong>{fmt(quietest.avgRevenue)}</strong> avg — consider promotions or lighter staffing.</span>
                          : null;
                      })()}
                    </div>
                  )}
                </Fragment>
              );
            })()}
          </div>

          {/* Margin dip alerts */}
          <div style={{ background: G.card, borderRadius: 14, padding: "20px 22px", marginBottom: 24, boxShadow: "0 1px 6px #0001" }}>
            <div style={{ fontWeight: 700, color: G.dark, fontSize: 15, marginBottom: 4 }}>⚠️ Margin Dip Alerts</div>
            <div style={{ color: G.muted, fontSize: 12, marginBottom: 16 }}>Days where margin dropped below {MARGIN_THRESHOLD}% — needs your attention</div>
            {marginAlerts.length === 0 ? (
              <div style={{ color: G.mid, fontWeight: 600, padding: "16px 0" }}>✅ No margin dips detected — all days are above {MARGIN_THRESHOLD}%</div>
            ) : (
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr style={{ background: G.dark, color: G.goldL }}>
                    {["Date","Revenue","Cost","Profit","Margin","Status"].map(h => (
                      <th key={h} style={{ padding: "8px 12px", textAlign: "left", fontWeight: 600 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {marginAlerts.map((r, i) => {
                    const m = parseFloat(r.margin);
                    const status = m < 0 ? { label: "🔴 Loss day", bg: "#FEE2E2", color: G.red }
                      : m < 10 ? { label: "🔴 Critical", bg: "#FEE2E2", color: G.red }
                      : { label: "⚠️ Low margin", bg: "#FEF3C7", color: "#92400E" };
                    return (
                      <tr key={r.date} style={{ background: i % 2 === 0 ? "#FFF9F9" : G.card, borderBottom: "1px solid #FEE2E2" }}>
                        <td style={{ padding: "8px 12px", fontWeight: 600 }}>{r.date}</td>
                        <td style={{ padding: "8px 12px" }}>{fmt(r.revenue)}</td>
                        <td style={{ padding: "8px 12px", color: G.muted }}>{fmt(r.cost)}</td>
                        <td style={{ padding: "8px 12px", fontWeight: 700, color: r.profit < 0 ? G.red : G.ink }}>{fmt(r.profit)}</td>
                        <td style={{ padding: "8px 12px", fontWeight: 700, color: G.red }}>{r.margin}%</td>
                        <td style={{ padding: "8px 12px" }}>
                          <span style={{ background: status.bg, color: status.color, borderRadius: 12, padding: "3px 10px", fontSize: 11, fontWeight: 700 }}>{status.label}</span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>

          {/* Repeat customer rate */}
          <div style={{ background: G.card, borderRadius: 14, padding: "20px 22px", marginBottom: 24, boxShadow: "0 1px 6px #0001" }}>
            <div style={{ fontWeight: 700, color: G.dark, fontSize: 15, marginBottom: 4 }}>👤 Customer Loyalty</div>
            <div style={{ color: G.muted, fontSize: 12, marginBottom: 18 }}>All-time · New vs returning customer breakdown</div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 12, marginBottom: 20 }}>
              {[
                { label: "Total Customers", val: customerStats.total, color: G.dark },
                { label: "New Customers",   val: `★ ${customerStats.newCust}`, color: G.mid },
                { label: "Returning",        val: `↩ ${customerStats.returning}`, color: "#1D4ED8" },
                { label: "Retention Rate",   val: `${customerStats.retPct}%`, color: parseInt(customerStats.retPct) >= 35 ? G.mid : G.gold },
              ].map(({ label, val, color }) => (
                <div key={label} style={{ background: "#F9FBFA", borderRadius: 10, padding: "12px 14px" }}>
                  <div style={{ color: G.muted, fontSize: 11 }}>{label}</div>
                  <div style={{ fontSize: 20, fontWeight: 700, color, marginTop: 4 }}>{val}</div>
                </div>
              ))}
            </div>

            {/* Revenue split bar */}
            {customerStats.totalRev > 0 && (
              <div style={{ marginBottom: 20 }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 6 }}>
                  <span style={{ color: G.mid, fontWeight: 600 }}>★ New — {fmt(customerStats.newRevenue)} ({100 - parseInt(customerStats.retRevPct)}%)</span>
                  <span style={{ color: "#1D4ED8", fontWeight: 600 }}>↩ Returning — {fmt(customerStats.retRevenue)} ({customerStats.retRevPct}%)</span>
                </div>
                <div style={{ display: "flex", borderRadius: 8, overflow: "hidden", height: 16 }}>
                  <div style={{ width: `${100 - parseInt(customerStats.retRevPct)}%`, background: G.light }} />
                  <div style={{ width: `${customerStats.retRevPct}%`, background: "#1D4ED8" }} />
                </div>
                <div style={{ marginTop: 10, background: "#F0F7F3", borderRadius: 8, padding: "10px 14px", fontSize: 13, color: G.dark, borderLeft: `3px solid ${G.gold}` }}>
                  💡 {parseInt(customerStats.retRevPct) >= 35
                    ? `Strong loyalty — ${customerStats.retRevPct}% of revenue comes from returning customers. Above the 35% industry benchmark.`
                    : `${customerStats.retRevPct}% of revenue from returning customers. Industry benchmark is 35% — focus on bringing customers back.`}
                </div>
              </div>
            )}

            {/* Top customers table */}
            {customerStats.top.length > 0 && (
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr style={{ background: G.dark, color: G.goldL }}>
                    {["#","Customer","Revenue","Profit","Visits","Type"].map(h => (
                      <th key={h} style={{ padding: "7px 12px", textAlign: "left", fontWeight: 600 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {customerStats.top.map((c, i) => (
                    <tr key={c.name} style={{ background: i % 2 === 0 ? "#F9FBFA" : G.card, borderBottom: "1px solid #F0F0F0" }}>
                      <td style={{ padding: "7px 12px", color: G.muted, fontWeight: 700 }}>{i+1}</td>
                      <td style={{ padding: "7px 12px", fontWeight: 600 }}>{c.name}</td>
                      <td style={{ padding: "7px 12px", color: G.mid }}>{fmt(c.revenue)}</td>
                      <td style={{ padding: "7px 12px", fontWeight: 600, color: c.profit >= 0 ? G.mid : G.red }}>{fmt(c.profit)}</td>
                      <td style={{ padding: "7px 12px", color: G.muted }}>{c.visits}</td>
                      <td style={{ padding: "7px 12px" }}>
                        <span style={{
                          fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 10,
                          background: c.isRepeat ? "#DBEAFE" : "#D1FAE5",
                          color: c.isRepeat ? "#1D4ED8" : G.mid
                        }}>{c.isRepeat ? "↩ Returning" : "★ New"}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* Best selling items */}
          <div style={{ background: G.card, borderRadius: 14, padding: "20px 22px", marginBottom: 24, boxShadow: "0 1px 6px #0001" }}>
            <div style={{ fontWeight: 700, color: G.dark, fontSize: 15, marginBottom: 4 }}>🏆 Top 10 Items by Profit</div>
            <div style={{ color: G.muted, fontSize: 12, marginBottom: 16 }}>All-time · Your most valuable products</div>
            {topItems.length === 0 ? (
              <div style={{ color: G.muted, padding: "16px 0" }}>No item data yet — import a CSV to see rankings.</div>
            ) : (
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr style={{ background: G.dark, color: G.goldL }}>
                    {["#","Item","Category","Revenue","Cost","Profit","Margin","Units"].map(h => (
                      <th key={h} style={{ padding: "8px 12px", textAlign: "left", fontWeight: 600, whiteSpace: "nowrap" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {topItems.map((item, i) => (
                    <tr key={item.name} style={{ background: i % 2 === 0 ? "#F9FBFA" : G.card, borderBottom: "1px solid #F0F0F0" }}>
                      <td style={{ padding: "8px 12px", fontWeight: 700, color: i === 0 ? G.gold : G.muted }}>{i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : i+1}</td>
                      <td style={{ padding: "8px 12px", maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 600 }} title={item.name}>{item.name}</td>
                      <td style={{ padding: "8px 12px" }}>
                        <span style={{ background: "#F0F7F3", color: G.mid, borderRadius: 8, padding: "2px 8px", fontSize: 11, fontWeight: 600 }}>{item.category || "—"}</span>
                      </td>
                      <td style={{ padding: "8px 12px", color: G.mid }}>{fmt(item.revenue)}</td>
                      <td style={{ padding: "8px 12px", color: G.muted }}>{fmt(item.cost)}</td>
                      <td style={{ padding: "8px 12px", fontWeight: 700, color: item.profit >= 0 ? G.mid : G.red }}>{fmt(item.profit)}</td>
                      <td style={{ padding: "8px 12px" }}>
                        <span style={{ ...marginBadge(parseFloat(item.margin)), borderRadius: 12, padding: "2px 8px", fontSize: 11, fontWeight: 700 }}>{item.margin}%</span>
                      </td>
                      <td style={{ padding: "8px 12px", color: G.muted }}>{item.qty}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* 3-Way Channel Comparison */}
          <div style={{ background: G.card, borderRadius: 14, padding: "20px 22px", marginBottom: 24, boxShadow: "0 1px 6px #0001" }}>
            <div style={{ fontWeight: 700, color: G.dark, fontSize: 15, marginBottom: 4 }}>🏪 In-Store &nbsp;vs&nbsp; 🌐 Online &nbsp;vs&nbsp; 📦 Bulk Orders</div>
            <div style={{ color: G.muted, fontSize: 12, marginBottom: 20 }}>All channel performance for selected period</div>

            {(() => {
              const inStore = channelStats ? channelStats.channels.find(c => c.name === "In-Store") : null;
              const online  = channelStats ? channelStats.channels.find(c => c.name === "Online")   : null;
              const allRev  = ((inStore ? inStore.revenue : 0)) + ((online ? online.revenue : 0)) + bulkStats.totalRev;

              const channels3 = [
                { name: "In-Store", icon: "🏪", color: G.mid,      bg: "#F0FDF4", revenue: (inStore ? inStore.revenue : 0), profit: (inStore ? inStore.profit : 0), margin: (inStore ? inStore.margin : "0.0"), qty: (inStore ? inStore.qty : 0), extra: null },
                { name: "Online",   icon: "🌐", color: "#1D4ED8",  bg: "#EFF6FF", revenue: (online ? online.revenue : 0),  profit: (online ? online.profit : 0),  margin: (online ? online.margin : "0.0"),  qty: (online ? online.qty : 0),  extra: null },
                { name: "Bulk",     icon: "📦", color: "#7C3AED",  bg: "#F5F3FF", revenue: bulkStats.totalRev,  profit: bulkStats.totalProfit, margin: bulkStats.margin, qty: bulkStats.total, extra: bulkStats.pendingRev > 0 ? `⏳ ${fmt(bulkStats.pendingRev)} outstanding` : null },
              ];

              return (
                <Fragment>
                  {/* 3 KPI cards */}
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 14, marginBottom: 20 }}>
                    {channels3.map(ch => {
                      const revPct = allRev > 0 ? ((ch.revenue / allRev) * 100).toFixed(0) : 0;
                      return (
                        <div key={ch.name} style={{ background: ch.bg, borderRadius: 12, padding: "18px 16px", border: `1px solid ${ch.color}22` }}>
                          <div style={{ fontSize: 24, marginBottom: 6 }}>{ch.icon}</div>
                          <div style={{ fontWeight: 800, fontSize: 15, color: ch.color, marginBottom: 12 }}>{ch.name}</div>
                          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 12 }}>
                            {[
                              { label: ch.name === "Bulk" ? "Orders" : "Units", val: ch.qty },
                              { label: "Revenue",  val: fmt(ch.revenue) },
                              { label: "Profit",   val: fmt(ch.profit), alert: ch.profit < 0 },
                              { label: "Margin",   val: `${ch.margin}%` },
                            ].map(({ label, val, alert }) => (
                              <div key={label}>
                                <div style={{ fontSize: 10, color: G.muted, fontWeight: 600, textTransform: "uppercase" }}>{label}</div>
                                <div style={{ fontSize: 14, fontWeight: 700, color: alert ? G.red : ch.color }}>{val}</div>
                              </div>
                            ))}
                          </div>
                          {/* Revenue share bar */}
                          <div style={{ marginBottom: ch.extra ? 8 : 0 }}>
                            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: G.muted, marginBottom: 4 }}>
                              <span>Revenue share</span><span style={{ fontWeight: 700, color: ch.color }}>{revPct}%</span>
                            </div>
                            <div style={{ background: "#E5E7EB", borderRadius: 4, height: 6 }}>
                              <div style={{ width: `${revPct}%`, height: "100%", borderRadius: 4, background: ch.color }} />
                            </div>
                          </div>
                          {ch.extra && <div style={{ fontSize: 11, color: "#D97706", fontWeight: 600, marginTop: 6 }}>{ch.extra}</div>}
                        </div>
                      );
                    })}
                  </div>

                  {/* Combined revenue bar */}
                  {allRev > 0 && (
                    <div style={{ marginBottom: 20 }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: G.dark, marginBottom: 6 }}>Revenue split across all channels</div>
                      <div style={{ display: "flex", borderRadius: 8, overflow: "hidden", height: 20 }}>
                        {channels3.map(ch => {
                          const pct = allRev > 0 ? (ch.revenue / allRev) * 100 : 0;
                          return pct > 0 ? (
                            <div key={ch.name} style={{ width: `${pct}%`, background: ch.color, display: "flex", alignItems: "center", justifyContent: "center" }}>
                              {pct > 8 && <span style={{ fontSize: 10, color: "#fff", fontWeight: 700 }}>{ch.icon} {pct.toFixed(0)}%</span>}
                            </div>
                          ) : null;
                        })}
                      </div>
                      <div style={{ display: "flex", gap: 16, marginTop: 8 }}>
                        {channels3.map(ch => (
                          <div key={ch.name} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11 }}>
                            <div style={{ width: 10, height: 10, borderRadius: "50%", background: ch.color }} />
                            <span style={{ color: G.muted }}>{ch.name}: {fmt(ch.revenue)}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

              {/* Insight strip */}
              {(() => {
                const inStore = channelStats ? channelStats.channels.find(c => c.name === "In-Store") : null;
                const online  = channelStats ? channelStats.channels.find(c => c.name === "Online")   : null;
                const ch3 = [
                  { name: "In-Store", revenue: (inStore ? inStore.revenue : 0), margin: parseFloat(inStore ? inStore.margin : 0) },
                  { name: "Online",   revenue: (online ? online.revenue : 0),  margin: parseFloat(online ? online.margin : 0)  },
                  { name: "Bulk",     revenue: bulkStats.totalRev,  margin: parseFloat(bulkStats.margin)   },
                ].filter(c => c.revenue > 0);
                if (ch3.length === 0) return null;
                const biggest = [...ch3].sort((a,b) => b.revenue - a.revenue)[0];
                const bestMargin = [...ch3].sort((a,b) => b.margin - a.margin)[0];
                return (
                  <div style={{ marginTop: 14, background: "#F0F7F3", borderRadius: 10, padding: "12px 16px", fontSize: 13, color: G.dark, borderLeft: `3px solid ${G.gold}` }}>
                    💡 <strong>{biggest.name}</strong> drives the most revenue.
                    &nbsp;<strong>{bestMargin.name}</strong> has the best margin at <strong>{bestMargin.margin.toFixed(1)}%</strong>.
                    {bulkStats.pendingRev > 0 && <span> &nbsp;⏳ <strong>{fmt(bulkStats.pendingRev)}</strong> in outstanding bulk payments to collect.</span>}
                  </div>
                );
              })()}
                </Fragment>
              );
            })()}
          </div>

          {/* Category Leaders */}
          <div style={{ background: G.card, borderRadius: 14, padding: "20px 22px", marginBottom: 24, boxShadow: "0 1px 6px #0001" }}>
            <div style={{ fontWeight: 700, color: G.dark, fontSize: 15, marginBottom: 4 }}>🏅 Category Leaders</div>
            <div style={{ color: G.muted, fontSize: 12, marginBottom: 20 }}>Which category wins on quantity, revenue, and profit</div>

            {!categoryLeaders ? (
              <div style={{ color: G.muted, padding: "16px 0" }}>No item data yet — import a CSV to see category leaders.</div>
            ) : (
              <Fragment>
                {/* Trophy cards */}
                <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 14, marginBottom: 24 }}>
                  {[
                    { icon: "📦", label: "Most Units Sold", cat: categoryLeaders.byQty,     val: `${categoryLeaders.byQty.qty} units`,        color: "#7C3AED", bg: "#F5F3FF" },
                    { icon: "💰", label: "Highest Revenue",  cat: categoryLeaders.byRevenue, val: fmt(categoryLeaders.byRevenue.revenue),       color: G.mid,    bg: "#F0FDF4" },
                    { icon: "💎", label: "Highest Profit",   cat: categoryLeaders.byProfit,  val: fmt(categoryLeaders.byProfit.profit),         color: G.gold,   bg: "#FFFBEB" },
                  ].map(({ icon, label, cat, val, color, bg }) => (
                    <div key={label} style={{ background: bg, borderRadius: 12, padding: "18px 16px", border: `1px solid ${color}22` }}>
                      <div style={{ fontSize: 28, marginBottom: 8 }}>{icon}</div>
                      <div style={{ fontSize: 11, color: G.muted, fontWeight: 600, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</div>
                      <div style={{ fontSize: 18, fontWeight: 800, color, marginBottom: 4 }}>{cat.cat}</div>
                      <div style={{ fontSize: 20, fontWeight: 700, color: G.dark }}>{val}</div>
                    </div>
                  ))}
                </div>

                {/* Full category breakdown table */}
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: G.dark, color: G.goldL }}>
                      {["Category","Units Sold","Revenue","Profit","Top Metric"].map(h => (
                        <th key={h} style={{ padding: "8px 12px", textAlign: "left", fontWeight: 600 }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {categoryLeaders.all.map((cat, i) => {
                      const isQtyLeader = cat.cat === categoryLeaders.byQty.cat;
                      const isRevLeader = cat.cat === categoryLeaders.byRevenue.cat;
                      const isProfLeader = cat.cat === categoryLeaders.byProfit.cat;
                      return (
                        <tr key={cat.cat} style={{ background: i % 2 === 0 ? "#F9FBFA" : G.card, borderBottom: "1px solid #F0F0F0" }}>
                          <td style={{ padding: "9px 12px", fontWeight: 700 }}>
                            <span style={{ display: "inline-block", width: 10, height: 10, borderRadius: "50%", background: CAT_COLORS[i % CAT_COLORS.length], marginRight: 8 }} />
                            {cat.cat}
                          </td>
                          <td style={{ padding: "9px 12px" }}>
                            <span style={{ fontWeight: isQtyLeader ? 700 : 400, color: isQtyLeader ? "#7C3AED" : G.ink }}>
                              {isQtyLeader && "📦 "}{cat.qty}
                            </span>
                          </td>
                          <td style={{ padding: "9px 12px" }}>
                            <span style={{ fontWeight: isRevLeader ? 700 : 400, color: isRevLeader ? G.mid : G.ink }}>
                              {isRevLeader && "💰 "}{fmt(cat.revenue)}
                            </span>
                          </td>
                          <td style={{ padding: "9px 12px" }}>
                            <span style={{ fontWeight: isProfLeader ? 700 : 400, color: isProfLeader ? G.gold : cat.profit >= 0 ? G.ink : G.red }}>
                              {isProfLeader && "💎 "}{fmt(cat.profit)}
                            </span>
                          </td>
                          <td style={{ padding: "9px 12px" }}>
                            <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                              {isQtyLeader  && <span style={{ background: "#F5F3FF", color: "#7C3AED", borderRadius: 10, padding: "2px 8px", fontSize: 10, fontWeight: 700 }}>📦 Most Units</span>}
                              {isRevLeader  && <span style={{ background: "#D1FAE5", color: G.mid,     borderRadius: 10, padding: "2px 8px", fontSize: 10, fontWeight: 700 }}>💰 Top Revenue</span>}
                              {isProfLeader && <span style={{ background: "#FEF3C7", color: "#92400E", borderRadius: 10, padding: "2px 8px", fontSize: 10, fontWeight: 700 }}>💎 Top Profit</span>}
                              {!isQtyLeader && !isRevLeader && !isProfLeader && <span style={{ color: G.muted, fontSize: 11 }}>—</span>}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>

                {/* Insight */}
                {categoryLeaders.byProfit.cat !== categoryLeaders.byRevenue.cat && (
                  <div style={{ marginTop: 14, background: "#FFFBEB", borderRadius: 10, padding: "12px 16px", fontSize: 13, color: G.dark, borderLeft: `3px solid ${G.gold}` }}>
                    💡 <strong>{categoryLeaders.byRevenue.cat}</strong> brings in the most revenue ({fmt(categoryLeaders.byRevenue.revenue)}) but <strong>{categoryLeaders.byProfit.cat}</strong> is actually more profitable ({fmt(categoryLeaders.byProfit.profit)}). Consider pushing <strong>{categoryLeaders.byProfit.cat}</strong> more.
                  </div>
                )}
              </Fragment>
            )}
          </div>

        </div>
      )}

      {/* ── BULK ORDERS TAB ── */}
      {activeTab === "bulk" && (
        <div style={{ maxWidth: 980, margin: "0 auto", padding: "24px 16px" }}>

          {/* KPI strip */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 14, marginBottom: 24 }}>
            {[
              { label: "Total Bulk Revenue", val: fmt(bulkStats.totalRev),    color: G.mid },
              { label: "Total Bulk Profit",  val: fmt(bulkStats.totalProfit), color: bulkStats.totalProfit >= 0 ? G.mid : G.red },
              { label: "Avg Margin",         val: `${bulkStats.margin}%`,     color: G.dark },
              { label: "Pending / Partial",  val: fmt(bulkStats.pendingRev),  color: bulkStats.pendingRev > 0 ? "#D97706" : G.mid },
            ].map(({ label, val, color }) => (
              <div key={label} style={{ background: G.card, borderRadius: 14, padding: "16px 18px", boxShadow: "0 1px 6px #0001", borderTop: `3px solid ${color}` }}>
                <div style={{ color: G.muted, fontSize: 11, marginBottom: 6 }}>{label}</div>
                <div style={{ fontSize: 20, fontWeight: 700, color }}>{val}</div>
              </div>
            ))}
          </div>

          {/* Status badge summary */}
          <div style={{ display: "flex", gap: 10, marginBottom: 20, flexWrap: "wrap" }}>
            {[
              { label: `✅ Paid — ${bulkStats.paid} orders`,    bg: "#D1FAE5", color: G.mid },
              { label: `⏳ Pending — ${bulkStats.pending} orders`, bg: "#FEF3C7", color: "#92400E" },
              { label: `🔄 Partial — ${bulkStats.partial} orders`, bg: "#DBEAFE", color: "#1D4ED8" },
            ].map(({ label, bg, color }) => (
              <div key={label} style={{ background: bg, color, borderRadius: 20, padding: "5px 14px", fontSize: 12, fontWeight: 700 }}>{label}</div>
            ))}
            <button onClick={() => { setShowBulkForm(true); setEditingBulk(null); setBulkForm({ date: TODAY, club: "", items: "", qty: "", revenue: "", cost: "", status: "Paid", notes: "" }); }}
              style={{ marginLeft: "auto", padding: "6px 18px", background: G.gold, color: G.dark, border: "none", borderRadius: 20, fontWeight: 700, cursor: "pointer", fontSize: 13 }}>
              + New Bulk Order
            </button>
          </div>

          {/* Entry form */}
          {showBulkForm && (
            <div style={{ background: G.dark, borderRadius: 14, padding: "20px 22px", marginBottom: 24 }}>
              <div style={{ color: G.goldL, fontWeight: 700, fontSize: 14, marginBottom: 16 }}>
                {editingBulk !== null ? "✏️ Edit Bulk Order" : "➕ New Bulk Order"}
              </div>
              {/* Basic info */}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 12, marginBottom: 12 }}>
                {[
                  { label: "Date *", key: "date", type: "date" },
                  { label: "Club / Academy *", key: "club", type: "text", placeholder: "e.g. San Diego Cricket Club" },
                  { label: "Items Description", key: "items", type: "text", placeholder: "e.g. 10x Kaziranga V1 Bats" },
                  { label: "Total Qty", key: "qty", type: "number", placeholder: "e.g. 10" },
                  { label: "Invoice Revenue ($) *", key: "revenue", type: "number", placeholder: "e.g. 2500" },
                ].map(({ label, key, type, placeholder }) => (
                  <div key={key}>
                    <div style={{ color: "#94A89A", fontSize: 12, marginBottom: 5 }}>{label}</div>
                    <input type={type} value={bulkForm[key]} placeholder={placeholder}
                      onChange={e => setBulkForm(p => ({ ...p, [key]: e.target.value }))}
                      style={{ width: "100%", padding: "8px 11px", borderRadius: 8, border: `1px solid ${G.mid}`, background: "#1F4535", color: "#E8F5EE", fontSize: 13, outline: "none", boxSizing: "border-box" }} />
                  </div>
                ))}
              </div>

              {/* Itemized costs */}
              <div style={{ borderTop: `1px solid ${G.mid}`, paddingTop: 14, marginBottom: 12 }}>
                <div style={{ color: G.goldL, fontSize: 12, fontWeight: 600, marginBottom: 10 }}>💸 Cost Breakdown</div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 12 }}>
                  {[
                    { label: "Cost of Goods ($)", key: "costGoods",     placeholder: "e.g. 900" },
                    { label: "Shipping ($)",       key: "costShipping",  placeholder: "e.g. 85" },
                    { label: "Packaging ($)",      key: "costPackaging", placeholder: "e.g. 20" },
                    { label: "Tax ($)",            key: "costTax",       placeholder: "e.g. 45" },
                    { label: "Other Cost ($)",     key: "costOther",     placeholder: "e.g. 30" },
                    { label: "Other Cost Label",   key: "costOtherLabel",placeholder: "e.g. Custom engraving", type: "text" },
                  ].map(({ label, key, placeholder, type }) => (
                    <div key={key}>
                      <div style={{ color: "#94A89A", fontSize: 12, marginBottom: 5 }}>{label}</div>
                      <input type={type || "number"} value={bulkForm[key]} placeholder={placeholder}
                        onChange={e => setBulkForm(p => ({ ...p, [key]: e.target.value }))}
                        style={{ width: "100%", padding: "8px 11px", borderRadius: 8, border: `1px solid ${G.mid}`, background: "#1F4535", color: "#E8F5EE", fontSize: 13, outline: "none", boxSizing: "border-box" }} />
                    </div>
                  ))}
                </div>
                {/* Live cost total */}
                {(bulkForm.costGoods || bulkForm.costShipping || bulkForm.costPackaging || bulkForm.costTax || bulkForm.costOther) && (
                  <div style={{ marginTop: 10, background: "#1F4535", borderRadius: 8, padding: "8px 12px", fontSize: 13 }}>
                    <div style={{ display: "flex", gap: 16, flexWrap: "wrap", color: "#94A89A" }}>
                      {[
                        { label: "Goods", val: parseFloat(bulkForm.costGoods)||0 },
                        { label: "Shipping", val: parseFloat(bulkForm.costShipping)||0 },
                        { label: "Packaging", val: parseFloat(bulkForm.costPackaging)||0 },
                        { label: "Tax", val: parseFloat(bulkForm.costTax)||0 },
                        { label: bulkForm.costOtherLabel || "Other", val: parseFloat(bulkForm.costOther)||0 },
                      ].filter(c => c.val > 0).map(c => (
                        <span key={c.label}>{c.label}: <strong style={{ color: "#E8F5EE" }}>{fmt(c.val)}</strong></span>
                      ))}
                      <span style={{ marginLeft: "auto", color: G.goldL, fontWeight: 700 }}>
                        Total Cost: {fmt((parseFloat(bulkForm.costGoods)||0)+(parseFloat(bulkForm.costShipping)||0)+(parseFloat(bulkForm.costPackaging)||0)+(parseFloat(bulkForm.costTax)||0)+(parseFloat(bulkForm.costOther)||0))}
                      </span>
                    </div>
                  </div>
                )}
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: 12, marginBottom: 16 }}>
                <div>
                  <div style={{ color: "#94A89A", fontSize: 12, marginBottom: 5 }}>Payment Status</div>
                  <select value={bulkForm.status} onChange={e => setBulkForm(p => ({ ...p, status: e.target.value }))}
                    style={{ width: "100%", padding: "8px 11px", borderRadius: 8, border: `1px solid ${G.mid}`, background: "#1F4535", color: "#E8F5EE", fontSize: 13, outline: "none" }}>
                    <option>Paid</option>
                    <option>Pending</option>
                    <option>Partial</option>
                  </select>
                </div>
                <div>
                  <div style={{ color: "#94A89A", fontSize: 12, marginBottom: 5 }}>Notes</div>
                  <input type="text" value={bulkForm.notes} placeholder="e.g. 50% deposit received, balance due July 1"
                    onChange={e => setBulkForm(p => ({ ...p, notes: e.target.value }))}
                    style={{ width: "100%", padding: "8px 11px", borderRadius: 8, border: `1px solid ${G.mid}`, background: "#1F4535", color: "#E8F5EE", fontSize: 13, outline: "none", boxSizing: "border-box" }} />
                </div>
              </div>
              {bulkForm.revenue && (
                <div style={{ color: G.light, fontSize: 13, marginBottom: 12 }}>
                  {(() => {
                    const rev = parseFloat(bulkForm.revenue)||0;
                    const totalC = (parseFloat(bulkForm.costGoods)||0)+(parseFloat(bulkForm.costShipping)||0)+(parseFloat(bulkForm.costPackaging)||0)+(parseFloat(bulkForm.costTax)||0)+(parseFloat(bulkForm.costOther)||0);
                    const profit = rev - totalC;
                    return (
                      <span>Estimated profit: <strong style={{ color: profit >= 0 ? G.goldL : G.red }}>{fmt(profit)}</strong>
                      &nbsp;({rev > 0 ? ((profit/rev)*100).toFixed(1) : 0}% margin)</span>
                    );
                  })()}
                </div>
              )}
              <div style={{ display: "flex", gap: 10 }}>
                <button onClick={saveBulkOrder} style={{ padding: "9px 24px", background: G.gold, color: G.dark, fontWeight: 700, border: "none", borderRadius: 8, cursor: "pointer", fontSize: 14 }}>
                  {editingBulk !== null ? "Update Order" : "Save Order"}
                </button>
                <button onClick={() => { setShowBulkForm(false); setEditingBulk(null); }}
                  style={{ padding: "9px 18px", background: "transparent", color: "#94A89A", border: "1px solid #2D4A3A", borderRadius: 8, cursor: "pointer", fontSize: 13 }}>Cancel</button>
              </div>
            </div>
          )}

          {/* Orders table */}
          <div style={{ background: G.card, borderRadius: 14, padding: "20px 22px", boxShadow: "0 1px 6px #0001" }}>
            <div style={{ fontWeight: 700, color: G.dark, marginBottom: 16 }}>All Bulk Orders</div>
            {filteredBulkOrders.length === 0 ? (
              <div style={{ textAlign: "center", padding: "32px 0", color: G.muted }}>
                <div style={{ fontSize: 36, marginBottom: 10 }}>📦</div>
                <div style={{ fontWeight: 600 }}>No bulk orders yet</div>
                <div style={{ fontSize: 13, marginTop: 6 }}>Click "+ New Bulk Order" to log your first one</div>
              </div>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: G.dark, color: G.goldL }}>
                      {["Date","Club / Academy","Items","Qty","Revenue","Cost Breakdown","Profit","Margin","Status","Notes",""].map(h => (
                        <th key={h} style={{ padding: "8px 12px", textAlign: "left", fontWeight: 600, whiteSpace: "nowrap" }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {filteredBulkOrders.map((o, i) => {
                      const margin = o.revenue > 0 ? ((o.profit / o.revenue) * 100).toFixed(1) : "0.0";
                      const statusStyle = o.status === "Paid"
                        ? { bg: "#D1FAE5", color: G.mid, icon: "✅" }
                        : o.status === "Pending"
                        ? { bg: "#FEF3C7", color: "#92400E", icon: "⏳" }
                        : { bg: "#DBEAFE", color: "#1D4ED8", icon: "🔄" };
                      return (
                        <tr key={o.id} style={{ background: i % 2 === 0 ? "#F9FBFA" : G.card, borderBottom: "1px solid #F0F0F0" }}>
                          <td style={{ padding: "9px 12px", fontWeight: 600, whiteSpace: "nowrap" }}>{o.date}</td>
                          <td style={{ padding: "9px 12px", fontWeight: 700, color: G.dark }}>{o.club}</td>
                          <td style={{ padding: "9px 12px", color: G.muted, maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={o.items}>{o.items || "—"}</td>
                          <td style={{ padding: "9px 12px", color: G.muted }}>{o.qty || "—"}</td>
                          <td style={{ padding: "9px 12px", color: G.mid, fontWeight: 600 }}>{fmt(o.revenue)}</td>
                          <td style={{ padding: "9px 12px" }}>
                            <div style={{ fontSize: 12, color: G.muted }}>
                              <div style={{ fontWeight: 700, color: G.dark, marginBottom: 2 }}>{fmt(o.cost)}</div>
                              {o.costGoods    > 0 && <div>Goods: {fmt(o.costGoods)}</div>}
                              {o.costShipping > 0 && <div>Shipping: {fmt(o.costShipping)}</div>}
                              {o.costPackaging> 0 && <div>Packaging: {fmt(o.costPackaging)}</div>}
                              {o.costTax      > 0 && <div>Tax: {fmt(o.costTax)}</div>}
                              {o.costOther    > 0 && <div>{o.costOtherLabel || "Other"}: {fmt(o.costOther)}</div>}
                            </div>
                          </td>
                          <td style={{ padding: "9px 12px", fontWeight: 700, color: o.profit >= 0 ? G.mid : G.red }}>{fmt(o.profit)}</td>
                          <td style={{ padding: "9px 12px" }}>
                            <span style={{ ...marginBadge(parseFloat(margin)), borderRadius: 12, padding: "2px 8px", fontSize: 11, fontWeight: 600 }}>{margin}%</span>
                          </td>
                          <td style={{ padding: "9px 12px" }}>
                            <span style={{ background: statusStyle.bg, color: statusStyle.color, borderRadius: 12, padding: "3px 10px", fontSize: 11, fontWeight: 700 }}>
                              {statusStyle.icon} {o.status}
                            </span>
                          </td>
                          <td style={{ padding: "9px 12px", color: G.muted, fontSize: 12, maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={o.notes}>{o.notes || "—"}</td>
                          <td style={{ padding: "9px 12px", whiteSpace: "nowrap" }}>
                            <button onClick={() => { setEditingBulk(o.id); setBulkForm({ date: o.date, club: o.club, items: o.items||"", qty: o.qty||"", revenue: o.revenue, costGoods: o.costGoods||"", costShipping: o.costShipping||"", costPackaging: o.costPackaging||"", costTax: o.costTax||"", costOther: o.costOther||"", costOtherLabel: o.costOtherLabel||"", status: o.status, notes: o.notes||"" }); setShowBulkForm(true); }}
                              style={{ background: "none", border: "none", cursor: "pointer", fontSize: 14, marginRight: 6 }}>✏️</button>
                            {confirmDeleteId === o.id ? (
                              <span style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
                                <button onClick={() => deleteBulkOrder(o.id)}
                                  style={{ padding: "2px 8px", background: G.red, color: "#fff", border: "none", borderRadius: 6, cursor: "pointer", fontSize: 11, fontWeight: 700 }}>Delete</button>
                                <button onClick={() => setConfirmDeleteId(null)}
                                  style={{ padding: "2px 8px", background: "#F3F4F6", color: G.muted, border: "none", borderRadius: 6, cursor: "pointer", fontSize: 11 }}>Cancel</button>
                              </span>
                            ) : (
                              <button onClick={() => setConfirmDeleteId(o.id)}
                                style={{ background: "none", border: "none", cursor: "pointer", fontSize: 14, color: G.muted }}>🗑</button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr style={{ background: "#F0F7F3", fontWeight: 700 }}>
                      <td colSpan={4} style={{ padding: "10px 12px", color: G.dark }}>TOTAL</td>
                      <td style={{ padding: "10px 12px", color: G.mid }}>{fmt(bulkStats.totalRev)}</td>
                      <td style={{ padding: "10px 12px" }}>
                        <div style={{ fontWeight: 700, color: G.dark }}>{fmt(filteredBulkOrders.reduce((s,o)=>s+o.cost,0))}</div>
                        <div style={{ fontSize: 11, color: G.muted }}>
                          {filteredBulkOrders.reduce((s,o)=>s+(o.costShipping||0),0) > 0 && <span>Ship: {fmt(filteredBulkOrders.reduce((s,o)=>s+(o.costShipping||0),0))} </span>}
                          {filteredBulkOrders.reduce((s,o)=>s+(o.costTax||0),0) > 0 && <span>Tax: {fmt(filteredBulkOrders.reduce((s,o)=>s+(o.costTax||0),0))}</span>}
                        </div>
                      </td>
                      <td style={{ padding: "10px 12px", color: bulkStats.totalProfit>=0?G.mid:G.red }}>{fmt(bulkStats.totalProfit)}</td>
                      <td style={{ padding: "10px 12px", color: G.dark }}>{bulkStats.margin}%</td>
                      <td colSpan={3} style={{ padding: "10px 12px" }}>
                        {bulkStats.pendingRev > 0 && <span style={{ color: "#D97706", fontSize: 12 }}>⏳ {fmt(bulkStats.pendingRev)} outstanding</span>}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── END OF DAY TAB ── */}
      {activeTab === "eod" && (
        <div style={{ maxWidth: 820, margin: "0 auto", padding: "24px 16px" }}>

          {/* Date picker */}
          <div style={{ background: G.dark, borderRadius: 14, padding: "16px 22px", marginBottom: 24, display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
            <div style={{ color: G.goldL, fontWeight: 700, fontSize: 14 }}>🗓 Select Date</div>
            <input type="date" value={reportDate} max={TODAY}
              onChange={e => setReportDate(e.target.value)}
              style={{ padding: "7px 12px", borderRadius: 8, border: `1px solid ${G.mid}`, background: "#1F4535", color: "#E8F5EE", fontSize: 13, outline: "none" }} />
            <button onClick={() => window.print()}
              style={{ marginLeft: "auto", padding: "8px 20px", background: G.gold, color: G.dark, border: "none", borderRadius: 8, fontWeight: 700, cursor: "pointer", fontSize: 13 }}>
              🖨️ Print / Save PDF
            </button>
          </div>

          {/* Report */}
          {(() => {
            const dayData = entries[reportDate];
            if (!dayData) return (
              <div style={{ background: G.card, borderRadius: 14, padding: "40px", textAlign: "center", boxShadow: "0 1px 6px #0001" }}>
                <div style={{ fontSize: 36, marginBottom: 12 }}>📭</div>
                <div style={{ fontWeight: 700, color: G.dark, fontSize: 15, marginBottom: 8 }}>No data for {reportDate}</div>
                <div style={{ color: G.muted, fontSize: 13 }}>Import a CSV for this date or select a different date.</div>
              </div>
            );

            const items      = dayData.items || [];
            const revenue    = dayData.revenue || 0;
            const cost       = dayData.cost    || 0;
            const profit     = dayData.profit  || 0;
            const tax        = dayData.tax     || 0;
            const noSale     = dayData.noSale  || false;

            // Group by category
            const byCat = {};
            items.forEach(item => {
              const cat = item.category || "Uncategorised";
              if (!byCat[cat]) byCat[cat] = { revenue: 0, cost: 0, profit: 0, qty: 0, items: [] };
              byCat[cat].revenue += item.net;
              byCat[cat].cost    += item.cost;
              byCat[cat].profit  += item.profit;
              byCat[cat].qty     += parseInt(item.qty) || 1;
              byCat[cat].items.push(item);
            });

            // Unique customers
            const customers = {};
            items.forEach(item => {
              if (!item.customer) return;
              const key = item.customer.toLowerCase().trim();
              if (!customers[key]) customers[key] = { name: item.customer, repeat: item.repeat, spend: 0, items: 0 };
              customers[key].spend += item.net;
              customers[key].items += 1;
            });

            const dayOfWeek = new Date(reportDate + "T00:00:00").toLocaleDateString("en-US", { weekday: "long" });

            return (
              <div id="eod-report">
                {/* Print styles */}
                <style>{`
                  @media print {
                    body * { visibility: hidden; }
                    #eod-report, #eod-report * { visibility: visible; }
                    #eod-report { position: absolute; left: 0; top: 0; width: 100%; }
                    .no-print { display: none !important; }
                  }
                `}</style>

                {/* Header */}
                <div style={{ background: G.dark, borderRadius: 14, padding: "24px 28px", marginBottom: 20, color: "#fff" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12 }}>
                    <div>
                      <div style={{ fontSize: 22, fontWeight: 800, color: G.goldL, marginBottom: 4 }}>Kaziranga Pro Cricket Outfitters</div>
                      <div style={{ fontSize: 14, color: "#94A89A" }}>End of Day Report</div>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <div style={{ fontSize: 20, fontWeight: 700, color: G.goldL }}>{reportDate}</div>
                      <div style={{ fontSize: 13, color: "#94A89A" }}>{dayOfWeek}</div>
                    </div>
                  </div>
                </div>

                {noSale ? (
                  <div style={{ background: G.card, borderRadius: 14, padding: "32px", textAlign: "center", boxShadow: "0 1px 6px #0001" }}>
                    <div style={{ fontSize: 28, marginBottom: 8 }}>🔕</div>
                    <div style={{ fontWeight: 700, color: G.dark }}>No Sale Day</div>
                    <div style={{ color: G.muted, fontSize: 13, marginTop: 4 }}>This day was marked as no-sale.</div>
                  </div>
                ) : (
                  <div>
                    {/* Summary KPIs */}
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 12, marginBottom: 20 }}>
                      {[
                        { label: "Total Revenue",    val: fmt(revenue), color: G.mid,  sub: "Net sales excl. tax" },
                        { label: "Cost of Goods",    val: fmt(cost),    color: G.muted, sub: "Product cost" },
                        { label: "Tax Collected",    val: fmt(tax),     color: G.gold,  sub: "Remit to CA" },
                        { label: "Net Profit",       val: fmt(profit),  color: profit >= 0 ? G.mid : G.red, sub: `${revenue > 0 ? ((profit/revenue)*100).toFixed(1) : 0}% margin` },
                      ].map(({ label, val, color, sub }) => (
                        <div key={label} style={{ background: G.card, borderRadius: 12, padding: "16px", boxShadow: "0 1px 4px #0001", borderTop: `3px solid ${color}` }}>
                          <div style={{ color: G.muted, fontSize: 11, marginBottom: 4 }}>{label}</div>
                          <div style={{ fontSize: 22, fontWeight: 800, color }}>{val}</div>
                          <div style={{ color: G.muted, fontSize: 11, marginTop: 4 }}>{sub}</div>
                        </div>
                      ))}
                    </div>

                    {/* Profit formula */}
                    <div style={{ background: "#F0F7F3", borderRadius: 10, padding: "10px 16px", marginBottom: 20, fontSize: 13, color: G.dark, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                      <span><strong style={{ color: G.mid }}>{fmt(revenue)}</strong> Revenue</span>
                      <span style={{ color: G.muted }}>−</span>
                      <span><strong style={{ color: G.muted }}>{fmt(cost)}</strong> Cost</span>
                      <span style={{ color: G.muted }}>−</span>
                      <span><strong style={{ color: G.gold }}>{fmt(tax)}</strong> Tax</span>
                      <span style={{ color: G.muted }}>=</span>
                      <span><strong style={{ color: profit >= 0 ? G.mid : G.red, fontSize: 15 }}>{fmt(profit)}</strong> Profit</span>
                      <span style={{ color: G.muted, fontSize: 11, marginLeft: 4 }}>(Note: shipping not included)</span>
                    </div>

                    {/* Category summary */}
                    {Object.keys(byCat).length > 0 && (
                      <div style={{ background: G.card, borderRadius: 14, padding: "18px 20px", marginBottom: 20, boxShadow: "0 1px 4px #0001" }}>
                        <div style={{ fontWeight: 700, color: G.dark, marginBottom: 14 }}>Sales by Category</div>
                        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                          <thead>
                            <tr style={{ background: G.dark, color: G.goldL }}>
                              {["Category","Units","Revenue","Cost","Profit","Margin"].map(h => (
                                <th key={h} style={{ padding: "7px 12px", textAlign: "left", fontWeight: 600 }}>{h}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {Object.entries(byCat).map(([cat, d], i) => (
                              <tr key={cat} style={{ background: i % 2 === 0 ? "#F9FBFA" : G.card, borderBottom: "1px solid #F0F0F0" }}>
                                <td style={{ padding: "7px 12px", fontWeight: 600 }}>{cat}</td>
                                <td style={{ padding: "7px 12px", color: G.muted }}>{d.qty}</td>
                                <td style={{ padding: "7px 12px", color: G.mid }}>{fmt(d.revenue)}</td>
                                <td style={{ padding: "7px 12px", color: G.muted }}>{fmt(d.cost)}</td>
                                <td style={{ padding: "7px 12px", fontWeight: 700, color: d.profit >= 0 ? G.mid : G.red }}>{fmt(d.profit)}</td>
                                <td style={{ padding: "7px 12px" }}>
                                  <span style={{ ...marginBadge(d.revenue > 0 ? (d.profit/d.revenue)*100 : 0), borderRadius: 10, padding: "2px 8px", fontSize: 11, fontWeight: 600 }}>
                                    {d.revenue > 0 ? ((d.profit/d.revenue)*100).toFixed(1) : 0}%
                                  </span>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}

                    {/* Full transaction list */}
                    {items.length > 0 && (
                      <div style={{ background: G.card, borderRadius: 14, padding: "18px 20px", marginBottom: 20, boxShadow: "0 1px 4px #0001" }}>
                        <div style={{ fontWeight: 700, color: G.dark, marginBottom: 14 }}>All Transactions — {items.length} item{items.length !== 1 ? "s" : ""}</div>
                        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                          <thead>
                            <tr style={{ background: G.dark, color: G.goldL }}>
                              {["Item","Category","Channel","Qty","Gross","Discount","Net","Cost","Tax","Profit","Customer"].map(h => (
                                <th key={h} style={{ padding: "6px 10px", textAlign: "left", fontWeight: 600, whiteSpace: "nowrap" }}>{h}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {items.map((item, i) => (
                              <tr key={i} style={{ background: i % 2 === 0 ? "#F9FBFA" : G.card, borderBottom: "1px solid #F0F0F0" }}>
                                <td style={{ padding: "6px 10px", maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 600 }} title={item.item}>{item.item}</td>
                                <td style={{ padding: "6px 10px", color: G.muted }}>{item.category}</td>
                                <td style={{ padding: "6px 10px" }}>
                                  {item.channel && item.channel !== "Unknown" ? (
                                    <span style={{ fontSize: 10, fontWeight: 700, padding: "1px 6px", borderRadius: 8, background: item.channel === "Online" ? "#DBEAFE" : "#D1FAE5", color: item.channel === "Online" ? "#1D4ED8" : G.mid }}>
                                      {item.channel === "Online" ? "🌐" : "🏪"} {item.channel}
                                    </span>
                                  ) : "—"}
                                </td>
                                <td style={{ padding: "6px 10px", color: G.muted }}>{item.qty}</td>
                                <td style={{ padding: "6px 10px" }}>{fmt(item.gross)}</td>
                                <td style={{ padding: "6px 10px", color: G.red }}>{item.gross - item.net > 0 ? "-" + fmt(item.gross - item.net) : "—"}</td>
                                <td style={{ padding: "6px 10px", color: G.mid }}>{fmt(item.net)}</td>
                                <td style={{ padding: "6px 10px", color: item.costIsBlank ? "#D97706" : G.muted }}>
                                  {item.costIsBlank ? <span title="Cost of Good was blank in the CSV">⚠️ $0.00</span> : fmt(item.cost)}
                                </td>
                                <td style={{ padding: "6px 10px", color: "#92400E" }}>{fmt(item.tax)}</td>
                                <td style={{ padding: "6px 10px", fontWeight: 700, color: item.profit >= 0 ? G.mid : G.red }}>{fmt(item.profit)}</td>
                                <td style={{ padding: "6px 10px", color: G.muted }}>
                                  {item.customer || "—"}
                                  {item.repeat && item.repeat.toLowerCase() === "yes" && <span style={{ marginLeft: 4, fontSize: 9, background: "#DBEAFE", color: "#1D4ED8", borderRadius: 6, padding: "1px 5px" }}>↩</span>}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                          <tfoot>
                            <tr style={{ background: "#F0F7F3", fontWeight: 700 }}>
                              <td colSpan={4} style={{ padding: "8px 10px", color: G.dark }}>TOTALS</td>
                              <td style={{ padding: "8px 10px", color: G.mid }}>{fmt(items.reduce((s,i)=>s+i.gross,0))}</td>
                              <td style={{ padding: "8px 10px", color: G.red }}>-{fmt(items.reduce((s,i)=>s+(i.gross-i.net),0))}</td>
                              <td style={{ padding: "8px 10px", color: G.mid }}>{fmt(revenue)}</td>
                              <td style={{ padding: "8px 10px", color: G.muted }}>{fmt(cost)}</td>
                              <td style={{ padding: "8px 10px", color: "#92400E" }}>{fmt(tax)}</td>
                              <td style={{ padding: "8px 10px", color: profit >= 0 ? G.mid : G.red }}>{fmt(profit)}</td>
                              <td style={{ padding: "8px 10px" }}></td>
                            </tr>
                          </tfoot>
                        </table>
                      </div>
                    )}

                    {/* Customer summary */}
                    {Object.keys(customers).length > 0 && (
                      <div style={{ background: G.card, borderRadius: 14, padding: "18px 20px", marginBottom: 20, boxShadow: "0 1px 4px #0001" }}>
                        <div style={{ fontWeight: 700, color: G.dark, marginBottom: 14 }}>Customer Summary — {Object.keys(customers).length} customer{Object.keys(customers).length !== 1 ? "s" : ""}</div>
                        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                          <thead>
                            <tr style={{ background: G.dark, color: G.goldL }}>
                              {["Customer","Items Bought","Total Spend","Type"].map(h => (
                                <th key={h} style={{ padding: "7px 12px", textAlign: "left", fontWeight: 600 }}>{h}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {Object.values(customers).sort((a,b)=>b.spend-a.spend).map((c, i) => (
                              <tr key={c.name} style={{ background: i % 2 === 0 ? "#F9FBFA" : G.card, borderBottom: "1px solid #F0F0F0" }}>
                                <td style={{ padding: "7px 12px", fontWeight: 600 }}>{c.name}</td>
                                <td style={{ padding: "7px 12px", color: G.muted }}>{c.items}</td>
                                <td style={{ padding: "7px 12px", color: G.mid, fontWeight: 600 }}>{fmt(c.spend)}</td>
                                <td style={{ padding: "7px 12px" }}>
                                  <span style={{ fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 10, background: c.repeat && c.repeat.toLowerCase() === "yes" ? "#DBEAFE" : "#D1FAE5", color: c.repeat && c.repeat.toLowerCase() === "yes" ? "#1D4ED8" : G.mid }}>
                                    {c.repeat && c.repeat.toLowerCase() === "yes" ? "↩ Returning" : "★ New"}
                                  </span>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}

                    {/* Footer note */}
                    <div style={{ background: "#FEF3C7", borderRadius: 10, padding: "10px 16px", fontSize: 12, color: "#78350F" }}>
                      ⚠️ Tax of {fmt(tax)} must be remitted to the State of California. Shipping costs are not included in this report.
                      Generated: {new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" })}
                    </div>
                  </div>
                )}
              </div>
            );
          })()}
        </div>
      )}

      {/* ── DASHBOARD TAB ── */}
      {activeTab === "dashboard" && (
        <div style={{ maxWidth: 980, margin: "0 auto", padding: "24px 16px" }}>

          {/* KPIs */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 14, marginBottom: 24 }}>
            {[
              { label: "Total Revenue (All Channels)", val: fmt(totalRevenue), color: G.mid },
              { label: "Total Cost (All Channels)",    val: fmt(totalCost),    color: G.muted },
              { label: "Total Profit (All Channels)",  val: fmt(totalProfit),  color: totalProfit >= 0 ? G.mid : G.red },
              { label: "Overall Margin",   val: `${totalMargin}%`, color: parseFloat(totalMargin) >= 30 ? G.mid : G.gold },
            ].map(({ label, val, color }) => (
              <div key={label} style={{ background: G.card, borderRadius: 14, padding: "18px 20px", boxShadow: "0 1px 6px #0001", borderTop: `3px solid ${color}` }}>
                <div style={{ color: G.muted, fontSize: 12, marginBottom: 6 }}>{label}</div>
                <div style={{ fontSize: 22, fontWeight: 700, color }}>{val}</div>
              </div>
            ))}
          </div>

          {/* Manual entry */}
          <div style={{ background: G.dark, borderRadius: 14, padding: "18px 22px", marginBottom: 24 }}>
            <div style={{ color: G.goldL, fontWeight: 600, fontSize: 13, marginBottom: 12 }}>✏️ Manual Entry &nbsp;<span style={{ color: "#94A89A", fontWeight: 400 }}>or use Import CSV tab above</span></div>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
              {[
                { label: "Date", key: "date", type: "date" },
                { label: "Net Revenue ($)", key: "revenue", type: "number", placeholder: "e.g. 2400" },
                { label: "Total Costs ($)", key: "cost", type: "number", placeholder: "e.g. 980" },
              ].map(({ label, key, type, placeholder }) => (
                <div key={key} style={{ flex: "1 1 130px" }}>
                  <div style={{ color: "#94A89A", fontSize: 12, marginBottom: 5 }}>{label}</div>
                  <input type={type} value={form[key]} placeholder={placeholder}
                    onChange={e => setForm(p => ({ ...p, [key]: e.target.value }))}
                    style={{ width: "100%", padding: "8px 11px", borderRadius: 8, border: `1px solid ${G.mid}`, background: "#1F4535", color: "#E8F5EE", fontSize: 13, outline: "none", boxSizing: "border-box" }} />
                </div>
              ))}
              <button onClick={handleSave} style={{ padding: "8px 20px", background: G.gold, color: G.dark, fontWeight: 700, border: "none", borderRadius: 8, cursor: "pointer", fontSize: 13, height: 38 }}>Save</button>
              <button onClick={() => {
                if (!form.date) { showToast("Pick a date first.", false); return; }
                if (entries[form.date] && entries[form.date].noSale) {
                  showToast(`${form.date} already marked as no-sale.`, false); return;
                }
                if (entries[form.date]) {
                  if (!window.confirm(`${form.date} already has data. Mark as no-sale anyway?`)) return;
                }
                setEntries(prev => ({ ...prev, [form.date]: { revenue: 0, cost: 0, profit: 0, tax: 0, items: [], noSale: true } }));
                showToast(`${form.date} marked as no-sale day 🔕`);
              }} style={{ padding: "8px 18px", background: "transparent", color: "#94A89A", border: "1px solid #2D4A3A", borderRadius: 8, cursor: "pointer", fontSize: 13, height: 38, fontWeight: 600, whiteSpace: "nowrap" }}>
                🔕 No-Sale Day
              </button>
            </div>
          </div>

          {/* Monthly Profit Goal */}
          {(() => {
            const monthProfit = currentMonth ? currentMonth.profit : 0;
            const pct = Math.min((monthProfit / goalAmount) * 100, 100);
            const onTrack = monthProfit >= goalAmount * 0.7;
            return (
              <div style={{ background: G.dark, borderRadius: 14, padding: "16px 22px", marginBottom: 24, display: "flex", alignItems: "center", gap: 20, flexWrap: "wrap" }}>
                <div style={{ flex: 1, minWidth: 200 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                    <div style={{ color: G.goldL, fontWeight: 700, fontSize: 13 }}>🎯 Monthly Profit Goal — {getMonthLabel(activeMonth)}</div>
                    <div style={{ color: onTrack ? G.light : "#FCA5A5", fontSize: 12, fontWeight: 600 }}>{onTrack ? "✅ On track" : "⚠️ Behind"}</div>
                  </div>
                  <div style={{ background: "#1F4535", borderRadius: 8, height: 14, marginBottom: 8 }}>
                    <div style={{ width: `${pct}%`, height: "100%", borderRadius: 8, background: pct >= 100 ? G.light : pct >= 70 ? G.gold : G.red, transition: "width 0.4s" }} />
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
                    <span style={{ color: "#94A89A" }}>{fmt(monthProfit)} earned</span>
                    <span style={{ color: G.goldL, fontWeight: 700 }}>{pct.toFixed(0)}% of {fmt(goalAmount)}</span>
                  </div>
                </div>
                <div>
                  {editingGoal ? (
                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      <input autoFocus value={goalInput} onChange={e => setGoalInput(e.target.value)}
                        onKeyDown={e => e.key === "Enter" && saveGoal(goalInput)}
                        placeholder={goalAmount} style={{ width: 90, padding: "6px 10px", borderRadius: 8, border: `1px solid ${G.gold}`, background: "#1F4535", color: G.goldL, fontSize: 13, outline: "none" }} />
                      <button onClick={() => saveGoal(goalInput)} style={{ padding: "6px 12px", background: G.gold, color: G.dark, border: "none", borderRadius: 8, fontWeight: 700, cursor: "pointer", fontSize: 12 }}>Set</button>
                      <button onClick={() => setEditingGoal(false)} style={{ padding: "6px 10px", background: "transparent", color: "#94A89A", border: "1px solid #2D4A3A", borderRadius: 8, cursor: "pointer", fontSize: 12 }}>✕</button>
                    </div>
                  ) : (
                    <button onClick={() => { setGoalInput(goalAmount); setEditingGoal(true); }}
                      style={{ padding: "7px 14px", background: "#1F4535", color: G.goldL, border: `1px solid ${G.mid}`, borderRadius: 8, cursor: "pointer", fontSize: 12, fontWeight: 600 }}>
                      ✏️ Set Goal
                    </button>
                  )}
                </div>
              </div>
            );
          })()}

          {/* Tax Summary */}
          {totalTaxCollected > 0 && (
            <div style={{ background: G.card, borderRadius: 14, padding: "20px 22px", marginBottom: 24, boxShadow: "0 1px 6px #0001", borderLeft: `4px solid ${G.gold}` }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 16 }}>
                <div>
                  <div style={{ fontWeight: 700, color: G.dark, fontSize: 15, marginBottom: 4 }}>🧾 Tax Summary</div>
                  <div style={{ color: G.muted, fontSize: 12 }}>Tax is collected on behalf of the government — it is NOT your revenue or profit</div>
                </div>
                <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                  {[
                    { label: "Tax Collected",    val: fmt(totalTaxCollected), color: G.gold,  tip: "Total sales tax collected from customers" },
                    { label: "Effective Tax Rate", val: `${taxRate}%`,         color: G.dark,  tip: "Tax as % of net sales" },
                    { label: "Your Net Revenue",  val: fmt(retailRevenue),    color: G.mid,   tip: "What's actually yours after tax is excluded" },
                  ].map(({ label, val, color, tip }) => (
                    <div key={label} style={{ background: "#FDF8EE", borderRadius: 10, padding: "12px 16px", minWidth: 120, border: `1px solid ${G.gold}44` }} title={tip}>
                      <div style={{ color: G.muted, fontSize: 11, marginBottom: 4 }}>{label}</div>
                      <div style={{ fontWeight: 700, fontSize: 18, color }}>{val}</div>
                    </div>
                  ))}
                </div>
              </div>
              <div style={{ marginTop: 16, background: "#FEF3C7", borderRadius: 10, padding: "10px 14px", fontSize: 13, color: "#78350F" }}>
                <strong>Important:</strong> The {fmt(totalTaxCollected)} collected in sales tax must be remitted to the State of California. 
                It has already been excluded from your revenue and profit figures above. 
                San Diego sales tax rate is approximately 8.75%.
              </div>
              <div style={{ marginTop: 8, background: "#F0F7F3", borderRadius: 10, padding: "10px 14px", fontSize: 13, color: G.dark, borderLeft: `3px solid ${G.muted}` }}>
                ⚠️ <strong>Note:</strong> Shipping costs are <strong>not included</strong> in this calculation. If you ship orders to customers, your actual profit will be lower than shown. Track shipping costs separately and deduct them from your profit figure.
              </div>

              {/* Visual breakdown bar */}
              <div style={{ marginTop: 14 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: G.dark, marginBottom: 6 }}>How a customer payment breaks down:</div>
                {(() => {
                  const grossTotal = retailRevenue + totalTaxCollected + retailCost;
                  if (grossTotal === 0) return null;
                  const revPct  = ((retailRevenue  / grossTotal) * 100).toFixed(0);
                  const taxPct  = ((totalTaxCollected / grossTotal) * 100).toFixed(0);
                  const costPct = ((retailCost / grossTotal) * 100).toFixed(0);
                  const profPct = Math.max(0, 100 - parseInt(revPct) - parseInt(taxPct) - parseInt(costPct));
                  return (
                    <div>
                      <div style={{ display: "flex", borderRadius: 8, overflow: "hidden", height: 24, marginBottom: 8 }}>
                        <div style={{ width: `${costPct}%`, background: "#E0C4C4", display: "flex", alignItems: "center", justifyContent: "center" }}>
                          {parseInt(costPct) > 8 && <span style={{ fontSize: 10, color: "#7F1D1D", fontWeight: 700 }}>Cost {costPct}%</span>}
                        </div>
                        <div style={{ width: `${taxPct}%`, background: G.gold, display: "flex", alignItems: "center", justifyContent: "center" }}>
                          {parseInt(taxPct) > 4 && <span style={{ fontSize: 10, color: G.dark, fontWeight: 700 }}>Tax {taxPct}%</span>}
                        </div>
                        <div style={{ flex: 1, background: G.light, display: "flex", alignItems: "center", justifyContent: "center" }}>
                          <span style={{ fontSize: 10, color: G.dark, fontWeight: 700 }}>Profit</span>
                        </div>
                      </div>
                      <div style={{ display: "flex", gap: 16, fontSize: 11 }}>
                        {[
                          { label: "Cost of Goods", color: "#E0C4C4", val: fmt(retailCost) },
                          { label: "Tax (→ CA)", color: G.gold, val: fmt(totalTaxCollected) },
                          { label: "Profit", color: G.light, val: fmt(retailProfit) },
                        ].map(({ label, color, val }) => (
                          <div key={label} style={{ display: "flex", alignItems: "center", gap: 5 }}>
                            <div style={{ width: 10, height: 10, borderRadius: 2, background: color }} />
                            <span style={{ color: G.muted }}>{label}: <strong style={{ color: G.dark }}>{val}</strong></span>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })()}
              </div>
            </div>
          )}

          {/* Monthly bar chart */}
          <div style={{ background: G.card, borderRadius: 14, padding: "20px 22px", marginBottom: 24, boxShadow: "0 1px 6px #0001" }}>
            <div style={{ fontWeight: 700, color: G.dark, marginBottom: 16 }}>Monthly Overview</div>
            <ResponsiveContainer width="100%" height={210}>
              <BarChart data={chartMonthly} barCategoryGap="28%">
                <CartesianGrid strokeDasharray="3 3" stroke="#F0F0F0" />
                <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} tickFormatter={v => `$${(v/1000).toFixed(0)}k`} />
                <Tooltip formatter={(v) => fmt(v)} />
                <Legend />
                <Bar dataKey="Revenue" fill={G.light}   radius={[4,4,0,0]} />
                <Bar dataKey="Cost"    fill="#E0C4C4"   radius={[4,4,0,0]} />
                <Bar dataKey="Profit"  fill={G.gold}    radius={[4,4,0,0]} />
                <Bar dataKey="Bulk"    fill="#7C3AED"   radius={[4,4,0,0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* Month selector */}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
            {monthlyData.slice(-6).map(m => (
              <button key={m.key} onClick={() => setActiveMonth(m.key)} style={{
                padding: "6px 14px", borderRadius: 20, border: "none", cursor: "pointer", fontSize: 12, fontWeight: 600,
                background: m.key === activeMonth ? G.gold : G.dark,
                color: m.key === activeMonth ? G.dark : G.goldL,
              }}>{m.label}</button>
            ))}
          </div>

          {/* Month KPIs */}
          {currentMonth && (() => {
            // Count new vs returning from item data
            const seen = new Set();
            let newC = 0, retC = 0;
            activeDayRows.forEach(row => {
              (row.items || []).forEach(item => {
                if (!item.customer) return;
                const key = item.customer.toLowerCase().trim();
                if (!seen.has(key)) {
                  seen.add(key);
                  if (item.repeat && item.repeat.toLowerCase() === "yes") retC++;
                  else newC++;
                }
              });
            });
            return (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 12, marginBottom: 20 }}>
                {[
                  { label: "Revenue", val: fmt(currentMonth.revenue), color: G.mid },
                  { label: "Profit",  val: fmt(currentMonth.profit),  color: currentMonth.profit >= 0 ? G.mid : G.red },
                  { label: "Margin",  val: `${currentMonth.margin}%`, color: G.dark },
                  { label: "Customers", val: (
                    <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 4 }}>
                      <span style={{ fontSize: 13, fontWeight: 700, color: G.mid }}>★ {newC} new</span>
                      <span style={{ fontSize: 13, fontWeight: 700, color: "#1D4ED8" }}>↩ {retC} returning</span>
                    </div>
                  ), color: G.dark },
                ].map(({ label, val, color }) => (
                  <div key={label} style={{ background: G.card, borderRadius: 12, padding: "14px 16px", boxShadow: "0 1px 4px #0001" }}>
                    <div style={{ color: G.muted, fontSize: 11 }}>{getMonthLabel(activeMonth)} {label}</div>
                    {typeof val === "string"
                      ? <div style={{ fontSize: 18, fontWeight: 700, color, marginTop: 4 }}>{val}</div>
                      : val}
                  </div>
                ))}
              </div>
            );
          })()}

          {/* Daily line + category breakdown side by side */}
          <div style={{ display: "grid", gridTemplateColumns: categoryBreakdown.length > 0 ? "1.6fr 1fr" : "1fr", gap: 14, marginBottom: 20 }}>
            {chartDaily.length > 0 && (
              <div style={{ background: G.card, borderRadius: 14, padding: "18px 20px", boxShadow: "0 1px 6px #0001" }}>
                <div style={{ fontWeight: 700, color: G.dark, marginBottom: 14, fontSize: 14 }}>Daily Profit — {getMonthLabel(activeMonth)}</div>
                <ResponsiveContainer width="100%" height={170}>
                  <LineChart data={chartDaily}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#F0F0F0" />
                    <XAxis dataKey="name" tick={{ fontSize: 10 }} />
                    <YAxis tick={{ fontSize: 10 }} tickFormatter={v => `$${(v/1000).toFixed(1)}k`} />
                    <Tooltip formatter={(v) => fmt(v)} />
                    <Legend />
                    <Line type="monotone" dataKey="Revenue" stroke={G.light} strokeWidth={2} dot={false} />
                    <Line type="monotone" dataKey="Profit"  stroke={G.gold}  strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}

          </div>

          {/* ── CATEGORY MARGIN COMPARISON ── */}
          {categoryBreakdown.length > 0 && (
            <div style={{ background: G.card, borderRadius: 14, padding: "20px 22px", marginBottom: 24, boxShadow: "0 1px 6px #0001" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 18 }}>
                <div>
                  <div style={{ fontWeight: 700, color: G.dark, fontSize: 15 }}>Category Margin Comparison</div>
                  <div style={{ color: G.muted, fontSize: 12, marginTop: 3 }}>All-time · Which categories make you the most money</div>
                </div>
              </div>

              {/* Bar chart — margin % by category */}
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={categoryBreakdown.map((c, i) => ({ name: c.cat, "Margin %": parseFloat(c.margin), Revenue: c.revenue, Profit: c.profit }))} barCategoryGap="32%">
                  <CartesianGrid strokeDasharray="3 3" stroke="#F0F0F0" />
                  <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} tickFormatter={v => `${v}%`} domain={[0, 100]} />
                  <Tooltip formatter={(v, name) => name === "Margin %" ? `${v}%` : fmt(v)} />
                  <Legend />
                  <Bar dataKey="Margin %" radius={[6,6,0,0]}>
                    {categoryBreakdown.map((c, i) => (
                      <Cell key={c.cat} fill={CAT_COLORS[i % CAT_COLORS.length]} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>

              {/* Ranked table */}
              <div style={{ marginTop: 20, overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: G.dark, color: G.goldL }}>
                      {["#","Category","Revenue","Cost","Profit","Margin %","Units Sold","Verdict"].map(h => (
                        <th key={h} style={{ padding: "8px 12px", textAlign: "left", fontWeight: 600, whiteSpace: "nowrap" }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {categoryBreakdown.map((c, i) => {
                      const m = parseFloat(c.margin);
                      const verdict = m >= 40 ? { label: "⭐ Star", bg: "#D1FAE5", color: G.mid }
                        : m >= 25 ? { label: "✅ Healthy", bg: "#ECFDF5", color: "#065F46" }
                        : m >= 10 ? { label: "⚠️ Watch", bg: "#FEF3C7", color: "#92400E" }
                        : { label: "🔴 Review", bg: "#FEE2E2", color: G.red };
                      return (
                        <tr key={c.cat} style={{ background: i % 2 === 0 ? "#F9FBFA" : G.card, borderBottom: "1px solid #F0F0F0" }}>
                          <td style={{ padding: "9px 12px", fontWeight: 700, color: G.muted }}>{i + 1}</td>
                          <td style={{ padding: "9px 12px" }}>
                            <span style={{ display: "inline-block", width: 10, height: 10, borderRadius: "50%", background: CAT_COLORS[i % CAT_COLORS.length], marginRight: 8 }} />
                            <strong>{c.cat}</strong>
                          </td>
                          <td style={{ padding: "9px 12px", color: G.mid }}>{fmt(c.revenue)}</td>
                          <td style={{ padding: "9px 12px", color: G.muted }}>{fmt(c.cost)}</td>
                          <td style={{ padding: "9px 12px", fontWeight: 700, color: c.profit >= 0 ? G.mid : G.red }}>{fmt(c.profit)}</td>
                          <td style={{ padding: "9px 12px" }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                              <div style={{ flex: 1, background: "#F0F0F0", borderRadius: 4, height: 8, minWidth: 60 }}>
                                <div style={{ width: `${Math.min(m, 100)}%`, height: "100%", borderRadius: 4, background: CAT_COLORS[i % CAT_COLORS.length] }} />
                              </div>
                              <span style={{ fontWeight: 700, minWidth: 38 }}>{c.margin}%</span>
                            </div>
                          </td>
                          <td style={{ padding: "9px 12px", color: G.muted }}>{c.qty}</td>
                          <td style={{ padding: "9px 12px" }}>
                            <span style={{ background: verdict.bg, color: verdict.color, borderRadius: 12, padding: "3px 10px", fontSize: 11, fontWeight: 700, whiteSpace: "nowrap" }}>{verdict.label}</span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Insight strip */}
              {categoryBreakdown.length >= 2 && (() => {
                const best  = categoryBreakdown[0];
                const worst = categoryBreakdown[categoryBreakdown.length - 1];
                return (
                  <div style={{ marginTop: 16, background: "#F0F7F3", borderRadius: 10, padding: "12px 16px", fontSize: 13, color: G.dark, borderLeft: `3px solid ${G.gold}` }}>
                    💡 <strong>{best.cat}</strong> is your most profitable category at <strong>{best.margin}%</strong> margin.
                    {parseFloat(worst.margin) < 15 && <span>&nbsp;Consider reviewing pricing or costs for <strong>{worst.cat}</strong> — currently at only <strong>{worst.margin}%</strong> margin.</span>}
                  </div>
                );
              })()}
            </div>
          )}

          {/* Daily table with expandable item rows */}
          <div style={{ background: G.card, borderRadius: 14, padding: "20px 22px", boxShadow: "0 1px 6px #0001" }}>
            <div style={{ fontWeight: 700, color: G.dark, marginBottom: 14 }}>Daily Log — {getMonthLabel(activeMonth)}</div>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr style={{ background: G.dark, color: G.goldL }}>
                    {["Date","Revenue","Cost","Profit","Margin","Tax","Items",""].map(h => (
                      <th key={h} style={{ padding: "9px 12px", textAlign: "left", fontWeight: 600, whiteSpace: "nowrap" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {activeDayRows.length === 0 && (
                    <tr><td colSpan={8} style={{ padding: 24, color: G.muted, textAlign: "center" }}>
                      No entries for this month. Import a CSV or add manually.
                    </td></tr>
                  )}
                  {activeDayRows.map((r, i) => (
                    <Fragment>
                      <tr key={r.date} style={{ background: i % 2 === 0 ? "#F9FBFA" : G.card, cursor: r.items.length > 0 ? "pointer" : "default" }}
                        onClick={() => r.items.length > 0 && setExpandedDate(expandedDate === r.date ? null : r.date)}>
                        <td style={{ padding: "8px 12px", fontWeight: 600 }}>
                          {r.items.length > 0 && <span style={{ marginRight: 6, fontSize: 10 }}>{expandedDate === r.date ? "▼" : "▶"}</span>}
                          {r.date}
                          {(entries[r.date] && entries[r.date].noSale) && <span style={{ marginLeft: 8, fontSize: 10, background: "#F3F4F6", color: G.muted, borderRadius: 8, padding: "1px 7px", fontWeight: 600 }}>🔕 No Sale</span>}
                        </td>
                        <td style={{ padding: "8px 12px", color: G.mid }}>{fmt(r.revenue)}</td>
                        <td style={{ padding: "8px 12px", color: G.muted }}>{fmt(r.cost)}</td>
                        <td style={{ padding: "8px 12px", fontWeight: 700, color: r.profit >= 0 ? G.mid : G.red }}>{fmt(r.profit)}</td>
                        <td style={{ padding: "8px 12px" }}>
                          <span style={{ ...marginBadge(parseFloat(r.margin)), borderRadius: 12, padding: "2px 9px", fontSize: 11, fontWeight: 600 }}>{r.margin}%</span>
                        </td>
                        <td style={{ padding: "8px 12px", color: G.muted }}>{fmt(r.tax)}</td>
                        <td style={{ padding: "8px 12px", color: G.muted }}>{r.items.length || "—"}</td>
                        <td style={{ padding: "8px 12px" }}>
                          <button onClick={e => { e.stopPropagation(); handleDelete(r.date); }}
                            style={{ background: "none", border: "none", color: G.muted, cursor: "pointer", fontSize: 14 }}>🗑</button>
                        </td>
                      </tr>
                      {expandedDate === r.date && r.items.length > 0 && (
                        <tr key={`${r.date}-items`}>
                          <td colSpan={8} style={{ padding: "0 0 8px 24px", background: "#F0F7F3" }}>
                            <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}>
                              <thead>
                                <tr style={{ color: G.muted }}>
                                  {["Item","Cat","Channel","Net","Cost","Profit","Customer",""].map(h => (
                                    <th key={h} style={{ padding: "5px 10px", textAlign: "left", fontWeight: 600 }}>{h}</th>
                                  ))}
                                </tr>
                              </thead>
                              <tbody>
                                {r.items.map((item, j) => (
                                  <tr key={j} style={{ borderBottom: "1px solid #E0EDE6" }}>
                                    <td style={{ padding: "5px 10px", maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={item.item}>{item.item}</td>
                                    <td style={{ padding: "5px 10px", color: G.muted }}>{item.category}</td>
                                    <td style={{ padding: "5px 10px" }}>{fmt(item.net)}</td>
                                    <td style={{ padding: "5px 10px", color: item.costIsBlank ? "#D97706" : G.muted }}>
                                      {item.costIsBlank ? <span title="Cost of Good was blank in the CSV">⚠️ $0.00</span> : fmt(item.cost)}
                                    </td>
                                    <td style={{ padding: "5px 10px", fontWeight: 600, color: item.profit >= 0 ? G.mid : G.red }}>{fmt(item.profit)}</td>
                                    <td style={{ padding: "5px 10px" }}>
                                      {item.channel && item.channel !== "Unknown" && (
                                        <span style={{
                                          fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 10,
                                          background: item.channel === "Online" ? "#DBEAFE" : "#D1FAE5",
                                          color: item.channel === "Online" ? "#1D4ED8" : G.mid,
                                        }}>{item.channel === "Online" ? "🌐 Online" : "🏪 In-Store"}</span>
                                      )}
                                    </td>
                                    <td style={{ padding: "5px 10px", color: G.muted }}>{item.customer}</td>
                                    <td style={{ padding: "5px 10px" }}>
                                      {item.customer && item.customer !== "" && (
                                        <span style={{
                                          fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 10,
                                          background: item.repeat && item.repeat.toLowerCase() === "yes" ? "#DBEAFE" : "#D1FAE5",
                                          color: item.repeat && item.repeat.toLowerCase() === "yes" ? "#1D4ED8" : G.mid,
                                        }}>
                                          {item.repeat && item.repeat.toLowerCase() === "yes" ? "↩ Returning" : "★ New"}
                                        </span>
                                      )}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div style={{
          position: "fixed", bottom: 28, left: "50%", transform: "translateX(-50%)",
          background: toast.ok ? G.dark : G.red, color: "#fff", padding: "10px 22px",
          borderRadius: 24, fontSize: 14, fontWeight: 600, boxShadow: "0 4px 16px #0003",
          borderLeft: `4px solid ${toast.ok ? G.gold : "#fff"}`, zIndex: 999, whiteSpace: "nowrap"
        }}>{toast.msg}</div>
      )}
    </div>
  );
}