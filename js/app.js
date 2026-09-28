// ===========================================================
// Intelligent Order Workspace — Interactivity Layer
// Simulates planner actions with visual feedback. Scenario cards are
// re-rendered by live-data.js, so clicks are handled by delegation.
// ===========================================================

(function () {
  'use strict';

  const toastEl = document.getElementById('toast');
  let toastTimer = null;

  function showToast(message) {
    if (!toastEl) return;
    toastEl.innerHTML =
      '<span class="toast-icon"><svg viewBox="0 0 24 24" width="12" height="12" fill="#fff"><path d="M9 16.2L4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg></span>';
    const text = document.createElement('span');
    text.textContent = message;
    toastEl.appendChild(text);
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 3200);
  }

  const textOf = (id, fallback) => {
    const el = document.getElementById(id);
    return (el && el.textContent.trim()) || fallback;
  };

  function scrollToScenarios(highlight) {
    const recoveryWidget = document.querySelector('.widget--hero');
    if (!recoveryWidget) return;
    recoveryWidget.scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (highlight) {
      recoveryWidget.style.transition = 'box-shadow 0.3s';
      recoveryWidget.style.boxShadow = '0 0 0 2px #0b5fff, 0 8px 20px rgba(11,95,255,0.18)';
      setTimeout(() => { recoveryWidget.style.boxShadow = ''; }, 1600);
    }
  }

  // ---------- Widget 1: New Order Review ----------

  const btnAccept = document.getElementById('btn-accept-order');
  if (btnAccept) {
    btnAccept.addEventListener('click', () => {
      const statusTag = document.getElementById('order-status-tag');
      if (statusTag) {
        statusTag.textContent = 'Accepted';
        statusTag.className = 'status-tag status-tag--high-confidence';
      }
      btnAccept.textContent = 'Order Accepted';
      btnAccept.disabled = true;
      showToast(`Order ${textOf('order-number', '')} accepted. ${textOf('risk-action', 'Recommended plan')} initiated.`);
    });
  }

  const btnEvaluate = document.getElementById('btn-evaluate-impact');
  if (btnEvaluate) {
    btnEvaluate.addEventListener('click', () => {
      scrollToScenarios(true);
      showToast(`Impact evaluated: ${textOf('risk-affected', 'several')} existing commitments at risk.`);
    });
  }

  const btnAlternatives = document.getElementById('btn-view-alternatives');
  if (btnAlternatives) {
    btnAlternatives.addEventListener('click', () => {
      scrollToScenarios(false);
      showToast(textOf('scenario-sub', 'Alternative fulfillment scenarios') + '.');
    });
  }

  // ---------- Widget 3: Scenario selection (delegated) ----------

  function selectScenario(key) {
    const grid = document.getElementById('scenario-grid');
    if (!grid) return;
    let name = '';

    grid.querySelectorAll('.scenario-card').forEach((card) => {
      const isChosen = card.getAttribute('data-scenario') === key;
      card.style.borderColor = isChosen ? 'var(--infor-blue)' : '';
      card.style.boxShadow = isChosen ? '0 0 0 1px #0b5fff, 0 8px 18px rgba(11,95,255,0.12)' : '';
      if (isChosen) {
        const nameEl = card.querySelector('.scenario-name');
        name = nameEl ? nameEl.textContent.trim() : '';
      }
    });

    grid.querySelectorAll('.scenario-select').forEach((btn) => {
      const btnKey = btn.getAttribute('data-scenario');
      if (btnKey === key) {
        btn.textContent = 'Selected';
        btn.className = 'btn btn--success btn--block scenario-select';
      } else {
        btn.textContent = `Select Option ${btnKey}`;
        btn.className = 'btn btn--outline btn--block scenario-select';
      }
    });

    showToast(`Option ${key}${name ? ` — ${name}` : ''} selected as recovery plan.`);
  }

  const scenarioGrid = document.getElementById('scenario-grid');
  if (scenarioGrid) {
    scenarioGrid.addEventListener('click', (e) => {
      const card = e.target.closest('.scenario-card');
      if (!card || !scenarioGrid.contains(card)) return;
      selectScenario(card.getAttribute('data-scenario'));
    });
  }

  // ---------- Right panel: Planner Actions ----------

  const btnApprove = document.getElementById('btn-approve');
  if (btnApprove) {
    btnApprove.addEventListener('click', () => {
      btnApprove.textContent = 'Recommendation Approved';
      btnApprove.disabled = true;
      showToast(`Recommendation approved for ${textOf('order-number', 'this order')}. Plan released to production.`);
    });
  }

  const btnReview = document.getElementById('btn-review');
  if (btnReview) {
    btnReview.addEventListener('click', () => {
      scrollToScenarios(false);
      showToast('Opening scenario comparison for planner review.');
    });
  }

  const btnEscalate = document.getElementById('btn-escalate');
  if (btnEscalate) {
    btnEscalate.addEventListener('click', () => {
      showToast('Escalated to Supply Chain Manager for secondary review.');
    });
  }
})();
