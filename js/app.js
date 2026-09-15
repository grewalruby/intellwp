// ===========================================================
// Commitment Risk Workspace — Interactivity Layer
// Prototype only: simulates planner actions with visual feedback.
// ===========================================================

(function () {
  'use strict';

  const toastEl = document.getElementById('toast');
  let toastTimer = null;

  function showToast(message) {
    if (!toastEl) return;
    toastEl.innerHTML =
      '<span class="toast-icon"><svg viewBox="0 0 24 24" width="12" height="12" fill="#fff"><path d="M9 16.2L4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg></span>' +
      '<span>' + message + '</span>';
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 3200);
  }

  // ---------- Widget 1: New Order Review actions ----------

  const btnAccept = document.getElementById('btn-accept-order');
  const btnEvaluate = document.getElementById('btn-evaluate-impact');
  const btnAlternatives = document.getElementById('btn-view-alternatives');
  const statusTag = document.querySelector('.widget--primary .status-tag');

  if (btnAccept) {
    btnAccept.addEventListener('click', () => {
      if (statusTag) {
        statusTag.textContent = 'Accepted — Resequencing';
        statusTag.className = 'status-tag status-tag--high-confidence';
      }
      btnAccept.textContent = 'Order Accepted';
      btnAccept.disabled = true;
      showToast('Order SO-48392 accepted. Production resequencing at Plant B initiated.');
    });
  }

  if (btnEvaluate) {
    btnEvaluate.addEventListener('click', () => {
      const recoveryWidget = document.querySelector('.widget--hero');
      if (recoveryWidget) {
        recoveryWidget.scrollIntoView({ behavior: 'smooth', block: 'center' });
        recoveryWidget.style.transition = 'box-shadow 0.3s';
        recoveryWidget.style.boxShadow = '0 0 0 2px #0b5fff, 0 8px 20px rgba(11,95,255,0.18)';
        setTimeout(() => { recoveryWidget.style.boxShadow = ''; }, 1600);
      }
      showToast('Impact evaluated: 3 existing commitments at risk. See Recommended Recovery Scenario.');
    });
  }

  if (btnAlternatives) {
    btnAlternatives.addEventListener('click', () => {
      const recoveryWidget = document.querySelector('.widget--hero');
      if (recoveryWidget) {
        recoveryWidget.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      showToast('3 alternative fulfillment scenarios available for review.');
    });
  }

  // ---------- Widget 3: Scenario selection ----------

  const scenarioCards = document.querySelectorAll('.scenario-card');
  const scenarioButtons = document.querySelectorAll('.scenario-select');

  const scenarioLabels = {
    A: 'Option A — Resequence Production',
    B: 'Option B — Expedite Material',
    C: 'Option C — Accept Delay',
  };

  function selectScenario(key) {
    scenarioCards.forEach((card) => {
      const isSelected = card.getAttribute('data-scenario') === key;
      card.classList.toggle('scenario-card--recommended', isSelected || card.getAttribute('data-scenario') === 'A' && key === 'A');
    });

    // Reset all cards then apply recommended styling only to the actively selected one
    scenarioCards.forEach((card) => {
      const isChosen = card.getAttribute('data-scenario') === key;
      card.style.borderColor = isChosen ? 'var(--infor-blue)' : '';
      card.style.boxShadow = isChosen
        ? '0 0 0 1px #0b5fff, 0 8px 18px rgba(11,95,255,0.12)'
        : '';
    });

    scenarioButtons.forEach((btn) => {
      const key2 = btn.getAttribute('data-scenario');
      if (key2 === key) {
        btn.textContent = 'Selected';
        btn.className = 'btn btn--success btn--block scenario-select';
      } else {
        btn.textContent = 'Select Option ' + key2;
        btn.className = 'btn btn--outline btn--block scenario-select';
      }
    });

    showToast(scenarioLabels[key] + ' selected as recovery plan.');
  }

  scenarioButtons.forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      selectScenario(btn.getAttribute('data-scenario'));
    });
  });

  scenarioCards.forEach((card) => {
    card.addEventListener('click', () => {
      selectScenario(card.getAttribute('data-scenario'));
    });
  });

  // ---------- Right panel: Planner Actions ----------

  const btnApprove = document.getElementById('btn-approve');
  const btnReview = document.getElementById('btn-review');
  const btnEscalate = document.getElementById('btn-escalate');

  if (btnApprove) {
    btnApprove.addEventListener('click', () => {
      btnApprove.textContent = 'Recommendation Approved';
      btnApprove.disabled = true;
      showToast('Recommendation approved. Plant B resequencing plan released to production.');
    });
  }

  if (btnReview) {
    btnReview.addEventListener('click', () => {
      const recoveryWidget = document.querySelector('.widget--hero');
      if (recoveryWidget) {
        recoveryWidget.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      showToast('Opening scenario comparison for planner review.');
    });
  }

  if (btnEscalate) {
    btnEscalate.addEventListener('click', () => {
      showToast('Escalated to Supply Chain Manager for secondary review.');
    });
  }

})();
