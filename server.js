// server.js
//
// Express server serving the static Intelligent Order Workspace UI and
// proxying live LN data through a small set of routes. The .ionapi
// credentials are loaded and used exclusively server-side (see lnClient.js)
// — they are never exposed to the browser.

const path = require('path');
const express = require('express');
const { lnGet } = require('./lnClient');

const app = express();
const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------------
// Static assets
// ---------------------------------------------------------------------------
app.use(express.static(path.join(__dirname)));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Wraps a route handler so LN errors are logged server-side and returned
 * to the client as a clean JSON error the front end can fall back on,
 * without ever leaking credential details.
 */
function safeRoute(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (err) {
      console.error(`[LN API ERROR] ${req.method} ${req.originalUrl}:`, err.message);
      res.status(err.statusCode && err.statusCode !== 200 ? 502 : 500).json({
        error: true,
        message: 'Live LN data is currently unavailable. The workspace will fall back to sample data.',
        detail: err.message,
      });
    }
  };
}

function odataEscape(value) {
  return String(value).replace(/'/g, "''");
}

// ---------------------------------------------------------------------------
// Widget 1: New Order Review — live Sales Order data
// GET /api/order-review?salesOrder=BA0000001
// ---------------------------------------------------------------------------
app.get('/api/order-review', safeRoute(async (req, res) => {
  const salesOrder = req.query.salesOrder;

  const filterOrTop = salesOrder
    ? `Orders(SalesOrder='${odataEscape(salesOrder)}')`
    : `Orders?$top=1&$orderby=OrderDate desc`;

  const data = await lnGet(`/odata/tdapi.slsSalesOrder/${filterOrTop}`);
  const order = salesOrder ? data : (data.value && data.value[0]);

  if (!order) {
    return res.json({ error: true, message: 'No sales order found.' });
  }

  res.json({
    salesOrder: order.SalesOrder,
    customer: order.SoldtoBusinessPartner,
    orderDate: order.OrderDate,
    requestedDeliveryDate: order.CustomerRequestedDeliveryDate,
    plannedDeliveryDate: order.PlannedDeliveryDate,
    orderAmount: order.OrderAmount,
    currency: order.OrderCurrency,
    status: order.SalesOrderStatus,
    rushOrder: order.RushOrder,
    site: order.Site,
    warehouse: order.Warehouse,
    blocked: order.Blocked,
    canceled: order.Canceled,
  });
}));

// ---------------------------------------------------------------------------
// Widget 4 / Customer Claims widget: live Business Partner data
// GET /api/customer/:id
// ---------------------------------------------------------------------------
app.get('/api/customer/:id', safeRoute(async (req, res) => {
  const businessPartner = req.params.id;

  const data = await lnGet(
    `/odata/tcapi.comBusinessPartner/BusinessPartners(BusinessPartner='${odataEscape(businessPartner)}')`
  );

  res.json({
    businessPartner: data.BusinessPartner,
    name: data.Name,
    website: data.Website,
    businessPartnerStatus: data.BusinessPartnerStatus,
  });
}));

// Fuller "sold-to" record with revenue / priority / rating fields, used for
// the executive-focused fields in Widget 4 (Customer Insight).
app.get('/api/customer/:id/soldto', safeRoute(async (req, res) => {
  const businessPartner = req.params.id;

  const data = await lnGet(
    `/odata/tcapi.comBusinessPartner/SoldtoBusinessPartners(SoldtoBusinessPartner='${odataEscape(businessPartner)}')`
  );

  res.json({
    businessPartner: data.SoldtoBusinessPartner,
    annualRevenue: data.AnnualRevenue,
    annualRevenueCurrency: data.AnnualRevenueCurrency,
    customerPriority: data.CustomerPriority,
    rating: data.Rating,
    ownership: data.Ownership,
    industryCode: data.IndustryCode,
  });
}));

// ---------------------------------------------------------------------------
// Customer Claims & Cstat widget: live Customer Claims data
// GET /api/customer-claims/:businessPartner
// ---------------------------------------------------------------------------
app.get('/api/customer-claims/:businessPartner', safeRoute(async (req, res) => {
  const businessPartner = req.params.businessPartner;

  const data = await lnGet(
    `/odata/tsapi.cmmCustomerClaim/CustomerClaims?$filter=SoldtoBusinessPartner eq '${odataEscape(businessPartner)}'&$top=50`
  );

  const claims = (data.value || []).map((c) => ({
    claim: c.Claim,
    status: c.Status,
    claimOrigin: c.ClaimOrigin,
    claimDescription: c.ClaimDescription,
    problem: c.Problem,
    solution: c.Solution,
    serviceType: c.ServiceType,
    creationDate: c.CreationDate,
    approvalDecision: c.ApprovalDecision,
  }));

  res.json({
    businessPartner,
    openClaimsCount: claims.filter((c) => c.status !== 'Closed' && c.status !== 'Canceled').length,
    totalClaimsCount: claims.length,
    claims,
  });
}));

// ---------------------------------------------------------------------------
// Material feasibility narrative: live Inventory data
// GET /api/inventory/:item?warehouse=UK0010
// ---------------------------------------------------------------------------
app.get('/api/inventory/:item', safeRoute(async (req, res) => {
  const item = req.params.item;
  const warehouse = req.query.warehouse;

  const filter = warehouse
    ? `$filter=Item eq '${odataEscape(item)}' and Warehouse eq '${odataEscape(warehouse)}'`
    : `$filter=Item eq '${odataEscape(item)}'`;

  const data = await lnGet(`/odata/whapi.inrStockPointInventory/Inventory?${filter}&$top=10`);

  const rows = (data.value || []).map((r) => ({
    warehouse: r.Warehouse,
    item: r.Item,
    lot: r.Lot,
    onHand: r.InventoryOnHand,
    allocated: r.InventoryAllocated,
    onOrder: r.InventoryOnOrder,
    committed: r.InventoryCommitted,
    blocked: r.InventoryBlocked,
  }));

  const totalOnHand = rows.reduce((sum, r) => sum + (r.onHand || 0), 0);
  const totalAllocated = rows.reduce((sum, r) => sum + (r.allocated || 0), 0);

  res.json({
    item,
    totalOnHand,
    totalAllocated,
    available: totalOnHand - totalAllocated,
    warehouses: rows,
  });
}));

// ---------------------------------------------------------------------------
// Health check — confirms server is up and whether LN credentials loaded,
// without making a live call or exposing any secret values.
// ---------------------------------------------------------------------------
app.get('/api/health', (req, res) => {
  try {
    require('./lnClient').getBaseUrl();
    res.json({ status: 'ok', lnConfigLoaded: true });
  } catch (err) {
    res.json({ status: 'degraded', lnConfigLoaded: false, message: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Intelligent Order Workspace server running at http://localhost:${PORT}`);
});
