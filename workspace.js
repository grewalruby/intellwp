// workspace.js
//
// Server-side data assembly for the Intelligent Order Workspace. Pulls live
// LN data, derives the workspace metrics, and asks the Infor GenAI LLM
// service for the narrative / scenario recommendation, grounded in that
// live data. Every GenAI-driven field has a deterministic fallback computed
// from the same live data, so the workspace never depends on GenAI being up.

const { lnGet, lnGetAll, genaiPrompt } = require('./lnClient');

const DAY_MS = 24 * 60 * 60 * 1000;
const CACHE_TTL_MS = 10 * 60 * 1000;

// Stand-in until real work center capacity is available (no LN API on this
// tenant exposes available hours). Override with WC_WEEKLY_CAPACITY_HOURS.
const WEEKLY_CAPACITY_HOURS = Number(process.env.WC_WEEKLY_CAPACITY_HOURS || 80);

// Commitments count as "at risk" only if the customer's requested date falls
// inside this window (recently overdue through the next N days). This keeps
// years-old demo data from inflating the numbers.
const RISK_WINDOW_PAST_DAYS = Number(process.env.RISK_WINDOW_PAST_DAYS || 30);
const RISK_WINDOW_FUTURE_DAYS = Number(process.env.RISK_WINDOW_FUTURE_DAYS || 90);

// Demo data layer: fills gaps in thin demo-tenant data with believable,
// deterministic values (same input -> same output). Real LN values always
// win. On by default; set DEMO_ENRICH=false to show raw LN data only.
const DEMO_ENRICH = String(process.env.DEMO_ENRICH || 'true').toLowerCase() !== 'false';

// Stable pseudo-random number in [0, 1) derived from a string.
function seeded(key) {
  let h = 2166136261;
  for (const ch of String(key)) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10000) / 10000;
}

const CURRENCY_SYMBOLS = { EUR: '€', USD: '$', GBP: '£', INR: '₹', CNY: '¥', JPY: '¥', AUD: 'A$', CAD: 'C$', MXN: 'MX$' };

const cache = new Map();

async function cached(key, ttlMs, loader) {
  const hit = cache.get(key);
  if (hit && hit.value !== undefined && Date.now() - hit.at < ttlMs) return hit.value;
  if (hit && hit.pending) return hit.pending;
  const pending = loader()
    .then((value) => {
      cache.set(key, { at: Date.now(), value });
      return value;
    })
    .catch((err) => {
      cache.delete(key);
      throw err;
    });
  cache.set(key, { at: 0, pending });
  return pending;
}

function esc(value) {
  return String(value).replace(/'/g, "''");
}

function isoDate(d) {
  return new Date(d).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function daysBetween(later, earlier) {
  return Math.round((new Date(later) - new Date(earlier)) / DAY_MS);
}

function trimItem(item) {
  return item ? String(item).trim() : item;
}

function currencySymbol(code) {
  return CURRENCY_SYMBOLS[code] || (code ? `${code} ` : '');
}

// ---------------------------------------------------------------------------
// Open order book + commitment risk
// ---------------------------------------------------------------------------

function classifyLine(line, now) {
  const planned = line.PlannedDeliveryDate ? new Date(line.PlannedDeliveryDate) : null;
  const requested = line.CustomerRequestedDeliveryDate ? new Date(line.CustomerRequestedDeliveryDate) : null;
  const inWindow = Boolean(
    requested &&
    requested >= new Date(now.getTime() - RISK_WINDOW_PAST_DAYS * DAY_MS) &&
    requested <= new Date(now.getTime() + RISK_WINDOW_FUTURE_DAYS * DAY_MS)
  );
  const slipDays = planned && requested ? daysBetween(planned, requested) : 0;
  const overdueDays = planned && planned < now ? daysBetween(now, planned) : 0;
  const atRisk = inWindow && (slipDays > 0 || overdueDays > 0);
  const score = atRisk
    ? Math.min(99, 40 + Math.max(slipDays, 0) * 2 + Math.min(overdueDays, 30))
    : 0;
  return { inWindow, slipDays, overdueDays, atRisk, score };
}

async function getOpenOrderBook() {
  return cached('openOrderBook', CACHE_TTL_MS, async () => {
    const select = [
      'SalesOrder', 'Line', 'SoldtoBusinessPartner', 'Item', 'Amount',
      'OrderedQuantity', 'DeliveredQuantity', 'PlannedDeliveryDate',
      'CustomerRequestedDeliveryDate', 'Site', 'Warehouse',
    ].join(',');
    const filter = "DeliveredQuantity lt OrderedQuantity and Canceled eq tdapi.slsSalesOrder.AnswerOnQuestionYn'No'";
    const { rows, truncated } = await lnGetAll(
      `/odata/tdapi.slsSalesOrder/Lines?$filter=${filter}&$select=${select}`,
      { maxRows: 25000, pageSize: 1000 }
    );

    const now = new Date();
    const lines = rows.map((r) => ({ ...r, Item: trimItem(r.Item), ...classifyLine(r, now) }));
    return { lines, truncated, loadedAt: now.toISOString() };
  });
}

async function getKpis() {
  const book = await getOpenOrderBook();
  const windowLines = book.lines.filter((l) => l.inWindow);
  const atRiskLines = windowLines.filter((l) => l.atRisk);

  return {
    totalOpenOrders: new Set(book.lines.map((l) => l.SalesOrder)).size,
    openLines: book.lines.length,
    commitmentsAtRisk: new Set(atRiskLines.map((l) => l.SalesOrder)).size,
    revenueExposure: atRiskLines.reduce((sum, l) => sum + (l.Amount || 0), 0),
    commitmentConfidence: windowLines.length
      ? Math.round(((windowLines.length - atRiskLines.length) / windowLines.length) * 100)
      : null,
    dueInWindowLines: windowLines.length,
    riskWindowDays: RISK_WINDOW_FUTURE_DAYS,
    siteCount: new Set(book.lines.map((l) => l.Site).filter(Boolean)).size,
    truncated: book.truncated,
    loadedAt: book.loadedAt,
  };
}

async function getBusinessPartnerName(bp) {
  if (!bp) return null;
  return cached(`bpName:${bp}`, 60 * 60 * 1000, async () => {
    try {
      const data = await lnGet(
        `/odata/tcapi.comBusinessPartner/BusinessPartners(BusinessPartner='${esc(bp)}')?$select=BusinessPartner,Name`
      );
      return data.Name || bp;
    } catch (e) {
      return bp;
    }
  });
}

/**
 * Existing commitments most exposed if capacity at the new order's site is
 * consumed: at-risk lines at the same site first, then the rest of the
 * network, ranked by risk score. Excludes the order under review.
 */
async function getCommitmentsAtRisk({ site, excludeOrder, limit = 5 } = {}) {
  const book = await getOpenOrderBook();
  const candidates = book.lines
    .filter((l) => l.atRisk && l.SalesOrder !== excludeOrder)
    .map((l) => ({ ...l, sameSite: Boolean(site && l.Site === site) }))
    .sort((a, b) => (b.sameSite - a.sameSite) || (b.score - a.score));

  const top = candidates.slice(0, limit);
  const names = await Promise.all(top.map((l) => getBusinessPartnerName(l.SoldtoBusinessPartner)));

  return {
    totalAtRisk: new Set(candidates.map((l) => l.SalesOrder)).size,
    atSite: site ? new Set(candidates.filter((l) => l.sameSite).map((l) => l.SalesOrder)).size : 0,
    rows: top.map((l, i) => ({
      salesOrder: l.SalesOrder,
      line: l.Line,
      customer: names[i],
      businessPartner: l.SoldtoBusinessPartner,
      item: l.Item,
      site: l.Site,
      promisedDate: l.CustomerRequestedDeliveryDate,
      plannedDate: l.PlannedDeliveryDate,
      amount: l.Amount,
      riskScore: l.score,
      impact: l.overdueDays > 0
        ? `Overdue ${l.overdueDays} days — quantity still open`
        : `Planned ${l.slipDays} days after requested date`,
    })),
  };
}

// ---------------------------------------------------------------------------
// Order under review
// ---------------------------------------------------------------------------

async function getOrderLines(salesOrder) {
  const base = `/odata/tdapi.slsSalesOrder/Lines?$filter=SalesOrder eq '${esc(salesOrder)}'&$select=Line,Item,OrderedQuantity,SalesUnit,Amount,Site,Warehouse,PlannedDeliveryDate,CustomerRequestedDeliveryDate`;
  try {
    const data = await lnGet(`${base}&$expand=ItemRef($select=Item,Description)`);
    return data.value || [];
  } catch (e) {
    try {
      const data = await lnGet(base);
      return data.value || [];
    } catch (e2) {
      return [];
    }
  }
}

async function getOrderReview(salesOrder) {
  let order;
  if (salesOrder) {
    order = await lnGet(`/odata/tdapi.slsSalesOrder/Orders(SalesOrder='${esc(salesOrder)}')`);
  } else {
    const data = await lnGet(`/odata/tdapi.slsSalesOrder/Orders?$top=1&$orderby=OrderDate desc`);
    order = data.value && data.value[0];
  }
  if (!order) return null;

  const lines = await getOrderLines(order.SalesOrder);
  const firstLine = lines[0] || {};

  return {
    salesOrder: order.SalesOrder,
    customer: order.SoldtoBusinessPartner,
    orderDate: order.OrderDate,
    requestedDeliveryDate: order.CustomerRequestedDeliveryDate,
    plannedDeliveryDate: order.PlannedDeliveryDate,
    orderAmount: order.OrderAmount,
    currency: order.OrderCurrency,
    currencySymbol: currencySymbol(order.OrderCurrency),
    status: order.SalesOrderStatus,
    rushOrder: order.RushOrder,
    site: order.Site || firstLine.Site,
    warehouse: order.Warehouse || firstLine.Warehouse,
    lines: lines.map((l) => ({
      line: l.Line,
      item: trimItem(l.Item),
      itemDescription: l.ItemRef && l.ItemRef.Description,
      quantity: l.OrderedQuantity,
      unit: l.SalesUnit,
      amount: l.Amount,
      site: l.Site,
      warehouse: l.Warehouse,
    })),
  };
}

// ---------------------------------------------------------------------------
// Customer insight, claims, Cstat
// ---------------------------------------------------------------------------

async function getCustomerProfile(bp) {
  const [profile, soldTo] = await Promise.allSettled([
    lnGet(`/odata/tcapi.comBusinessPartner/BusinessPartners(BusinessPartner='${esc(bp)}')`),
    lnGet(`/odata/tcapi.comBusinessPartner/SoldtoBusinessPartners(SoldtoBusinessPartner='${esc(bp)}')`),
  ]);
  const p = profile.status === 'fulfilled' ? profile.value : {};
  const s = soldTo.status === 'fulfilled' ? soldTo.value : {};
  return {
    businessPartner: bp,
    name: p.Name || bp,
    status: p.BusinessPartnerStatus,
    annualRevenue: s.AnnualRevenue || 0,
    annualRevenueCurrency: s.AnnualRevenueCurrency,
    customerPriority: s.CustomerPriority || 0,
    rating: s.Rating,
  };
}

/**
 * Delivery performance for the customer over the last 12 months, split into
 * two halves so a trend can be derived.
 */
async function getCustomerDeliveryHistory(bp) {
  const now = new Date();
  const since = new Date(now - 365 * DAY_MS);
  const midpoint = new Date(now - 182 * DAY_MS);
  const select = 'SalesOrder,Amount,OrderDate,PlannedDeliveryDate,CustomerRequestedDeliveryDate,DeliveryDate,DeliveredQuantity,OrderedQuantity';
  const { rows } = await lnGetAll(
    `/odata/tdapi.slsSalesOrder/Lines?$filter=SoldtoBusinessPartner eq '${esc(bp)}' and OrderDate ge ${isoDate(since)}&$select=${select}`,
    { maxRows: 3000, pageSize: 500 }
  );

  const isLate = (r) => {
    const requested = r.CustomerRequestedDeliveryDate && new Date(r.CustomerRequestedDeliveryDate);
    if (!requested) return false;
    const actual = r.DeliveredQuantity > 0 && r.DeliveryDate ? new Date(r.DeliveryDate) : null;
    const planned = r.PlannedDeliveryDate && new Date(r.PlannedDeliveryDate);
    return (actual || planned) > requested;
  };

  const rate = (set) => (set.length ? set.filter(isLate).length / set.length : 0);
  const recent = rows.filter((r) => new Date(r.OrderDate) >= midpoint);
  const prior = rows.filter((r) => new Date(r.OrderDate) < midpoint);

  let trend = 'Stable';
  if (!rows.length) trend = 'No recent orders';
  else if (recent.length && prior.length) {
    if (rate(recent) - rate(prior) > 0.05) trend = 'Declining';
    else if (rate(prior) - rate(recent) > 0.05) trend = 'Improving';
  }

  return {
    ordersLast12Months: new Set(rows.map((r) => r.SalesOrder)).size,
    orderValueLast12Months: rows.reduce((sum, r) => sum + (r.Amount || 0), 0),
    delayedOrders: new Set(rows.filter(isLate).map((r) => r.SalesOrder)).size,
    lateRate: rate(rows),
    trend,
  };
}

const CLOSED_CLAIM_STATUSES = new Set(['Closed', 'Canceled', 'Rejected']);

async function getCustomerClaims(bp) {
  const { rows } = await lnGetAll(
    `/odata/tsapi.cmmCustomerClaim/CustomerClaims?$filter=SoldtoBusinessPartner eq '${esc(bp)}'&$select=Claim,Status,ClaimDescription,Problem,ServiceType,CreationDate`,
    { maxRows: 500 }
  );
  const claims = rows.map((c) => ({
    claim: c.Claim,
    status: c.Status,
    description: c.ClaimDescription,
    problem: c.Problem,
    serviceType: c.ServiceType,
    creationDate: c.CreationDate,
    open: !CLOSED_CLAIM_STATUSES.has(c.Status),
  }));
  return {
    totalClaims: claims.length,
    openClaims: claims.filter((c) => c.open).length,
    claims,
  };
}

/**
 * Cstat (customer status) score: a transparent 0–100 composite.
 *   start at 100
 *   − 6 points per open claim (max 36)
 *   − late-delivery rate × 40
 *   − 10 if the delivery trend is declining
 */
function computeCstat({ openClaims, lateRate, trend }) {
  let score = 100;
  score -= Math.min(openClaims * 6, 36);
  score -= Math.round((lateRate || 0) * 40);
  if (trend === 'Declining') score -= 10;
  score = Math.max(0, Math.min(100, score));
  const status = score >= 75 ? 'Healthy' : score >= 50 ? 'Watch' : 'At Risk';
  return { score, status };
}

/**
 * Demo layer: when LN has no priority / annual revenue for the customer,
 * derive believable values from their actual 12-month order volume.
 */
function enrichProfile(profile, history) {
  const spend = history ? history.orderValueLast12Months : 0;
  // Display tier is based on the customer's 12-month spend with us, so key
  // accounts (e.g. Amazon, ~$2.9M) read as Tier 1 whatever LN's priority code is.
  profile.tier = spend >= 1000000 ? 1 : spend >= 250000 ? 2 : 3;
  if (!(profile.customerPriority > 0)) {
    profile.customerPriority = spend >= 1000000 ? 1 : spend >= 250000 ? 2 : 3;
    profile.demoPriority = true;
  }
  if (!(profile.annualRevenue > 0)) {
    // Our share of the customer's business is roughly 1–4% of their revenue.
    const multiple = 25 + Math.round(seeded(profile.businessPartner) * 75);
    const floor = 2000000 + seeded(`${profile.businessPartner}:rev`) * 18000000;
    profile.annualRevenue = Math.round(Math.max(spend * multiple, floor) / 100000) * 100000;
    profile.annualRevenueCurrency = profile.annualRevenueCurrency || 'USD';
    profile.demoRevenue = true;
  }
}

async function getCustomerInsight(bp) {
  return cached(`customer:${bp}`, CACHE_TTL_MS, async () => {
    const [profile, history, claims] = await Promise.all([
      getCustomerProfile(bp),
      getCustomerDeliveryHistory(bp).catch(() => null),
      getCustomerClaims(bp).catch(() => ({ totalClaims: 0, openClaims: 0, claims: [] })),
    ]);
    if (DEMO_ENRICH) enrichProfile(profile, history);
    const cstat = computeCstat({
      openClaims: claims.openClaims,
      lateRate: history ? history.lateRate : 0,
      trend: history ? history.trend : 'Stable',
    });
    return { profile, history, claims, cstat };
  });
}

// ---------------------------------------------------------------------------
// Capacity (work center load from scheduled production operations)
// ---------------------------------------------------------------------------

function operationHours(op) {
  if (op.MachineHours > 0) return op.MachineHours;
  if (op.LaborHours > 0) return op.LaborHours;
  const t = op.ProductionTime || 0;
  return op.TimeUnit === 'Days' ? t * 8 : t;
}

async function loadCapacity(site) {
  const now = new Date();
  const horizonWeeks = 4;
  const end = new Date(now.getTime() + horizonWeeks * 7 * DAY_MS);
  const siteFilter = site ? ` and WorkCenterSite eq '${esc(site)}'` : '';
  const { rows } = await lnGetAll(
    `/odata/tiapi.sfcProductionOrder/Operations?$filter=PlannedStartDate ge ${isoDate(now)} and PlannedStartDate lt ${isoDate(end)}${siteFilter}&$select=Order,WorkCenter,WorkCenterSite,ProductionTime,MachineHours,LaborHours,TimeUnit,OperationStatus`,
    { maxRows: 10000, pageSize: 1000 }
  );

  const byWc = new Map();
  for (const op of rows) {
    if (op.OperationStatus === 'Completed' || op.OperationStatus === 'Closed') continue;
    const key = `${op.WorkCenterSite}|${op.WorkCenter}`;
    const entry = byWc.get(key) || { site: op.WorkCenterSite, workCenter: op.WorkCenter, hours: 0, operations: 0 };
    entry.hours += operationHours(op);
    entry.operations += 1;
    byWc.set(key, entry);
  }
  return { horizonWeeks, ranked: [...byWc.values()].sort((a, b) => b.hours - a.hours) };
}

async function getCapacity(site) {
  return cached(`capacity:${site || 'all'}`, CACHE_TTL_MS, async () => {
    let { horizonWeeks, ranked } = await loadCapacity(site);
    let scope = 'site';
    if (!ranked.length && site) {
      ({ horizonWeeks, ranked } = await loadCapacity(null));
      scope = 'network';
    }
    const top = ranked[0];
    if (!top) return { site, scope, constraint: null, workCenters: [] };

    let description = null;
    try {
      const wc = await lnGet(`/odata/txest.ProductionWorkCenter/WorkCenters(WorkCenter_='${esc(top.workCenter)}')`);
      description = wc.Description;
    } catch (e) {
      description = null;
    }

    const perWeek = (h) => Math.round((h / horizonWeeks) * 10) / 10;
    let workCenters = ranked.slice(0, 5).map((w) => ({
      workCenter: w.workCenter,
      requiredHoursPerWeek: perWeek(w.hours),
      operations: w.operations,
    }));

    // Demo layer: demo tenants have very few scheduled operations, so the
    // real load is a few hours a week. Present the busiest work center as the
    // overloaded constraint (105–118%) and the rest at a realistic 55–90%.
    let demoLoad = false;
    if (DEMO_ENRICH) {
      demoLoad = true;
      workCenters = workCenters.map((w, i) => {
        const pct = i === 0
          ? 1.05 + seeded(`${top.site}|${w.workCenter}`) * 0.13
          : 0.55 + seeded(`${top.site}|${w.workCenter}`) * 0.35;
        return { ...w, requiredHoursPerWeek: Math.round(WEEKLY_CAPACITY_HOURS * pct * 10) / 10 };
      });
    }

    const constraintHours = workCenters[0].requiredHoursPerWeek;
    return {
      site: top.site,
      scope,
      horizonWeeks,
      weeklyCapacityHours: WEEKLY_CAPACITY_HOURS,
      capacityIsAssumed: !process.env.WC_WEEKLY_CAPACITY_HOURS_CONFIRMED,
      demoLoad,
      constraint: {
        workCenter: top.workCenter,
        description,
        requiredHoursPerWeek: constraintHours,
        operations: top.operations,
        utilization: Math.round((constraintHours / WEEKLY_CAPACITY_HOURS) * 100),
      },
      workCenters,
    };
  });
}

// ---------------------------------------------------------------------------
// Inventory for the ordered item
// ---------------------------------------------------------------------------

async function getItemInventory(item, warehouse) {
  if (!item) return null;
  const load = async (filter) => lnGetAll(
    `/odata/whapi.inrStockPointInventory/Inventory?$filter=${filter}&$select=Warehouse,InventoryOnHand,InventoryAllocated,InventoryOnOrder,InventoryBlocked`,
    { maxRows: 200 }
  );
  try {
    // LN item codes are left-padded; try the trimmed code, then padded to 47.
    let { rows } = await load(`Item eq '${esc(item)}'`);
    if (!rows.length) ({ rows } = await load(`Item eq '${esc(item.padStart(47, ' '))}'`));
    if (warehouse) {
      const inWh = rows.filter((r) => r.Warehouse === warehouse);
      if (inWh.length) rows = inWh;
    }
    const sum = (k) => rows.reduce((s, r) => s + (r[k] || 0), 0);
    return {
      item,
      onHand: sum('InventoryOnHand'),
      allocated: sum('InventoryAllocated'),
      onOrder: sum('InventoryOnOrder'),
      blocked: sum('InventoryBlocked'),
      available: sum('InventoryOnHand') - sum('InventoryAllocated') - sum('InventoryBlocked'),
    };
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// GenAI analysis
// ---------------------------------------------------------------------------

function extractJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('No JSON object in GenAI response');
  return JSON.parse(text.slice(start, end + 1));
}

function validateAnalysis(a) {
  if (!a || typeof a.riskSummary !== 'string') throw new Error('Missing riskSummary');
  if (!Array.isArray(a.scenarios) || a.scenarios.length < 3) throw new Error('Expected 3 scenarios');
  if (!a.recommendation || typeof a.recommendation.message !== 'string') throw new Error('Missing recommendation');
  a.scenarios = a.scenarios.slice(0, 3).map((s, i) => ({ ...s, key: ['A', 'B', 'C'][i] }));
  if (!a.scenarios.some((s) => s.recommended)) a.scenarios[0].recommended = true;
  if (!Array.isArray(a.claimReasons)) a.claimReasons = [];
  return a;
}

function parseMoney(value) {
  const n = Number(String(value || '').replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function capWords(text, max) {
  const words = String(text || '').trim().split(/\s+/);
  return words.length > max ? words.slice(0, max).join(' ') : words.join(' ');
}

/**
 * Guard rails on the GenAI output so the numbers on screen always agree with
 * each other and with the live order, whatever the model returns.
 */
function enforceConsistency(a, context) {
  const cur = context.order.currencySymbol;
  const fmt = (n) => `${cur}${Math.round(n).toLocaleString('en-US')}`;

  a.scenarios = a.scenarios.map((s) => ({ ...s, name: capWords(s.name, 4), impact: capWords(s.impact, 6) }));

  // Exactly one recommended scenario.
  let recIndex = a.scenarios.findIndex((s) => s.recommended);
  if (recIndex === -1) recIndex = 0;
  a.scenarios.forEach((s, i) => { s.recommended = i === recIndex; });
  const rec = a.scenarios[recIndex];

  if (rec.cost) a.recommendation.addedCost = rec.cost;

  const protectedCommitments = context.commitmentsAtRisk.rows.reduce((sum, r) => sum + (r.amount || 0), 0);
  const minProtected = context.order.orderAmount || 0;
  if (parseMoney(a.recommendation.revenueProtected) < minProtected) {
    a.recommendation.revenueProtected = fmt(minProtected + protectedCommitments);
  }
  return a;
}

function buildPrompt(context) {
  return `You are the commitment planning assistant inside Infor LN, advising a master planner.
Evaluate whether the new sales order below can be accepted without jeopardizing existing customer commitments.
Use ONLY the facts in the JSON context. Where you estimate costs or confidence, keep them realistic and consistent with the order value and currency (${context.order.currency}).
Write in concise executive business language. Do not mention AI, models, prompts, JSON, or data sources.

CONTEXT:
${JSON.stringify(context, null, 2)}

Respond with ONLY a JSON object, no markdown fences, matching exactly this shape:
{
  "riskSummary": "1-2 sentence plain-language summary of the commitment risk if the order is accepted as-is",
  "riskLevel": "Low" | "Medium" | "High",
  "confidence": "Low" | "Medium" | "High",
  "affectedOrders": <integer>,
  "recommendedAction": "short action, max 4 words",
  "scenarios": [
    { "key": "A", "name": "max 3 words", "impact": "max 5 words", "cost": "e.g. +${context.order.currencySymbol}1,200 or ${context.order.currencySymbol}0", "scheduleImpact": "None" | "Low" | "Medium" | "High Risk", "confidence": <integer 0-100>, "recommended": true | false }
  ],
  "recommendation": {
    "message": "2 sentence recommended decision addressed to the planner",
    "revenueProtected": "amount with currency symbol",
    "commitmentsProtected": "e.g. 3 of 3",
    "addedCost": "amount with currency symbol",
    "confidence": <integer 0-100>
  },
  "customerRiskNote": "1 sentence on the business risk for this customer relationship",
  "claimReasons": [ { "reason": "Late Delivery" | "Quality / Defect" | "Order Accuracy" | "Other", "count": <integer> } ]
}
Provide exactly 3 scenarios (keys A, B, C) with exactly one "recommended": true.
Scenario "name" is at most 3 words and "impact" at most 5 words (they appear on small cards).
If capacity.utilization is above 100, scenario A must be "Resequence Production" and be the recommended one; B should be an expedite / overtime / alternate work center option; C should be accepting the delay.
The recommendation must describe the recommended scenario, and recommendation.addedCost must equal that scenario's cost.
recommendation.revenueProtected is the new order's value plus the value of the existing commitments it protects; it can never be less than the order value.
claimReasons must categorize ONLY context.customer.openClaims; counts must sum to its length; use [] if empty.`;
}

function fallbackAnalysis(context) {
  const affected = context.commitmentsAtRisk.atSite || context.commitmentsAtRisk.rows.length;
  const util = context.capacity ? context.capacity.utilization : null;
  const riskLevel = (util !== null && util > 100) || affected > 5 ? 'High' : affected > 0 ? 'Medium' : 'Low';
  const cur = context.order.currencySymbol;
  const value = context.order.orderAmount || 0;
  const fmt = (n) => `${cur}${Math.round(n).toLocaleString('en-US')}`;
  const where = context.order.site || 'this site';
  return {
    riskSummary: affected
      ? `Accepting this order as scheduled puts ${affected} existing commitment${affected === 1 ? '' : 's'} at ${where} at risk${util !== null ? `, with the constraint work center at ${util}% load` : ''}.`
      : 'This order can be accepted without affecting existing commitments.',
    riskLevel,
    confidence: 'Medium',
    affectedOrders: affected,
    recommendedAction: affected ? 'Resequence Production' : 'Accept Order',
    scenarios: [
      { key: 'A', name: 'Resequence Production', impact: 'Protects existing commitments', cost: `+${fmt(value * 0.02)}`, scheduleImpact: 'None', confidence: 90, recommended: true },
      { key: 'B', name: 'Expedite Material', impact: 'Protects existing commitments', cost: `+${fmt(value * 0.05)}`, scheduleImpact: 'Low', confidence: 85, recommended: false },
      { key: 'C', name: 'Accept Delay', impact: 'Customer delivery slips', cost: `${cur}0`, scheduleImpact: 'High Risk', confidence: 95, recommended: false },
    ],
    recommendation: {
      message: `Accept the order and resequence production at ${where}. This protects existing commitments while securing ${fmt(value)} of new revenue.`,
      revenueProtected: fmt(value),
      commitmentsProtected: `${affected} of ${affected}`,
      addedCost: `+${fmt(value * 0.02)}`,
      confidence: 90,
    },
    customerRiskNote: context.customer.cstat.status === 'Healthy'
      ? 'The relationship is in good standing; keep delivery performance on track.'
      : 'Recent claims and late deliveries put this relationship under pressure; another slip could affect future business.',
    claimReasons: context.customer.openClaims.length
      ? [{ reason: 'Other', count: context.customer.openClaims.length }]
      : [],
  };
}

async function getAnalysis(salesOrder) {
  const order = await getOrderReview(salesOrder);
  if (!order) return null;

  return cached(`analysis:${order.salesOrder}`, CACHE_TTL_MS, async () => {
    const firstLine = order.lines[0] || {};
    const [customer, capacity, commitments, inventory] = await Promise.all([
      getCustomerInsight(order.customer),
      getCapacity(order.site).catch(() => null),
      getCommitmentsAtRisk({ site: order.site, excludeOrder: order.salesOrder, limit: 5 }),
      getItemInventory(firstLine.item, firstLine.warehouse || order.warehouse),
    ]);

    const context = {
      order: {
        salesOrder: order.salesOrder,
        orderAmount: order.orderAmount,
        currency: order.currency,
        currencySymbol: order.currencySymbol,
        requestedDeliveryDate: order.requestedDeliveryDate,
        plannedDeliveryDate: order.plannedDeliveryDate,
        rushOrder: order.rushOrder,
        site: order.site,
        lines: order.lines.slice(0, 5),
      },
      customer: {
        name: customer.profile.name,
        priority: customer.profile.customerPriority,
        ordersLast12Months: customer.history && customer.history.ordersLast12Months,
        delayedOrdersLast12Months: customer.history && customer.history.delayedOrders,
        deliveryTrend: customer.history && customer.history.trend,
        cstat: customer.cstat,
        openClaims: customer.claims.claims
          .filter((c) => c.open)
          .slice(0, 20)
          .map((c) => ({ claim: c.claim, status: c.status, description: c.description, problem: c.problem })),
      },
      capacity: capacity && capacity.constraint ? {
        site: capacity.site,
        constraintWorkCenter: capacity.constraint.workCenter,
        constraintDescription: capacity.constraint.description,
        requiredHoursPerWeek: capacity.constraint.requiredHoursPerWeek,
        availableHoursPerWeek: capacity.weeklyCapacityHours,
        utilization: capacity.constraint.utilization,
      } : null,
      inventory,
      commitmentsAtRisk: {
        atSite: commitments.atSite,
        networkTotal: commitments.totalAtRisk,
        rows: commitments.rows.map((r) => ({
          salesOrder: r.salesOrder, customer: r.customer, promisedDate: r.promisedDate,
          riskScore: r.riskScore, impact: r.impact, amount: r.amount,
        })),
      },
    };

    let analysis;
    let source = 'genai';
    try {
      const text = await genaiPrompt(buildPrompt(context), { maxResponse: 1800, temperature: 0.2 });
      analysis = enforceConsistency(validateAnalysis(extractJson(text)), context);
    } catch (err) {
      console.error('[GenAI] analysis failed, using fallback:', err.message, (err.lnBody || '').slice(0, 300));
      analysis = fallbackAnalysis(context);
      source = 'fallback';
    }

    return { salesOrder: order.salesOrder, source, analysis };
  });
}

// ---------------------------------------------------------------------------
// Full workspace payload for one order (everything except GenAI output)
// ---------------------------------------------------------------------------

async function getWorkspace(salesOrder) {
  const order = await getOrderReview(salesOrder);
  if (!order) return null;

  const [kpis, customer, capacity, commitments] = await Promise.all([
    getKpis(),
    getCustomerInsight(order.customer),
    getCapacity(order.site).catch(() => null),
    getCommitmentsAtRisk({ site: order.site, excludeOrder: order.salesOrder, limit: 5 }),
  ]);

  return { order, kpis, customer, capacity, commitments };
}

module.exports = {
  getKpis,
  getWorkspace,
  getAnalysis,
  getOrderReview,
};
