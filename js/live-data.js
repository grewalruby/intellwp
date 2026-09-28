// live-data.js
//
// Loads live LN data and the GenAI analysis from the local backend
// (server.js) and renders every widget in the workspace.
//
//   /api/workspace  -> order, KPIs, customer, claims, capacity, commitments
//   /api/analysis   -> risk summary, recovery scenarios, recommendation,
//                      claim-reason breakdown (slower, loaded second)
//
// If the backend is unreachable (e.g. the static GitHub Pages copy), every
// widget keeps its original sample content.

(function () {
  'use strict';

  let requestSeq = 0;

  // ---------- helpers ----------

  const $ = (id) => document.getElementById(id);

  function setText(id, value) {
    if (value === undefined || value === null || value === '') return;
    const el = $(id);
    if (el) el.textContent = value;
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function setTagClass(el, modifier) {
    if (!el) return;
    el.className = `status-tag status-tag--${modifier}`;
  }

  function formatMoney(amount, symbol) {
    if (amount === undefined || amount === null) return null;
    return `${symbol || ''}${Math.round(amount).toLocaleString('en-US')}`;
  }

  function formatCompact(amount) {
    if (amount === undefined || amount === null) return null;
    const abs = Math.abs(amount);
    if (abs >= 1e6) return `${(amount / 1e6).toFixed(1)}M`;
    if (abs >= 1e3) return `${(amount / 1e3).toFixed(1)}K`;
    return Math.round(amount).toLocaleString('en-US');
  }

  function formatDate(isoString) {
    if (!isoString) return null;
    const d = new Date(isoString);
    if (Number.isNaN(d.getTime())) return null;
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  async function fetchJson(url) {
    const res = await fetch(url);
    let data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (!res.ok || (data && data.error)) {
      const err = new Error((data && data.message) || `Request failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function levelClass(level) {
    return level === 'High' ? 'high' : level === 'Low' ? 'high-confidence' : 'medium';
  }

  function confidenceClass(level) {
    return level === 'High' ? 'high-confidence' : level === 'Low' ? 'high' : 'medium';
  }

  function ringColor(pct, { invert = false } = {}) {
    // invert=false: higher is worse (utilization). invert=true: higher is better (Cstat).
    const bad = invert ? pct < 50 : pct > 100;
    const warn = invert ? pct < 75 : pct > 85;
    if (bad) return 'var(--status-danger-text)';
    if (warn) return 'var(--status-warning-text)';
    return invert ? 'var(--status-success-text)' : 'var(--infor-blue)';
  }

  function setRing(el, pct, color) {
    if (!el) return;
    const clamped = Math.max(0, Math.min(100, pct));
    el.style.setProperty('--pct', clamped);
    el.style.background = `conic-gradient(${color} ${clamped}%, #eef0f3 0)`;
  }

  // ---------- renderers: live LN data ----------

  function renderOrder(order) {
    const sym = order.currencySymbol;
    const firstLine = order.lines && order.lines[0];

    setText('order-number', order.salesOrder);
    setText('order-value', formatMoney(order.orderAmount, sym));
    setText('order-requested-date', formatDate(order.requestedDeliveryDate));
    if (firstLine) {
      const desc = firstLine.itemDescription ? `${firstLine.itemDescription} — ${firstLine.item}` : firstLine.item;
      const more = order.lines.length > 1 ? ` (+${order.lines.length - 1} more)` : '';
      setText('order-item', `${desc}${more}`);
    } else if (order.site) {
      setText('order-item', `Site ${order.site}`);
    }

    const statusTag = $('order-status-tag');
    if (statusTag && order.status) {
      statusTag.textContent = order.status;
      setTagClass(statusTag, 'pending');
    }
    const priorityTag = $('order-priority');
    if (priorityTag) {
      const rush = order.rushOrder === 'Yes';
      priorityTag.textContent = rush ? 'High' : 'Standard';
      setTagClass(priorityTag, rush ? 'high' : 'pending');
    }

    // Reset the Accept button in case a previous order was accepted.
    const acceptBtn = $('btn-accept-order');
    if (acceptBtn) {
      acceptBtn.disabled = false;
      acceptBtn.textContent = 'Accept Order';
    }
    const approveBtn = $('btn-approve');
    if (approveBtn) {
      approveBtn.disabled = false;
      approveBtn.textContent = 'Approve Recommendation';
    }
  }

  function renderKpis(k) {
    setText('kpi-open-orders', k.totalOpenOrders.toLocaleString('en-US'));
    setText('kpi-open-orders-sub', `${k.openLines.toLocaleString('en-US')} open lines across ${k.siteCount} sites`);
    setText('kpi-at-risk', k.commitmentsAtRisk.toLocaleString('en-US'));
    setText('kpi-at-risk-sub', `Late vs. requested date, next ${k.riskWindowDays} days`);
    setText('kpi-exposure', formatCompact(k.revenueExposure));
    setText('kpi-exposure-sub', 'Order value of at-risk commitments');

    if (k.commitmentConfidence !== null && k.commitmentConfidence !== undefined) {
      setText('kpi-confidence', `${k.commitmentConfidence}%`);
      setText('kpi-confidence-sub', `On track, ${k.dueInWindowLines} lines due in ${k.riskWindowDays} days`);
      const tile = $('kpi-confidence') && $('kpi-confidence').closest('.kpi-tile');
      if (tile) {
        tile.classList.remove('kpi-tile--success', 'kpi-tile--warning', 'kpi-tile--danger');
        const c = k.commitmentConfidence;
        tile.classList.add(c >= 85 ? 'kpi-tile--success' : c >= 60 ? 'kpi-tile--warning' : 'kpi-tile--danger');
      }
    }
  }

  function renderCustomer(customer) {
    const p = customer.profile;
    const h = customer.history;

    setText('order-customer', p.name);
    setText('customer-name', p.name);

    const tier = p.tier
      ? `Tier ${p.tier}`
      : p.customerPriority > 0 ? `Tier ${Math.min(p.customerPriority, 3)}` : 'Unassigned';
    setText('customer-tier', tier);
    const tierTag = $('customer-tier-tag');
    if (tierTag) tierTag.textContent = tier;

    const revenueEl = $('customer-revenue');
    if (revenueEl) {
      const label = revenueEl.previousElementSibling;
      if (p.annualRevenue > 0) {
        if (label) label.textContent = 'Annual Revenue';
        revenueEl.textContent = formatMoney(p.annualRevenue, '');
      } else if (h) {
        if (label) label.textContent = 'Order Value (12 mo)';
        revenueEl.textContent = formatMoney(h.orderValueLast12Months, '');
      }
    }

    if (h) {
      setText('customer-trend-label', h.trend);
      const trendEl = $('customer-trend');
      if (trendEl) trendEl.className = `trend ${h.trend === 'Declining' ? 'trend--down' : ''}`;
      const delayedEl = $('customer-delayed');
      if (delayedEl) {
        delayedEl.textContent = `${h.delayedOrders} delayed of ${h.ordersLast12Months} orders`;
        delayedEl.classList.toggle('order-field-value--danger', h.delayedOrders > 0);
      }
      setText('claims-delayed', String(h.delayedOrders));
    }

    // Claims & Cstat
    const c = customer.cstat;
    setText('cstat-value', String(c.score));
    setRing($('cstat-ring'), c.score, ringColor(c.score, { invert: true }));
    const statusTag = $('claims-status-tag');
    if (statusTag) {
      statusTag.textContent = c.status;
      setTagClass(statusTag, c.status === 'Healthy' ? 'high-confidence' : c.status === 'Watch' ? 'medium' : 'high');
    }
    setText('claims-open-count', String(customer.claims.openClaims));
    setText('claims-donut-value', String(customer.claims.openClaims));

    const delayed = h ? h.delayedOrders : 0;
    setText('claims-note',
      `${customer.claims.openClaims} open claim${customer.claims.openClaims === 1 ? '' : 's'} and ${delayed} delayed order${delayed === 1 ? '' : 's'} over the past 12 months put ${p.name} at ${c.status} status.`);
  }

  function renderCapacity(capacity) {
    if (!capacity || !capacity.constraint) {
      setText('capacity-sub', 'No scheduled operations in the next 4 weeks');
      return;
    }
    const k = capacity.constraint;
    const wcLabel = k.description ? `${k.workCenter} (${k.description})` : k.workCenter;
    const scope = capacity.scope === 'network' ? ' — busiest in network' : '';
    setText('capacity-sub', `${capacity.site} — Work Center ${wcLabel}${scope}`);

    setRing($('capacity-ring'), k.utilization, ringColor(k.utilization));
    setText('capacity-ring-value', `${k.utilization}%`);

    setText('capacity-available-label', capacity.capacityIsAssumed ? 'Available Capacity (planned)' : 'Available Capacity');
    setText('capacity-available', `${capacity.weeklyCapacityHours.toLocaleString('en-US')} hrs / week`);
    setText('capacity-required', `${k.requiredHoursPerWeek.toLocaleString('en-US')} hrs / week`);

    const reqPct = Math.min(100, (k.requiredHoursPerWeek / capacity.weeklyCapacityHours) * 100);
    const reqBar = $('capacity-required-bar');
    if (reqBar) reqBar.style.width = `${reqPct}%`;

    const overloadTag = $('capacity-overload');
    if (overloadTag) {
      const diff = k.utilization - 100;
      if (diff > 0) {
        overloadTag.textContent = `+${diff}% over capacity`;
        setTagClass(overloadTag, 'high');
      } else {
        overloadTag.textContent = `${Math.abs(diff)}% headroom`;
        setTagClass(overloadTag, diff > -15 ? 'medium' : 'high-confidence');
      }
    }
  }

  function renderCommitments(commitments) {
    const tbody = $('commitments-tbody');
    if (!tbody) return;

    const siteNote = commitments.atSite ? ` · ${commitments.atSite} at this site` : '';
    setText('commitments-sub', `${commitments.rows.length} of ${commitments.totalAtRisk} shown${siteNote}`);

    if (!commitments.rows.length) {
      tbody.innerHTML = '<tr><td colspan="5">No existing commitments are currently at risk.</td></tr>';
      return;
    }

    tbody.innerHTML = commitments.rows.map((r) => {
      const scoreClass = r.riskScore >= 75 ? 'high' : r.riskScore >= 50 ? 'medium' : 'low';
      return `<tr>
        <td class="cell-link">${escapeHtml(r.salesOrder)}</td>
        <td>${escapeHtml(r.customer)}</td>
        <td>${escapeHtml(formatDate(r.promisedDate) || '—')}</td>
        <td><span class="risk-score risk-score--${scoreClass}">${escapeHtml(r.riskScore)}</span></td>
        <td>${escapeHtml(r.impact)}</td>
      </tr>`;
    }).join('');
  }

  // ---------- renderers: GenAI analysis ----------

  function setAnalysisLoading() {
    setText('risk-summary-text', 'Evaluating the impact of this order on existing customer commitments…');
    const grid = $('scenario-grid');
    if (grid) grid.style.opacity = '0.5';
  }

  function renderScenarios(scenarios) {
    const grid = $('scenario-grid');
    if (!grid) return;
    grid.style.opacity = '';

    grid.innerHTML = scenarios.map((s) => {
      const recommended = Boolean(s.recommended);
      const sched = s.scheduleImpact || '';
      const schedClass = sched === 'None' || sched === 'Low' ? 'fact-value--good' : sched === 'High Risk' || sched === 'High' ? 'fact-value--bad' : '';
      const conf = Math.max(0, Math.min(100, Number(s.confidence) || 0));
      return `<div class="scenario-card${recommended ? ' scenario-card--recommended' : ''}" data-scenario="${escapeHtml(s.key)}" data-name="${escapeHtml(s.name)}">
        ${recommended ? '<div class="scenario-badge">RECOMMENDED</div>' : ''}
        <h3 class="scenario-title">Option ${escapeHtml(s.key)}</h3>
        <p class="scenario-name">${escapeHtml(s.name)}</p>
        <ul class="scenario-facts">
          <li><span class="fact-label">Impact</span><span class="fact-value">${escapeHtml(s.impact)}</span></li>
          <li><span class="fact-label">Cost</span><span class="fact-value">${escapeHtml(s.cost)}</span></li>
          <li><span class="fact-label">Schedule Impact</span><span class="fact-value ${schedClass}">${escapeHtml(sched)}</span></li>
        </ul>
        <div class="confidence-block">
          <div class="confidence-ring" style="--pct:${conf}"><span>${conf}%</span></div>
          <span class="confidence-caption">Confidence</span>
        </div>
        <button class="btn ${recommended ? 'btn--primary' : 'btn--outline'} btn--block scenario-select" data-scenario="${escapeHtml(s.key)}">Select Option ${escapeHtml(s.key)}</button>
      </div>`;
    }).join('');

    setText('scenario-sub', `${scenarios.length} alternatives evaluated`);
  }

  const DONUT_COLORS = ['var(--infor-blue)', 'var(--infor-teal)', '#c7cdd6', '#a15c00'];

  function renderClaimReasons(reasons, openClaims) {
    const donut = $('claims-donut');
    const legend = $('claims-legend');
    if (!donut || !legend) return;

    const items = (reasons || []).filter((r) => r && r.count > 0).slice(0, 4);
    const total = items.reduce((sum, r) => sum + r.count, 0);

    if (!openClaims || !total) {
      donut.style.background = 'conic-gradient(#e2e5e9 0% 100%)';
      legend.innerHTML = '<li>No open claims</li>';
      return;
    }

    let start = 0;
    const stops = items.map((r, i) => {
      const end = start + (r.count / total) * 100;
      const stop = `${DONUT_COLORS[i]} ${start}% ${end}%`;
      start = end;
      return stop;
    });
    donut.style.background = `conic-gradient(${stops.join(', ')})`;

    legend.innerHTML = items.map((r, i) =>
      `<li><span class="legend-dot" style="background:${DONUT_COLORS[i]}"></span>${escapeHtml(r.reason)}<span class="legend-count">${escapeHtml(r.count)}</span></li>`
    ).join('');
  }

  function renderAnalysis(a, openClaims) {
    setText('risk-summary-text', a.riskSummary);

    const levelTag = $('risk-level-tag');
    if (levelTag && a.riskLevel) { levelTag.textContent = a.riskLevel; setTagClass(levelTag, levelClass(a.riskLevel)); }
    const confTag = $('risk-confidence-tag');
    if (confTag && a.confidence) { confTag.textContent = a.confidence; setTagClass(confTag, confidenceClass(a.confidence)); }
    setText('risk-affected', String(a.affectedOrders));
    setText('risk-action', a.recommendedAction);

    renderScenarios(a.scenarios);

    const r = a.recommendation;
    setText('rec-message', r.message);
    setText('rec-revenue', r.revenueProtected);
    setText('rec-commitments', r.commitmentsProtected);
    setText('rec-cost', r.addedCost);
    setText('rec-confidence', r.confidence !== undefined ? `${r.confidence}%` : null);

    setText('customer-risk-note', a.customerRiskNote);
    renderClaimReasons(a.claimReasons, openClaims);
  }

  // ---------- loading ----------

  function getRequestedSalesOrder() {
    return new URLSearchParams(window.location.search).get('salesOrder');
  }

  function updateUrlWithOrder(salesOrder) {
    const url = new URL(window.location.href);
    if (salesOrder) url.searchParams.set('salesOrder', salesOrder);
    else url.searchParams.delete('salesOrder');
    window.history.replaceState({}, '', url);
  }

  function setPickerStatus(message, isError) {
    const statusEl = $('order-picker-status');
    if (!statusEl) return;
    statusEl.textContent = message || '';
    statusEl.classList.toggle('order-picker-status--error', Boolean(isError));
  }

  /**
   * Loads and renders one order. Returns the order on success, null on
   * failure (widgets keep whatever they last showed).
   */
  async function loadOrder(salesOrder) {
    const seq = ++requestSeq;
    const qs = salesOrder ? `?salesOrder=${encodeURIComponent(salesOrder)}` : '';

    setPickerStatus(salesOrder ? `Loading ${salesOrder} from LN…` : 'Loading most recent order from LN…', false);

    let workspace;
    try {
      workspace = await fetchJson(`/api/workspace${qs}`);
    } catch (err) {
      if (seq !== requestSeq) return null;
      console.warn('[live-data] Workspace load failed:', err.message);
      setPickerStatus(err.status === 404
        ? `Could not find order "${salesOrder}" in LN.`
        : 'Live LN data is unavailable — showing sample data.', true);
      return null;
    }
    if (seq !== requestSeq) return null;

    renderOrder(workspace.order);
    renderKpis(workspace.kpis);
    renderCustomer(workspace.customer);
    renderCapacity(workspace.capacity);
    renderCommitments(workspace.commitments);
    setAnalysisLoading();
    setPickerStatus(`Loaded ${workspace.order.salesOrder} · evaluating impact…`, false);

    try {
      const result = await fetchJson(`/api/analysis?salesOrder=${encodeURIComponent(workspace.order.salesOrder)}`);
      if (seq !== requestSeq) return workspace.order;
      renderAnalysis(result.analysis, workspace.customer.claims.openClaims);
      setPickerStatus(`Loaded ${workspace.order.salesOrder}.`, false);
    } catch (err) {
      if (seq !== requestSeq) return workspace.order;
      console.warn('[live-data] Analysis load failed:', err.message);
      const grid = $('scenario-grid');
      if (grid) grid.style.opacity = '';
      setPickerStatus(`Loaded ${workspace.order.salesOrder} · impact analysis unavailable.`, true);
    }

    return workspace.order;
  }

  function initOrderPicker() {
    const input = $('order-picker-input');
    const loadBtn = $('order-picker-load');
    const resetBtn = $('order-picker-reset');
    if (!input || !loadBtn) return;

    const requested = getRequestedSalesOrder();
    if (requested) input.value = requested;

    async function handleLoad() {
      const value = input.value.trim();
      if (!value) {
        setPickerStatus('Enter a sales order number.', true);
        return;
      }
      const order = await loadOrder(value);
      if (order) updateUrlWithOrder(order.salesOrder);
    }

    loadBtn.addEventListener('click', handleLoad);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleLoad();
    });

    if (resetBtn) {
      resetBtn.addEventListener('click', async () => {
        input.value = '';
        updateUrlWithOrder(null);
        await loadOrder(null);
      });
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    initOrderPicker();
    loadOrder(getRequestedSalesOrder());
  });
})();
