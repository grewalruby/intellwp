// live-data.js
//
// Fetches live LN data from the local backend (server.js) and updates the
// workspace widgets in place. If the backend is unavailable, a fetch fails,
// or a field comes back empty, the existing mocked HTML content is left
// untouched — so the workspace always renders something reasonable.
//
// This intentionally does not touch Widget 5 (Capacity Utilization),
// Widget 3 (Recovery Scenarios), or Widget 6 (Existing Commitments) since
// there is no live data source for those yet (see project notes).

(function () {
  'use strict';

  function setText(id, value) {
    if (value === undefined || value === null || value === '') return;
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  }

  function formatCurrency(amount, currency) {
    if (amount === undefined || amount === null) return null;
    try {
      return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: currency || 'USD',
        maximumFractionDigits: 0,
      }).format(amount);
    } catch (e) {
      return `${amount} ${currency || ''}`.trim();
    }
  }

  function formatDate(isoString) {
    if (!isoString) return null;
    try {
      const d = new Date(isoString);
      return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    } catch (e) {
      return null;
    }
  }

  async function fetchJson(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Request to ${url} failed with status ${res.status}`);
    const data = await res.json();
    if (data && data.error) throw new Error(data.message || 'LN data unavailable');
    return data;
  }

  function getRequestedSalesOrder() {
    const params = new URLSearchParams(window.location.search);
    return params.get('salesOrder');
  }

  async function loadOrderReview(salesOrderOverride) {
    try {
      const salesOrder = salesOrderOverride || getRequestedSalesOrder();
      const url = salesOrder
        ? `/api/order-review?salesOrder=${encodeURIComponent(salesOrder)}`
        : '/api/order-review';
      const order = await fetchJson(url);

      setText('order-number', order.salesOrder);
      setText('order-value', formatCurrency(order.orderAmount, order.currency));
      setText('order-requested-date', formatDate(order.requestedDeliveryDate));
      setText('order-item', order.warehouse ? `Warehouse ${order.warehouse} — Site ${order.site}` : null);

      if (order.status) {
        const tag = document.getElementById('order-status-tag');
        if (tag) tag.textContent = order.status;
      }
      if (order.rushOrder) {
        const priorityTag = document.getElementById('order-priority');
        if (priorityTag) priorityTag.textContent = order.rushOrder === 'Yes' ? 'High' : 'Standard';
      }

      // Chain: once we know the customer (business partner) on this order,
      // load their profile and claims too.
      if (order.customer) {
        loadCustomer(order.customer);
        loadCustomerClaims(order.customer);
      }

      return order;
    } catch (err) {
      console.warn('[live-data] Falling back to sample order data:', err.message);
      return null;
    }
  }

  async function loadCustomer(businessPartnerId) {
    try {
      const [profile, soldTo] = await Promise.allSettled([
        fetchJson(`/api/customer/${encodeURIComponent(businessPartnerId)}`),
        fetchJson(`/api/customer/${encodeURIComponent(businessPartnerId)}/soldto`),
      ]);

      if (profile.status === 'fulfilled') {
        setText('order-customer', profile.value.name);
        setText('customer-name', profile.value.name);
      }

      if (soldTo.status === 'fulfilled') {
        const s = soldTo.value;
        if (s.annualRevenue) {
          setText('customer-revenue', formatCurrency(s.annualRevenue, s.annualRevenueCurrency));
        }
        if (s.customerPriority !== undefined && s.customerPriority !== null && s.customerPriority > 0) {
          const tierLabel = `Tier ${s.customerPriority}`;
          setText('customer-tier', tierLabel);
          const tierTag = document.getElementById('customer-tier-tag');
          if (tierTag) tierTag.textContent = tierLabel;
        }
      }
    } catch (err) {
      console.warn('[live-data] Falling back to sample customer data:', err.message);
    }
  }

  async function loadCustomerClaims(businessPartnerId) {
    try {
      const claims = await fetchJson(`/api/customer-claims/${encodeURIComponent(businessPartnerId)}`);
      // Only override the mocked value if the live tenant actually has claims
      // recorded for this customer; otherwise the illustrative mock stands.
      if (claims.openClaimsCount > 0) {
        setText('claims-open-count', String(claims.openClaimsCount));
      }
    } catch (err) {
      console.warn('[live-data] Falling back to sample claims data:', err.message);
    }
  }

  function updateUrlWithOrder(salesOrder) {
    const url = new URL(window.location.href);
    if (salesOrder) {
      url.searchParams.set('salesOrder', salesOrder);
    } else {
      url.searchParams.delete('salesOrder');
    }
    window.history.replaceState({}, '', url);
  }

  function setPickerStatus(message, isError) {
    const statusEl = document.getElementById('order-picker-status');
    if (!statusEl) return;
    statusEl.textContent = message || '';
    statusEl.classList.toggle('order-picker-status--error', Boolean(isError));
  }

  function initOrderPicker() {
    const input = document.getElementById('order-picker-input');
    const loadBtn = document.getElementById('order-picker-load');
    const resetBtn = document.getElementById('order-picker-reset');

    if (!input || !loadBtn) return;

    const requested = getRequestedSalesOrder();
    if (requested) input.value = requested;

    async function handleLoad() {
      const value = input.value.trim();
      if (!value) {
        setPickerStatus('Enter a sales order number.', true);
        return;
      }
      setPickerStatus('Loading…', false);
      const order = await loadOrderReview(value);
      if (order) {
        updateUrlWithOrder(value);
        setPickerStatus(`Loaded ${order.salesOrder}.`, false);
      } else {
        setPickerStatus(`Could not find order "${value}" — showing sample data.`, true);
      }
    }

    loadBtn.addEventListener('click', handleLoad);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleLoad();
    });

    if (resetBtn) {
      resetBtn.addEventListener('click', async () => {
        input.value = '';
        setPickerStatus('Loading most recent order…', false);
        const order = await loadOrderReview(null);
        updateUrlWithOrder(null);
        setPickerStatus(order ? `Loaded most recent order ${order.salesOrder}.` : '', !order);
      });
    }
  }

  // Kick off loading once the DOM is ready. Each loader fails independently
  // and silently, so a single bad response never breaks the rest of the page.
  document.addEventListener('DOMContentLoaded', () => {
    initOrderPicker();
    loadOrderReview();
  });
})();
