(function() {
  const hash = window.location.hash;
  if (hash && hash.includes('auth=')) {
    const match = hash.match(/auth=([^&]+)/);
    if (match) {
      try { localStorage.setItem('auth_token', decodeURIComponent(match[1])); } catch(e) {}
      history.replaceState(null, '', window.location.pathname + window.location.search);
    }
  }
})();
function getAuthToken() { try { return localStorage.getItem('auth_token'); } catch(e) { return null; } }

let currentUser = null;
let selectedAcquereur = null;
let allResults = [];
let selectedBiens = new Set();
let currentFilter = 'non_traite';
let secteurs = [];

let dashData = null;
let dashFilter = 'todos';
let dashSearchQuery = '';
let dashSelectedBiens = {};
let dashVisibleCount = 20;

async function init() {
  try {
    const res = await fetch('/api/me');
    if (!res.ok) { localStorage.removeItem('auth_token'); window.location.href = '/login.html'; return; }
    const data = await res.json();
    currentUser = data.user;
    document.getElementById('userName').textContent = currentUser.name;
    if (currentUser.role === 'admin') document.getElementById('btnAdminOwners').style.display = 'flex';

    if (data.impersonating) {
      document.getElementById('impersonateBadge').textContent = '👁 ' + data.impersonateName;
      document.getElementById('impersonateBadge').style.display = 'inline-block';
    }

    if (currentUser.role === 'admin' || currentUser.role === 'manager') {
      loadImpersonationTargets(data.impersonating);
    }

    loadDashboard();
    loadEmailQueueBadge();
  } catch(e) { window.location.href = '/login.html'; }
}

async function loadImpersonationTargets(currentImpersonation) {
  try {
    const res = await fetch('/api/impersonation/targets');
    const data = await res.json();
    if (!data.targets || !data.targets.length) return;
    const select = document.getElementById('impersonateSelect');
    select.innerHTML = '<option value="">-- Moi-même --</option>';
    data.targets.forEach(t => {
      const opt = document.createElement('option');
      opt.value = t.owner_email;
      opt.textContent = t.owner_name || t.owner_email;
      if (currentImpersonation === t.owner_email) opt.selected = true;
      select.appendChild(opt);
    });
    document.getElementById('impersonateBar').style.display = 'inline-block';
  } catch(e) { console.error('Impersonation targets error:', e); }
}

async function switchImpersonate(email) {
  try {
    const res = await fetch('/api/impersonate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email || null })
    });
    const data = await res.json();
    if (!data.success) { alert(data.error || 'Erreur'); return; }

    const badge = document.getElementById('impersonateBadge');
    if (data.impersonating) {
      badge.textContent = '👁 ' + data.impersonateName;
      badge.style.display = 'inline-block';
      document.getElementById('impersonateSelect').value = data.impersonating;
    } else {
      badge.style.display = 'none';
      document.getElementById('impersonateSelect').value = '';
    }

    dashData = null;
    selectedAcquereur = null;
    allResults = [];
    recentBiensLoaded = false;
    loadDashboard();
  } catch(e) { console.error('Impersonate error:', e); }
}

function switchTab(tab) {
  document.querySelectorAll('.tab-btn').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  document.querySelectorAll('.tab-content').forEach(t => t.classList.toggle('active', t.id === 'tab-' + tab));
  if (tab === 'todos' && !dashData) loadDashboard();
  if (tab === 'bien-acq' && !selectedBien) loadRecentBiens();
  recentBiensLoaded = false;
}

// ============================================================
//  DASHBOARD — Biens à envoyer
// ============================================================
async function loadDashboard() {
  const area = document.getElementById('dashboardArea');
  area.innerHTML = '<div class="loading"><i class="fas fa-spinner"></i><p>Chargement...</p></div>';
  try {
    const hide = document.getElementById('todosHideDelegation').checked;
    const res = await fetch('/api/todos/dashboard?hideDelegation=' + hide);
    dashData = await res.json();
    dashSelectedBiens = {};
    document.getElementById('tabTodosCount').textContent = dashData.total_todos;
    document.getElementById('pillTodos').textContent = dashData.total_todos;
    document.getElementById('pillDone').textContent = dashData.total_traites;
    updateNotificationBadge(dashData.pending_queue || 0);
    renderDashboard();
  } catch(e) {
    area.innerHTML = '<div class="empty-state"><i class="fas fa-exclamation-triangle"></i><h3>Erreur</h3><p>' + esc(e.message) + '</p></div>';
  }
}

function dashLoadMore() {
  dashVisibleCount += 20;
  renderDashboard();
}

function setDashFilter(f, btn) {
  dashVisibleCount = 20;
  dashFilter = f;
  document.querySelectorAll('.filter-pill').forEach(p => p.classList.toggle('active', p.dataset.dfilter === f));
  const sectionTitle = document.querySelector('#tab-todos .section-title');
  const sectionSubtitle = document.querySelector('#tab-todos .section-subtitle');
  if (f === 'todos') {
    sectionTitle.innerHTML = '<i class="fas fa-paper-plane"></i> Biens à envoyer';
    sectionSubtitle.innerHTML = 'Biens à envoyer par Acquéreur <span class="info-circle" title="Liste de tous vos acquéreurs avec les biens correspondant à leurs critères">i</span>';
    document.getElementById('todosInfoBanner').querySelector('span').textContent = 'Biens correspondant aux critères de vos acquéreurs, en attente d\'envoi';
  } else {
    sectionTitle.innerHTML = '<i class="fas fa-check-circle" style="color:var(--primary)"></i> Déjà traités';
    sectionSubtitle.innerHTML = 'Historique des biens traités par Acquéreur <span class="info-circle" title="Biens déjà traités ou retirés">i</span>';
    document.getElementById('todosInfoBanner').querySelector('span').textContent = 'Biens déjà traités ou retirés';
  }
  renderDashboard();
}

function filterDashboard() {
  dashSearchQuery = document.getElementById('todosSearch').value.toLowerCase().trim();
  dashVisibleCount = 20;
  renderDashboard();
}

function getFilteredDashData() {
  if (!dashData) return [];
  return dashData.acquereurs.map(acq => {
    let biens = acq.biens;
    if (dashFilter === 'todos') biens = biens.filter(b => !b.statut_todo || b.statut_todo === 'non_traite');
    else biens = biens.filter(b => b.statut_todo === 'envoye' || b.statut_todo === 'refuse');

    if (dashSearchQuery) {
      const q = dashSearchQuery;
      const acqMatch = acq.titre.toLowerCase().includes(q) ||
        String(acq.pipedrive_deal_id).includes(q) ||
        (acq.contact_name || '').toLowerCase().includes(q);
      if (!acqMatch) {
        biens = biens.filter(b =>
          (b.titre || '').toLowerCase().includes(q) ||
          (b.adresse || '').toLowerCase().includes(q) ||
          String(b.pipedrive_deal_id).includes(q)
        );
      }
    }
    return { ...acq, filteredBiens: biens };
  }).filter(a => a.filteredBiens.length > 0);
}

function renderDashboard() {
  const filtered = getFilteredDashData();
  const area = document.getElementById('dashboardArea');

  const totalBiens = filtered.reduce((s, a) => s + a.filteredBiens.length, 0);
  const totalAll = dashData ? (dashFilter === 'todos' ? dashData.total_todos : dashData.total_traites) : 0;
  const selectedCount = Object.values(dashSelectedBiens).reduce((s, set) => s + set.size, 0);
  const selectedAcqCount = Object.values(dashSelectedBiens).filter(s => s.size > 0).length;

  document.getElementById('statAcqCount').textContent = filtered.length;
  document.getElementById('statSelectedCount').textContent = selectedCount;
  document.getElementById('statSelectedAcq').textContent = selectedAcqCount;

  const traites = dashData ? dashData.total_traites : 0;
  const total = dashData ? (dashData.total_todos + dashData.total_traites) : 0;
  const pct = total > 0 ? Math.round(traites / total * 100) : 0;
  document.getElementById('progressFill').style.width = pct + '%';
  document.getElementById('progressText').textContent = traites + '/' + total + ' (' + pct + '%)';

  if (!filtered.length) {
    area.innerHTML = '<div class="empty-state"><i class="fas fa-check-circle" style="color:var(--success)"></i><h3>Rien à afficher</h3><p>Aucun bien correspondant à ce filtre.</p></div>';
    return;
  }

  const visible = filtered.slice(0, dashVisibleCount);
  const remaining = filtered.length - visible.length;
  let html = '<div class="acq-list">' + visible.map(acq => renderAcqRow(acq)).join('') + '</div>';
  if (remaining > 0) {
    html += '<div style="text-align:center;padding:20px 0;"><button class="btn-load-more" onclick="dashLoadMore()"><span>Charger plus</span> <i class="fas fa-chevron-down"></i><span style="margin-left:8px;color:var(--text-light);font-size:12px;">(' + remaining + ' restant' + (remaining > 1 ? 's' : '') + ')</span></button></div>';
  }
  area.innerHTML = html;
}

function renderAcqRow(acq) {
  const biens = acq.filteredBiens;
  const count = biens.length;
  const isGray = dashFilter !== 'todos';
  const acqSelected = dashSelectedBiens[acq.id] || new Set();
  const allChecked = biens.length > 0 && biens.every(b => acqSelected.has(b.id));

  return `
    <div class="acq-row" id="acq-row-${acq.id}">
      <div class="acq-header" onclick="toggleAcqRow(${acq.id}, event)">
        <input type="checkbox" ${allChecked ? 'checked' : ''} onclick="event.stopPropagation(); toggleAcqCheckAll(${acq.id}, this.checked)">
        <div class="acq-name-col">
          <div class="acq-name-text">${esc(acq.titre)} <span class="acq-id">(#${acq.pipedrive_deal_id})</span>${acq.contact_phone ? ' <span title="SMS disponible: ' + esc(acq.contact_phone) + '" style="color:#2980b9;font-size:12px;margin-left:2px;"><i class="fas fa-mobile-alt"></i></span>' : ''}</div>
        </div>
        <div class="acq-badges">
          <span class="acq-count-badge ${isGray ? 'gray' : ''}">${count} bien(s)</span>
          <a class="acq-details-link" onclick="event.stopPropagation(); openAcqDetail(${acq.id})">
            <i class="fas fa-info-circle"></i> Détails
          </a>
          <i class="fas fa-chevron-down acq-expand"></i>
        </div>
      </div>
      <div class="acq-biens">
        ${biens.map(b => renderDashBienRow(acq.id, b, acqSelected.has(b.id))).join('')}
      </div>
    </div>
  `;
}

function renderDashBienRow(acqId, bien, checked) {
  const statut = bien.statut_todo || 'non_traite';
  const statutLabel = statut === 'envoye' ? 'Envoyé' : statut === 'refuse' ? 'Retiré' : 'À traiter';
  const statutClass = statut === 'envoye' ? 'envoye' : statut === 'refuse' ? 'refuse' : 'a-traiter';
  const photo = bien.photo_1 || bien.photo_2;
  const thumbHtml = photo
    ? '<img src="/api/proxy-image?url=' + encodeURIComponent(photo) + '" onerror="this.parentNode.innerHTML=\'<div class=no-thumb><i class=fas\\ fa-home></i></div>\'" alt="">'
    : '<div class="no-thumb"><i class="fas fa-home"></i></div>';
  const addrParts = [bien.adresse, bien.code_postal, bien.ville].filter(Boolean);
  const addrText = addrParts.join(', ');

  let statsHtml = '';
  if (bien.prix_fai) statsHtml += '<span class="bien-info-stat"><i class="fas fa-euro-sign"></i>' + formatPrice(bien.prix_fai) + '</span>';
  const renta = bien.rentabilite_actuelle || bien.rentabilite;
  if (renta) statsHtml += '<span class="bien-info-stat"><i class="fas fa-percentage"></i>' + Number(renta).toFixed(1) + '%</span>';
  if (bien.surface) statsHtml += '<span class="bien-info-stat"><i class="fas fa-ruler-combined"></i>' + bien.surface + ' m²</span>';

  return `
    <div class="bien-row" id="dash-bien-${acqId}-${bien.id}">
      <input type="checkbox" ${checked ? 'checked' : ''} ${statut === 'envoye' ? 'disabled' : ''} onclick="toggleDashBien(${acqId}, ${bien.id}, this.checked)">
      <div class="bien-connector"></div>
      <div class="bien-row-thumb">${thumbHtml}</div>
      <div class="bien-info">
        <div class="bien-info-title">${esc(bien.titre || 'Sans titre')}</div>
        <div class="bien-info-details"><i class="fas fa-map-marker-alt" style="color:var(--primary);font-size:11px;margin-right:4px;"></i>${esc(addrText)}</div>
        ${statsHtml ? '<div class="bien-info-stats">' + statsHtml + '</div>' : ''}
      </div>
      <div class="bien-row-actions">
        ${statut !== 'envoye' ? `<div class="bien-channel-btns">
          <button class="btn-envoyer" onclick="dashAction(${acqId}, ${bien.id}, 'envoye', 'email')" title="Envoyer par Email"><i class="fas fa-envelope"></i> Email</button>
          <button class="btn-envoyer" style="background:#2980b9;border-color:#2980b9;" onclick="dashAction(${acqId}, ${bien.id}, 'envoye', 'sms')" title="Envoyer par SMS"><i class="fas fa-sms"></i> SMS</button>
          <button class="btn-envoyer" style="background:#25D366;border-color:#25D366;" onclick="openWhatsAppPreview(${acqId}, [${bien.id}])" title="Envoyer par WhatsApp"><i class="fab fa-whatsapp"></i></button>
        </div>
        <button class="btn-retirer" onclick="dashAction(${acqId}, ${bien.id}, 'refuse')"><i class="fas fa-times"></i> Retirer</button>` : `<span style="color:#888;font-size:12px;"><i class="fas fa-check-circle" style="color:#27ae60;"></i> Déjà traité</span>`}
      </div>
    </div>
  `;
}

function toggleAcqRow(acqId, event) {
  if (event.target.tagName === 'INPUT') return;
  const row = document.getElementById('acq-row-' + acqId);
  row.classList.toggle('open');
}

function toggleAcqCheckAll(acqId, checked) {
  if (!dashData) return;
  const acq = getFilteredDashData().find(a => a.id === acqId);
  if (!acq) return;
  if (!dashSelectedBiens[acqId]) dashSelectedBiens[acqId] = new Set();
  if (checked) acq.filteredBiens.filter(b => b.statut_todo !== 'envoye').forEach(b => dashSelectedBiens[acqId].add(b.id));
  else dashSelectedBiens[acqId].clear();
  renderDashboard();
}

function toggleDashBien(acqId, bienId, checked) {
  if (!dashSelectedBiens[acqId]) dashSelectedBiens[acqId] = new Set();
  if (checked) dashSelectedBiens[acqId].add(bienId);
  else dashSelectedBiens[acqId].delete(bienId);
  const selectedCount = Object.values(dashSelectedBiens).reduce((s, set) => s + set.size, 0);
  const selectedAcqCount = Object.values(dashSelectedBiens).filter(s => s.size > 0).length;
  document.getElementById('statSelectedCount').textContent = selectedCount;
  document.getElementById('statSelectedAcq').textContent = selectedAcqCount;
}

function dashSelectAll() {
  const filtered = getFilteredDashData();
  filtered.forEach(acq => {
    dashSelectedBiens[acq.id] = new Set(acq.filteredBiens.map(b => b.id));
  });
  renderDashboard();
  document.querySelectorAll('.acq-row').forEach(row => row.classList.add('open'));
}

function dashDeselectAll() {
  dashSelectedBiens = {};
  renderDashboard();
}

async function dashAction(acqId, bienId, statut, channel) {
  if (statut === 'envoye' && channel === 'email') {
    openEmailEditor(acqId, [bienId]);
    return;
  }
  let resp;
  if (statut === 'envoye') {
    const ch = channel || 'email';
    resp = await fetch('/api/email-queue/enqueue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ acquereur_id: acqId, bien_ids: [bienId], channel: ch })
    });
  } else {
    resp = await fetch('/api/todos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ acquereur_id: acqId, bien_id: bienId, statut })
    });
  }
  if (!resp.ok) { showToast('Erreur serveur', 'error'); return; }
  const acq = dashData.acquereurs.find(a => a.id === acqId);
  if (acq) {
    const bien = acq.biens.find(b => b.id === bienId);
    if (bien) {
      const wasTodo = !bien.statut_todo || bien.statut_todo === 'non_traite';
      bien.statut_todo = statut;
      if (wasTodo) { dashData.total_todos--; dashData.total_traites++; }
    }
  }
  document.getElementById('tabTodosCount').textContent = dashData.total_todos;
  document.getElementById('pillTodos').textContent = dashData.total_todos;
  document.getElementById('pillDone').textContent = dashData.total_traites;
  updateNotificationBadge(dashData.pending_queue || 0);
  if (statut === 'envoye') loadEmailQueueBadge();
  renderDashboard();
  if (statut === 'envoye') {
    const result = await resp.clone().json().catch(() => ({}));
    if (result.skipped_duplicates > 0 && result.queued === 0) {
      showToast('Déjà traité — doublon ignoré', 'error');
    } else if (result.skipped_duplicates > 0) {
      showToast(`Envoyé (${result.skipped_duplicates} doublon(s) ignoré(s))`, 'success');
    } else {
      showToast('Bien mis en file d\'envoi', 'success');
    }
  } else {
    showToast('Bien retiré', '');
  }
}

let emailEditorData = null;
let emailEditorQueue = [];
let emailEditorQueueIndex = 0;

async function openEmailEditor(acqId, bienIds) {
  const overlay = document.getElementById('emailEditorOverlay');
  overlay.classList.add('active');
  document.getElementById('emailEditorLoading').style.display = 'flex';
  document.getElementById('emailEditorContent').style.display = 'none';

  const queueInfo = document.getElementById('eeQueueInfo');
  if (queueInfo) {
    if (emailEditorQueue.length > 1) {
      queueInfo.style.display = 'block';
      queueInfo.innerHTML = '<i class="fas fa-users" style="margin-right:6px;color:var(--primary);"></i> Acquéreur ' + (emailEditorQueueIndex + 1) + ' / ' + emailEditorQueue.length;
    } else {
      queueInfo.style.display = 'none';
    }
  }

  try {
    const r = await fetch('/api/email-preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + localStorage.getItem('token') },
      body: JSON.stringify({ acquereur_id: acqId, bien_ids: bienIds })
    });
    const d = await r.json();
    if (!d.success) { showToast(d.error || 'Erreur', 'error'); overlay.classList.remove('active'); processNextEmailInQueue(); return; }

    emailEditorData = d;
    document.getElementById('eeSubject').value = d.subject;
    document.getElementById('eeIntro').value = d.intro;
    document.getElementById('eeOutro').value = d.outro;
    document.getElementById('eeTo').textContent = d.toName + ' <' + d.to + '>';
    document.getElementById('eeFrom').textContent = d.ownerName + ' <' + d.ownerEmail + '>';
    document.getElementById('eeBienPreview').innerHTML = d.bienCardsHtml;

    const modeSection = document.getElementById('eeSendModeSection');
    if (bienIds.length > 1) {
      modeSection.style.display = 'block';
      document.querySelector('input[name="eeSendMode"][value="grouped"]').checked = true;
    } else {
      modeSection.style.display = 'none';
    }

    document.getElementById('emailEditorLoading').style.display = 'none';
    document.getElementById('emailEditorContent').style.display = 'block';
  } catch(e) {
    showToast('Erreur réseau', 'error');
    overlay.classList.remove('active');
    processNextEmailInQueue();
  }
}

function closeEmailEditor() {
  document.getElementById('emailEditorOverlay').classList.remove('active');
  emailEditorData = null;
  processNextEmailInQueue();
}

function processNextEmailInQueue() {
  emailEditorQueueIndex++;
  if (emailEditorQueueIndex < emailEditorQueue.length) {
    const next = emailEditorQueue[emailEditorQueueIndex];
    setTimeout(() => openEmailEditor(next.acqId, next.bienIds), 300);
  } else {
    emailEditorQueue = [];
    emailEditorQueueIndex = 0;
  }
}
function cancelEmailEditor() {
  emailEditorQueue = [];
  emailEditorQueueIndex = 0;
  closeEmailEditor();
}

function onSendModeChange() {
  const mode = document.querySelector('input[name="eeSendMode"]:checked')?.value || 'grouped';
  const btn = document.getElementById('eeSendBtn');
  if (mode === 'separate') {
    btn.innerHTML = '<i class="fas fa-paper-plane"></i> Envoyer ' + emailEditorData.bienIds.length + ' mails séparés';
  } else {
    btn.innerHTML = '<i class="fas fa-paper-plane"></i> Envoyer le mail';
  }
}

function updateDashAfterSend(sentAcqId, sentBienIds) {
  if (dashData?.acquereurs) {
    const acq = dashData.acquereurs.find(a => a.id === sentAcqId);
    if (acq) {
      sentBienIds.forEach(bid => {
        const bien = acq.biens.find(b => b.id === bid);
        if (bien) {
          const wasTodo = !bien.statut_todo || bien.statut_todo === 'non_traite';
          bien.statut_todo = 'envoye';
          if (wasTodo) { dashData.total_todos--; dashData.total_traites++; }
        }
      });
      document.getElementById('tabTodosCount').textContent = dashData.total_todos;
      document.getElementById('pillTodos').textContent = dashData.total_todos;
      document.getElementById('pillDone').textContent = dashData.total_traites;
      updateNotificationBadge(dashData.pending_queue || 0);
      dashSelectedBiens = {};
      renderDashboard();
    }
  }
  sentBienIds.forEach(bid => {
    const b = (typeof allResults !== 'undefined' && allResults) ? allResults.find(x => x.id === bid) : null;
    if (b) b.statut_todo = 'envoye';
  });
  if (typeof allResults !== 'undefined' && allResults?.length) { if (typeof updateCounts === 'function') updateCounts(); if (typeof renderResults === 'function') renderResults(); if (typeof clearSelection === 'function') clearSelection(); }
  const a3 = (typeof allResults3 !== 'undefined' && allResults3) ? allResults3.find(x => x.id === sentAcqId) : null;
  if (a3) { a3.statut_todo = 'envoye'; if (typeof updateCounts3 === 'function') updateCounts3(); if (typeof renderResults3 === 'function') renderResults3(); }
}

async function sendCustomEmail() {
  if (!emailEditorData) return;
  const btn = document.getElementById('eeSendBtn');
  btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Envoi...';

  const sendMode = document.querySelector('input[name="eeSendMode"]:checked')?.value || 'grouped';
  const editedBienHtml = document.getElementById('eeBienPreview').innerHTML;

  try {
    if (sendMode === 'separate' && emailEditorData.bienIds.length > 1) {
      let sentCount = 0;
      for (const bienId of emailEditorData.bienIds) {
        const r = await fetch('/api/email-send-custom', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + localStorage.getItem('token') },
          body: JSON.stringify({
            acquereur_id: emailEditorData.acqId,
            bien_ids: [bienId],
            subject: document.getElementById('eeSubject').value,
            intro: document.getElementById('eeIntro').value,
            outro: document.getElementById('eeOutro').value,
            channel: 'email'
          })
        });
        const d = await r.json();
        if (d.success) sentCount++;
      }
      showToast(sentCount + '/' + emailEditorData.bienIds.length + ' mails envoyés !', 'success');
      const sentAcqId = emailEditorData.acqId;
      const sentBienIds = [...emailEditorData.bienIds];
      closeEmailEditor();
      updateDashAfterSend(sentAcqId, sentBienIds);
    } else {
      const r = await fetch('/api/email-send-custom', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + localStorage.getItem('token') },
        body: JSON.stringify({
          acquereur_id: emailEditorData.acqId,
          bien_ids: emailEditorData.bienIds,
          subject: document.getElementById('eeSubject').value,
          intro: document.getElementById('eeIntro').value,
          outro: document.getElementById('eeOutro').value,
          bienHtml: editedBienHtml,
          channel: 'email'
        })
      });
      const d = await r.json();
      if (d.success) {
        const remainingCount = emailEditorQueue.length > 0 ? emailEditorQueue.length - emailEditorQueueIndex - 1 : 0;
        showToast('Email envoyé !' + (remainingCount > 0 ? ' (' + remainingCount + ' acquéreur(s) restant(s))' : ''), 'success');
        const sentAcqId = emailEditorData.acqId;
        const sentBienIds = [...emailEditorData.bienIds];
        closeEmailEditor();
        updateDashAfterSend(sentAcqId, sentBienIds);
      } else {
        showToast(d.error || 'Erreur', 'error');
      }
    }
  } catch(e) {
    showToast('Erreur réseau', 'error');
  }
  btn.disabled = false; btn.innerHTML = '<i class="fas fa-paper-plane"></i> Envoyer le mail';
}

async function dashBulkAction(statut) {
  const entries = Object.entries(dashSelectedBiens).filter(([,set]) => set.size > 0);
  if (!entries.length) { showToast('Sélectionnez des biens d\'abord', 'error'); return; }
  const channel = document.getElementById('sendChannelSelect')?.value || 'email';

  if (statut === 'envoye' && (channel === 'email' || channel === 'both')) {
    emailEditorQueue = entries.map(([acqIdStr, bienSet]) => ({ acqId: parseInt(acqIdStr), bienIds: [...bienSet] }));
    emailEditorQueueIndex = 0;
    const first = emailEditorQueue[0];
    openEmailEditor(first.acqId, first.bienIds);
    return;
  }

  let totalCount = 0;
  let smsErrors = 0;
  for (const [acqIdStr, bienSet] of entries) {
    const acqId = parseInt(acqIdStr);
    const bienIds = [...bienSet];
    totalCount += bienIds.length;
    let resp;
    if (statut === 'envoye') {
      resp = await fetch('/api/email-queue/enqueue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ acquereur_id: acqId, bien_ids: bienIds, channel })
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        if (err.error && err.error.includes('téléphone')) { smsErrors++; continue; }
      }
    } else {
      resp = await fetch('/api/todos/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ acquereur_id: acqId, bien_ids: bienIds, statut })
      });
    }
    if (!resp.ok) { showToast('Erreur serveur', 'error'); continue; }
    const acq = dashData.acquereurs.find(a => a.id === acqId);
    if (acq) {
      bienIds.forEach(bid => {
        const bien = acq.biens.find(b => b.id === bid);
        if (bien) {
          const wasTodo = !bien.statut_todo || bien.statut_todo === 'non_traite';
          bien.statut_todo = statut;
          if (wasTodo) { dashData.total_todos--; dashData.total_traites++; }
        }
      });
    }
  }
  dashSelectedBiens = {};
  document.getElementById('tabTodosCount').textContent = dashData.total_todos;
  document.getElementById('pillTodos').textContent = dashData.total_todos;
  document.getElementById('pillDone').textContent = dashData.total_traites;
  updateNotificationBadge(dashData.pending_queue || 0);
  loadEmailQueueBadge();
  renderDashboard();
  const channelLabel = channel === 'both' ? '(Email + SMS)' : channel === 'sms' ? '(SMS)' : '(Email)';
  let msg = totalCount + ' bien(s) ' + (statut === 'envoye' ? 'mis en file d\'envoi ' + channelLabel : 'retirés');
  if (smsErrors > 0) msg += ` (${smsErrors} acquéreur(s) sans numéro)`;
  showToast(msg, 'success');
}

// ============================================================
//  MODAL DÉTAILS ACQUÉREUR
// ============================================================
let currentAcqDetailId = null;

async function openAcqDetail(acqId) {
  currentAcqDetailId = acqId;
  const modal = document.getElementById('acqDetailModal');
  modal.style.display = 'flex';
  const content = document.getElementById('acqDetailContent');
  content.innerHTML = '<div class="loading"><i class="fas fa-spinner"></i><p>Chargement...</p></div>';
  try {
    const res = await fetch('/api/acquereurs/' + acqId + '/detail');
    const data = await res.json();
    const a = data.acquereur;
    const occ = a.occupation_status ? JSON.parse(a.occupation_status) : [];
    const sects = a.secteurs ? JSON.parse(a.secteurs) : [];
    const totalRappro = (a.stats_envoyes || 0) + (a.stats_refuses || 0) + (a.stats_a_traiter || 0);

    content.innerHTML =
      '<div style="margin-bottom:20px;">' +
        '<h3 style="font-size:15px; font-weight:700; color:var(--secondary); display:flex; align-items:center; gap:8px; margin-bottom:12px;"><i class="fas fa-user" style="color:var(--primary)"></i> Informations de l\'acquéreur</h3>' +
        '<div style="display:grid; grid-template-columns:1fr 1fr; gap:16px;">' +
          '<div>' +
            '<div style="font-size:11px; font-weight:700; color:var(--text-light); text-transform:uppercase;">ID Pipedrive</div>' +
            '<div style="font-size:15px; font-weight:600;">' + a.pipedrive_deal_id + ' <a href="https://leboutiquier.pipedrive.com/deal/' + a.pipedrive_deal_id + '" target="_blank" style="font-size:12px; color:var(--success);"><i class="fas fa-external-link-alt"></i> Ouvrir dans Pipedrive</a></div>' +
          '</div>' +
          '<div>' +
            '<div style="font-size:11px; font-weight:700; color:var(--text-light); text-transform:uppercase;">Contact</div>' +
            '<div style="font-size:13px; color:var(--text-light);">' + esc(a.contact_name ? a.contact_name + (a.contact_email ? ' · ' + a.contact_email : '') : 'Aucune personne associée') + '</div>' +
            (a.contact_phone ? '<div style="font-size:13px; color:var(--text-light); margin-top:2px;"><i class="fas fa-phone" style="font-size:10px;margin-right:4px;color:var(--success);"></i>' + esc(a.contact_phone) + ' <span style="background:#2980b9;color:white;padding:1px 6px;border-radius:4px;font-size:10px;font-weight:600;">SMS OK</span></div>' : '<div style="font-size:12px;color:var(--danger);margin-top:2px;"><i class="fas fa-phone-slash" style="font-size:10px;margin-right:4px;"></i>Pas de téléphone (SMS indisponible)</div>') +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div style="margin-bottom:20px; padding-top:16px; border-top:1px solid var(--border);">' +
        '<h3 style="font-size:15px; font-weight:700; color:var(--secondary); display:flex; align-items:center; gap:8px; margin-bottom:12px;"><i class="fas fa-chart-bar" style="color:var(--primary)"></i> Statistiques des rapprochements</h3>' +
        '<div style="display:grid; grid-template-columns:repeat(5, 1fr); gap:12px;">' +
          '<div><div style="font-size:11px; font-weight:700; color:var(--text-light); text-transform:uppercase;">Total</div><div style="font-size:24px; font-weight:700;">' + totalRappro + '</div></div>' +
          '<div><div style="font-size:11px; font-weight:700; color:var(--text-light); text-transform:uppercase;">Envoyés</div><div style="font-size:24px; font-weight:700; color:var(--success);">' + (a.stats_envoyes || 0) + '</div></div>' +
          '<div><div style="font-size:11px; font-weight:700; color:var(--text-light); text-transform:uppercase;">Retirés</div><div style="font-size:24px; font-weight:700; color:var(--danger);">' + (a.stats_refuses || 0) + '</div></div>' +
          '<div><div style="font-size:11px; font-weight:700; color:var(--text-light); text-transform:uppercase;">Traités</div><div style="font-size:24px; font-weight:700; color:var(--success);">' + ((a.stats_envoyes || 0) + (a.stats_refuses || 0)) + '</div></div>' +
          '<div><div style="font-size:11px; font-weight:700; color:var(--text-light); text-transform:uppercase;">À traiter</div><div style="font-size:24px; font-weight:700;">' + (a.stats_a_traiter || 0) + '</div></div>' +
        '</div>' +
      '</div>' +
      '<div style="padding-top:16px; border-top:1px solid var(--border);">' +
        '<h3 style="font-size:15px; font-weight:700; color:var(--secondary); display:flex; align-items:center; gap:8px; margin-bottom:14px;"><i class="fas fa-filter" style="color:var(--primary)"></i> Critères de matching</h3>' +
        '<div style="display:grid; grid-template-columns:1fr 1fr 1fr; gap:14px; margin-bottom:16px;">' +
          '<div style="background:#fafafa; border:1px solid var(--border); border-radius:10px; padding:14px;">' +
            '<div style="font-size:11px; font-weight:700; color:var(--text-light); text-transform:uppercase; margin-bottom:6px;"><i class="fas fa-euro-sign" style="color:var(--primary);margin-right:4px;"></i>Budget minimum</div>' +
            '<input type="text" id="detailBudgetMin" value="' + (a.budget_min ? formatNum(a.budget_min) : '') + '" placeholder="Ex: 100 000" oninput="formatBudgetInput(this)" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:8px;font-size:14px;background:white;">' +
          '</div>' +
          '<div style="background:#fafafa; border:1px solid var(--border); border-radius:10px; padding:14px;">' +
            '<div style="font-size:11px; font-weight:700; color:var(--text-light); text-transform:uppercase; margin-bottom:6px;"><i class="fas fa-euro-sign" style="color:var(--primary);margin-right:4px;"></i>Budget maximum</div>' +
            '<input type="text" id="detailBudgetMax" value="' + (a.budget_max ? formatNum(a.budget_max) : '') + '" placeholder="Ex: 500 000" oninput="formatBudgetInput(this)" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:8px;font-size:14px;background:white;">' +
          '</div>' +
          '<div style="background:#fafafa; border:1px solid var(--border); border-radius:10px; padding:14px;">' +
            '<div style="font-size:11px; font-weight:700; color:var(--text-light); text-transform:uppercase; margin-bottom:6px;"><i class="fas fa-percentage" style="color:var(--primary);margin-right:4px;"></i>Rentabilité minimum</div>' +
            '<input type="number" id="detailRentaMin" value="' + (a.rentabilite_min || '') + '" placeholder="Ex: 5.5" step="0.1" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:8px;font-size:14px;background:white;">' +
          '</div>' +
        '</div>' +
        '<div style="display:grid; grid-template-columns:1fr 1fr; gap:14px; margin-bottom:16px;">' +
          '<div style="background:#fafafa; border:1px solid var(--border); border-radius:10px; padding:14px;">' +
            '<div style="font-size:11px; font-weight:700; color:var(--text-light); text-transform:uppercase; margin-bottom:6px;"><i class="fas fa-building" style="color:var(--primary);margin-right:4px;"></i>Statut d\'occupation</div>' +
            '<div>' + (['Occupé','Libre','Location'].map(o => '<label style="display:flex; align-items:center; gap:6px; margin-bottom:4px; font-size:13px;"><input type="checkbox" class="detail-occ-chk" data-val="' + o + '" ' + (occ.includes(o) ? 'checked' : '') + ' style="accent-color:var(--primary);"> ' + o + '</label>').join('')) + '</div>' +
          '</div>' +
          '<div style="background:#fafafa; border:1px solid var(--border); border-radius:10px; padding:14px;">' +
            '<div style="font-size:11px; font-weight:700; color:var(--text-light); text-transform:uppercase; margin-bottom:6px;"><i class="fas fa-map-marker-alt" style="color:var(--primary);margin-right:4px;"></i>Secteurs</div>' +
            '<input type="text" id="detailSecteurs" value="' + (sects.length ? esc(sects.join(', ')) : '') + '" placeholder="75, 92, 00..." style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:8px;font-size:14px;background:white;">' +
          '</div>' +
        '</div>' +
        '<div style="display:flex; gap:10px;">' +
          '<button onclick="updateCriteriaLocal(' + a.id + ')" style="flex:1; text-align:center; padding:12px; background:var(--secondary); color:white; border:none; border-radius:10px; font-size:13px; font-weight:600; cursor:pointer;"><i class="fas fa-save" style="margin-right:6px;"></i> Mettre à jour les critères</button>' +
          '<button onclick="saveCriteriaToPipedrive(' + a.id + ')" id="btnSaveDetailPipedrive" style="flex:1; text-align:center; padding:12px; background:var(--primary); color:white; border:none; border-radius:10px; font-size:13px; font-weight:600; cursor:pointer;"><i class="fas fa-cloud-upload-alt" style="margin-right:6px;"></i> Sauvegarder les critères de matching sur Pipedrive</button>' +
        '</div>' +
      '</div>';
  } catch(e) {
    content.innerHTML = '<div style="color:var(--danger);padding:20px;text-align:center;">Erreur: ' + esc(e.message) + '</div>';
  }
}
function closeAcqDetail() { document.getElementById('acqDetailModal').style.display = 'none'; currentAcqDetailId = null; }

function getDetailCriteria() {
  return {
    budget_min: parseBudget(document.getElementById('detailBudgetMin').value),
    budget_max: parseBudget(document.getElementById('detailBudgetMax').value),
    rentabilite_min: parseFloat(document.getElementById('detailRentaMin').value) || null,
    occupation_status: [...document.querySelectorAll('.detail-occ-chk:checked')].map(c => c.dataset.val),
    secteurs: document.getElementById('detailSecteurs').value.split(',').map(s => s.trim()).filter(Boolean)
  };
}

async function updateCriteriaLocal(acqId) {
  const crit = getDetailCriteria();
  try {
    const res = await fetch('/api/acquereurs/' + acqId + '/criteria', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(crit)
    });
    const data = await res.json();
    if (data.success) {
      showToast('Critères mis à jour localement', 'success');
      if (confirm('Voulez-vous également mettre à jour ces critères sur Pipedrive ?')) {
        await saveCriteriaToPipedrive(acqId);
      }
    } else {
      showToast(data.error || 'Erreur', 'error');
    }
  } catch(e) { showToast(e.message, 'error'); }
}

async function saveCriteriaToPipedrive(acqId) {
  const crit = getDetailCriteria();
  const btn = document.getElementById('btnSaveDetailPipedrive');
  if (!btn) return;
  const original = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin" style="margin-right:6px;"></i> Envoi en cours...';
  try {
    await fetch('/api/acquereurs/' + acqId + '/criteria', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(crit)
    });
    const res = await fetch('/api/acquereurs/' + acqId + '/push-pipedrive', { method: 'POST' });
    const data = await res.json();
    showToast(data.success ? 'Critères sauvegardés dans Pipedrive' : (data.error || 'Erreur'), data.success ? 'success' : 'error');
  } catch(e) { showToast(e.message, 'error'); }
  finally { btn.disabled = false; btn.innerHTML = original; }
}

// ============================================================
//  TAB 2 — Acquéreur → Biens (existing logic)
// ============================================================
async function logout() {
  await fetch('/api/logout', { method: 'POST' });
  localStorage.removeItem('auth_token');
  window.location.href = '/login.html';
}

async function syncAll() {
  const btn = document.getElementById('btnSync');
  btn.classList.add('syncing');
  btn.innerHTML = '<i class="fas fa-sync-alt"></i> Sync...';
  btn.disabled = true;
  try {
    const [r1, r2] = await Promise.all([
      fetch('/api/sync/biens', { method: 'POST' }).then(r => r.json()),
      fetch('/api/sync/acquereurs', { method: 'POST' }).then(r => r.json())
    ]);
    showToast((r1.count || 0) + ' biens et ' + (r2.count || 0) + ' acquéreurs synchronisés', 'success');
    loadDashboard();
  } catch(e) {
    showToast('Erreur de synchronisation', 'error');
  } finally {
    btn.classList.remove('syncing');
    btn.innerHTML = '<i class="fas fa-sync-alt"></i>';
    btn.disabled = false;
  }
}

let searchTimeout = null;
function fmtDate(raw) {
  if (!raw) return '';
  const d = new Date(raw);
  return isNaN(d) ? '' : d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

async function searchAcquereurs(q) {
  if (selectedAcquereur) return;
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(async () => {
    try {
      const url = q.length < 1 ? '/api/acquereurs' : '/api/acquereurs?q=' + encodeURIComponent(q);
      const res = await fetch(url);
      const data = await res.json();
      renderDropdown(data.acquereurs || [], q.length < 1);
    } catch(e) {}
  }, q.length >= 1 ? 250 : 0);
}

function formatDateShort(d) {
  if (!d) return '';
  const dt = new Date(d);
  if (isNaN(dt)) return '';
  return dt.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: '2-digit' });
}

function dealDateInfo(item) {
  const updated = item.pipedrive_updated_at;
  const created = item.pipedrive_created_at;
  if (updated && created && updated !== created) {
    return '<i class="fas fa-pen" style="font-size:9px;margin-right:2px"></i>Modifié le ' + formatDateShort(updated);
  }
  if (created) {
    return '<i class="fas fa-plus-circle" style="font-size:9px;margin-right:2px"></i>Ajouté le ' + formatDateShort(created);
  }
  return '';
}

function pipedriveLink(dealId) {
  return 'https://leboutiquier.pipedrive.com/deal/' + dealId;
}

function acqCriteriaRecap(a) {
  const parts = [];
  if (a.budget_min || a.budget_max) {
    const bMin = a.budget_min ? formatNum(a.budget_min) + '€' : '';
    const bMax = a.budget_max ? formatNum(a.budget_max) + '€' : '';
    if (bMin && bMax) parts.push(bMin + ' → ' + bMax);
    else if (bMin) parts.push('≥ ' + bMin);
    else parts.push('≤ ' + bMax);
  }
  if (a.rentabilite_min) parts.push('Renta ≥ ' + a.rentabilite_min + '%');
  if (a.secteurs) {
    try {
      const s = JSON.parse(a.secteurs);
      if (s.length) parts.push(s.includes('99') ? 'Toute France' : s.join(', '));
    } catch(e) {}
  }
  return parts.join(' · ');
}

function renderDropdown(acquereurs, isDefault = false) {
  const dd = document.getElementById('acqDropdown');
  if (!acquereurs.length) { dd.innerHTML = '<div class="acq-option" style="color:#aaa;font-size:13px;text-align:center">Aucun résultat</div>'; dd.classList.add('show'); return; }
  const header = isDefault ? '<div style="padding:8px 16px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--primary);background:var(--primary-lighter);border-bottom:1px solid var(--border)">30 derniers modifiés / ajoutés</div>' : '';
  dd.innerHTML = header + acquereurs.map(a => {
    const dateTag = dealDateInfo(a);
    const critRecap = acqCriteriaRecap(a);
    return '<div class="acq-option" onclick="selectAcquereur(' + a.id + ', ' + JSON.stringify(a).replace(/"/g, '&quot;') + ')" style="display:flex;align-items:center;gap:14px;padding:10px 16px;">' +
      '<div style="width:10px;height:10px;border-radius:50%;background:var(--primary);flex-shrink:0;"></div>' +
      '<div style="flex:1;min-width:0;"><div style="font-size:14px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + esc(a.titre) +
      (dateTag ? ' <span style="font-size:11px;color:var(--text-light);font-weight:400;margin-left:6px">' + dateTag + '</span>' : '') +
      '</div>' +
      (critRecap ? '<div style="font-size:12px;color:var(--primary);margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"><i class="fas fa-filter" style="font-size:10px;margin-right:4px"></i>' + esc(critRecap) + '</div>' : '') +
      '<div style="font-size:11px;color:var(--text-light);margin-top:2px;"><a href="' + pipedriveLink(a.pipedrive_deal_id) + '" target="_blank" onclick="event.stopPropagation()" style="color:var(--text-light);text-decoration:none;"><i class="fas fa-external-link-alt" style="font-size:9px;margin-right:3px"></i>Pipedrive #' + a.pipedrive_deal_id + '</a></div></div></div>';
  }).join('') +
  '<div style="padding:8px 16px;text-align:center;font-size:12px;color:var(--text-light);border-top:1px solid var(--border);">' + acquereurs.length + ' acquéreurs</div>';
  dd.classList.add('show');
}

function closeDropdown() { document.getElementById('acqDropdown').classList.remove('show'); }

function updateSteps(current) {
  ['step1','step2','step3'].forEach((id, i) => {
    const el = document.getElementById(id);
    el.classList.remove('active','done');
    if (i + 1 < current) el.classList.add('done');
    else if (i + 1 === current) el.classList.add('active');
  });
  const line1 = document.getElementById('stepLine1');
  const line2 = document.getElementById('stepLine2');
  if (line1) line1.classList.toggle('done', current > 1);
  if (line2) line2.classList.toggle('done', current > 2);
}

function selectAcquereur(id, acq) {
  selectedAcquereur = acq;
  addToSearchHistory(acq);
  closeDropdown();
  document.getElementById('acqSearchBox').style.display = 'none';
  updateSteps(2);
  const occ = acq.occupation_status ? JSON.parse(acq.occupation_status) : [];
  secteurs = acq.secteurs ? JSON.parse(acq.secteurs) : [];
  document.getElementById('acqSelectedBox').style.display = 'block';
  document.getElementById('acqSelectedBox').innerHTML = '<div class="acq-selected"><div class="acq-info"><div class="acq-name">' + esc(acq.titre) + '</div><div class="acq-contact">' + esc(acq.contact_name || '') + (acq.contact_email ? ' · ' + esc(acq.contact_email) : '') + (acq.owner_name ? ' · Agent : ' + esc(acq.owner_name) : '') + '</div></div><button class="acq-clear" onclick="clearAcquereur()">✕</button></div>';
  if (acq.budget_min) document.getElementById('critBudgetMin').value = formatNum(acq.budget_min);
  if (acq.budget_max) document.getElementById('critBudgetMax').value = formatNum(acq.budget_max);
  if (acq.rentabilite_min) document.getElementById('critRenta').value = acq.rentabilite_min;
  document.querySelectorAll('.occ-btn').forEach(btn => btn.classList.toggle('active', occ.includes(btn.dataset.val)));
  renderSecteurTags();
  updateActiveCrit();
  loadTodoReport(acq.id);
}

function clearAcquereur() {
  selectedAcquereur = null;
  document.getElementById('acqSearchBox').style.display = 'block';
  document.getElementById('acqSearchWrapper').querySelector('input').value = '';
  document.getElementById('acqSelectedBox').style.display = 'none';
  resetCriteria();
  document.getElementById('resultsArea').innerHTML = '';
  document.getElementById('todoReportArea').style.display = 'none';
  allResults = [];
  updateSteps(1);
}

async function loadTodoReport(acqId) {
  const area = document.getElementById('todoReportArea');
  area.style.display = 'block';
  area.innerHTML = '<div style="padding:16px;text-align:center;color:var(--text-light);"><i class="fas fa-spinner fa-spin"></i> Chargement du rapport TODO...</div>';
  try {
    if (!dashData) {
      const hide = document.getElementById('todosHideDelegation')?.checked || false;
      const res = await fetch('/api/todos/dashboard?hideDelegation=' + hide);
      dashData = await res.json();
    }
    const acq = dashData.acquereurs.find(a => a.id === acqId);
    if (!acq || !acq.biens.length) {
      area.innerHTML = '<div class="todo-report"><div class="todo-report-header"><i class="fas fa-clipboard-list" style="color:var(--primary);margin-right:8px;"></i>Rapport TODO</div><div style="padding:16px;text-align:center;color:var(--text-light);font-size:13px;">Aucun bien en attente pour cet acquéreur</div></div>';
      return;
    }
    const nonTraite = acq.biens.filter(b => !b.statut_todo || b.statut_todo === 'non_traite');
    const envoye = acq.biens.filter(b => b.statut_todo === 'envoye');
    const refuse = acq.biens.filter(b => b.statut_todo === 'refuse');

    let html = '<div class="todo-report">';
    html += '<div class="todo-report-header"><i class="fas fa-clipboard-list" style="color:var(--primary);margin-right:8px;"></i>Rapport TODO <span style="font-weight:400;color:var(--text-light);font-size:13px;">(' + acq.biens.length + ' bien(s))</span></div>';
    html += '<div class="todo-report-stats">';
    html += '<div class="todo-stat"><span class="todo-stat-count" style="color:var(--primary);">' + nonTraite.length + '</span><span class="todo-stat-label">A traiter</span></div>';
    html += '<div class="todo-stat"><span class="todo-stat-count" style="color:#27AE60;">' + envoye.length + '</span><span class="todo-stat-label">Envoyés</span></div>';
    html += '<div class="todo-stat"><span class="todo-stat-count" style="color:#E74C3C;">' + refuse.length + '</span><span class="todo-stat-label">Retirés</span></div>';
    html += '</div>';
    if (nonTraite.length > 0) {
      html += '<div class="todo-report-section"><div class="todo-section-title"><i class="fas fa-clock" style="color:var(--primary);"></i> A traiter (' + nonTraite.length + ')</div>';
      html += nonTraite.slice(0, 10).map(b => '<div class="todo-report-item"><span class="todo-item-title">' + esc(b.titre || 'Sans titre') + '</span>' + (b.prix_fai ? '<span class="todo-item-price">' + formatPrice(b.prix_fai) + '</span>' : '') + '</div>').join('');
      if (nonTraite.length > 10) html += '<div style="text-align:center;font-size:12px;color:var(--text-light);padding:8px;">+ ' + (nonTraite.length - 10) + ' autre(s)</div>';
      html += '</div>';
    }
    html += '</div>';
    area.innerHTML = html;
  } catch(e) {
    area.innerHTML = '<div style="padding:16px;text-align:center;color:var(--danger);"><i class="fas fa-exclamation-triangle"></i> ' + esc(e.message) + '</div>';
  }
}

function toggleOcc(btn) { btn.classList.toggle('active'); updateActiveCrit(); }

function handleSecteurKey(e) {
  const input = e.target;
  if (e.key === 'Enter' || e.key === ',' || e.key === ' ') {
    e.preventDefault();
    const val = input.value.trim().replace(',', '');
    if (val && !secteurs.includes(val)) { secteurs.push(val); renderSecteurTags(); }
    input.value = '';
    updateActiveCrit();
  } else if (e.key === 'Backspace' && !input.value && secteurs.length) {
    secteurs.pop(); renderSecteurTags(); updateActiveCrit();
  }
}

function removeSecteur(val) { secteurs = secteurs.filter(s => s !== val); renderSecteurTags(); updateActiveCrit(); }

function renderSecteurTags() {
  const container = document.getElementById('secteursContainer');
  container.querySelectorAll('.secteur-tag').forEach(t => t.remove());
  secteurs.forEach(s => {
    const tag = document.createElement('span');
    tag.className = 'secteur-tag';
    tag.innerHTML = esc(s) + ' <button onclick="removeSecteur(\'' + s + '\')">×</button>';
    container.insertBefore(tag, container.querySelector('input'));
  });
  container.classList.toggle('has-value', secteurs.length > 0);
}

function updateActiveCrit() {
  const fields = [
    document.getElementById('critBudgetMin').value,
    document.getElementById('critBudgetMax').value,
    document.getElementById('critRenta').value,
    [...document.querySelectorAll('.occ-btn.active')],
    secteurs
  ];
  let count = 0;
  if (fields[0]) count++; if (fields[1]) count++; if (fields[2]) count++;
  if (fields[3].length) count++; if (fields[4].length) count++;
  document.getElementById('activeCritCount').textContent = count + ' actif(s)';
  ['critBudgetMin','critBudgetMax','critRenta'].forEach(id => {
    document.getElementById(id).classList.toggle('has-value', !!document.getElementById(id).value);
  });
  document.getElementById('secteursContainer').classList.toggle('has-value', secteurs.length > 0);
}

function resetCriteria() {
  document.getElementById('critBudgetMin').value = '';
  document.getElementById('critBudgetMax').value = '';
  document.getElementById('critRenta').value = '';
  document.querySelectorAll('.occ-btn').forEach(b => b.classList.remove('active'));
  secteurs = []; renderSecteurTags(); updateActiveCrit();
}

function getCriteria() {
  return {
    budget_min: parseBudget(document.getElementById('critBudgetMin').value),
    budget_max: parseBudget(document.getElementById('critBudgetMax').value),
    rentabilite_min: parseFloat(document.getElementById('critRenta').value) || null,
    occupation_status: [...document.querySelectorAll('.occ-btn.active')].map(b => b.dataset.val),
    secteurs: secteurs
  };
}

async function launchSearch() {
  if (!selectedAcquereur) { showToast('Sélectionnez un acquéreur d\'abord', 'error'); return; }
  const crit = getCriteria();
  await fetch('/api/acquereurs/' + selectedAcquereur.id + '/criteria', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(crit)
  });
  const btn = document.getElementById('btnSearch');
  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Recherche...';
  document.getElementById('resultsArea').innerHTML = '<div class="loading"><i class="fas fa-spinner"></i><p>Recherche en cours...</p></div>';
  try {
    const res = await fetch('/api/match/acquereur-bien', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ acquereurId: selectedAcquereur.id, hideelegation: document.getElementById('hideDelegation').checked })
    });
    const data = await res.json();
    allResults = data.biens || [];
    selectedBiens.clear(); currentFilter = 'non_traite';
    document.querySelectorAll('.filter-tab').forEach(t => t.classList.toggle('active', t.dataset.filter === 'non_traite'));
    updateCounts(); renderResults();
    updateSteps(3);
    addToSearchHistory(selectedAcquereur, allResults.length);
  } catch(e) {
    document.getElementById('resultsArea').innerHTML = '<div class="empty-state"><i class="fas fa-exclamation-triangle"></i><h3>Erreur</h3><p>' + esc(e.message) + '</p></div>';
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-search"></i> Lancer la recherche';
  }
}

async function pushToPipedrive() {
  if (!selectedAcquereur) { showToast('Sélectionnez un acquéreur d\'abord', 'error'); return; }
  const crit = getCriteria();
  await fetch('/api/acquereurs/' + selectedAcquereur.id + '/criteria', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(crit)
  });
  const btn = document.getElementById('btnSaveP');
  const original = btn.innerHTML;
  btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Envoi...';
  try {
    const res = await fetch('/api/acquereurs/' + selectedAcquereur.id + '/push-pipedrive', { method: 'POST' });
    const data = await res.json();
    showToast(data.success ? 'Critères sauvegardés dans Pipedrive' : (data.error || 'Erreur'), data.success ? 'success' : 'error');
  } catch(e) { showToast(e.message, 'error'); }
  finally { btn.disabled = false; btn.innerHTML = original; }
}

function setFilter(filter, btn) {
  currentFilter = filter;
  document.querySelectorAll('.filter-tab').forEach(t => t.classList.toggle('active', t.dataset.filter === filter));
  renderResults();
}

function getFilteredResults() {
  if (currentFilter === 'all') return allResults;
  if (currentFilter === 'non_traite') return allResults.filter(b => !b.statut_todo || b.statut_todo === 'non_traite');
  if (currentFilter === 'envoye') return allResults.filter(b => b.statut_todo === 'envoye');
  return allResults;
}

function updateCounts() {
  document.getElementById('countNonTraite').textContent = allResults.filter(b => !b.statut_todo || b.statut_todo === 'non_traite').length;
  document.getElementById('countEnvoye').textContent = allResults.filter(b => b.statut_todo === 'envoye').length;
  document.getElementById('countAll').textContent = allResults.length;
}

function renderResults() {
  const results = getFilteredResults();
  const area = document.getElementById('resultsArea');
  if (!results.length) {
    area.innerHTML = '<div class="empty-state"><i class="fas fa-search"></i><h3>Aucun bien correspondant</h3><p>Essayez d\'élargir les critères ou de changer le filtre.</p></div>';
    return;
  }
  area.innerHTML = '<div class="results-header"><div class="results-count"><i class="fas fa-list" style="margin-right:6px"></i> Résultats <span style="color:var(--text-light);font-weight:400;font-size:13px;margin-left:8px">' + results.length + ' résultat(s)</span></div></div>' +
    '<div class="stats-bar" style="margin-bottom:16px;">' +
      '<div class="stats-left">' +
        '<button class="btn-stats" onclick="selectAll()"><i class="fas fa-check-square"></i> Tout sélectionner</button>' +
        '<button class="btn-stats" onclick="clearSelection()"><i class="fas fa-square"></i> Tout désélectionner</button>' +
        '<span class="stats-text"><span class="highlight" id="tab2SelectedCount">0</span> sélectionné(s)</span>' +
      '</div>' +
      '<div class="stats-right">' +
        '<button class="btn-stats" style="background:#f8d7da;border-color:var(--danger);color:var(--danger);" onclick="bulkAction(\'refuse\')"><i class="fas fa-save"></i> Sauvegarder la sélection</button>' +
        '<button class="btn-stats success" onclick="bulkAction(\'envoye\')"><i class="fas fa-paper-plane"></i> Envoyer à l\'acquéreur</button>' +
      '</div>' +
    '</div>' +
    results.map(b => renderBienCard(b)).join('');
}

function renderBienCard(bien) {
  const photo = bien.photo_1 || bien.photo_2;
  const photoHtml = photo
    ? '<img src="/api/proxy-image?url=' + encodeURIComponent(photo) + '" onerror="this.parentNode.innerHTML=\'<div class=no-photo><i class=fas\\ fa-home></i></div>\'" alt="">'
    : '<div class="no-photo"><i class="fas fa-home"></i></div>';
  const statut = bien.statut_todo || 'non_traite';
  const statutLabel = statut === 'envoye' ? 'Envoyé' : statut === 'refuse' ? 'Retiré' : 'À traiter';
  const statutClass = statut === 'envoye' ? 'envoye' : statut === 'refuse' ? 'refuse' : 'a-traiter';
  const isSelected = selectedBiens.has(bien.id);
  return '<div class="bien-card ' + (statut === 'envoye' ? 'envoye' : '') + ' ' + (statut === 'refuse' ? 'retire' : '') + ' ' + (isSelected ? 'selected' : '') + '" id="card-' + bien.id + '">' +
    '<div class="bien-card-inner">' +
      '<div class="bien-photo">' + photoHtml + '<div class="checkbox-overlay"><input type="checkbox" ' + (isSelected ? 'checked' : '') + ' onchange="toggleSelect(' + bien.id + ', this.checked)"></div></div>' +
      '<div class="bien-body">' +
        '<div class="bien-title"><i class="fas fa-home" style="color:var(--primary);margin-right:6px;font-size:13px;"></i>' + esc(bien.titre || 'Sans titre') + '</div>' +
        '<div class="bien-address"><i class="fas fa-map-marker-alt"></i>' + esc(bien.adresse || '') + (bien.code_postal ? ', ' + esc(bien.code_postal) : '') + (bien.ville ? ' ' + esc(bien.ville) : '') + '</div>' +
        '<div class="bien-stats">' +
          (bien.prix_fai ? '<div class="bien-stat-block"><span class="stat-label"><i class="fas fa-euro-sign" style="margin-right:3px;font-size:10px;color:var(--primary);"></i>PRIX FAI</span><span class="stat-value">' + formatPrice(bien.prix_fai) + '</span></div>' : '') +
          (bien.rentabilite ? '<div class="bien-stat-block"><span class="stat-label"><i class="fas fa-percentage" style="margin-right:3px;font-size:10px;color:var(--primary);"></i>RENTABILITÉ</span><span class="stat-value">' + bien.rentabilite + '<span class="stat-unit">%</span></span></div>' : '') +
          (bien.surface ? '<div class="bien-stat-block"><span class="stat-label"><i class="fas fa-ruler-combined" style="margin-right:3px;font-size:10px;color:var(--primary);"></i>SURFACE</span><span class="stat-value">' + bien.surface + '<span class="stat-unit"> m²</span></span></div>' : '') +
        '</div>' +
        '<div class="bien-detail-link" onclick="openBienDetail(' + bien.id + ')"><i class="fas fa-info-circle"></i> Voir tous les détails</div>' +
      '</div>' +
      '<div class="bien-actions-col">' +
        (statut !== 'envoye' ?
          '<div class="bien-channel-btns">' +
            '<button class="btn-envoyer" onclick="actionBien(' + bien.id + ', \'envoye\', \'email\')" title="Envoyer par Email"><i class="fas fa-envelope"></i> Email</button>' +
            '<button class="btn-envoyer" style="background:#2980b9;border-color:#2980b9;" onclick="actionBien(' + bien.id + ', \'envoye\', \'sms\')" title="Envoyer par SMS"><i class="fas fa-sms"></i> SMS</button>' +
            '<button class="btn-envoyer" style="background:#25D366;border-color:#25D366;" onclick="openWhatsAppPreviewTab2(' + bien.id + ')" title="Envoyer par WhatsApp"><i class="fab fa-whatsapp"></i></button>' +
          '</div>' +
          '<button class="btn-retirer" onclick="actionBien(' + bien.id + ', \'refuse\')"><i class="fas fa-times"></i> Retirer</button>'
        : '<span style="color:#888;font-size:12px;"><i class="fas fa-check-circle" style="color:#27ae60;"></i> Déjà traité</span>') +
      '</div>' +
    '</div>' +
  '</div>';
}

async function actionBien(bienId, statut, channel) {
  const bien = allResults.find(b => b.id === bienId);
  if (!bien) return;
  if (statut === 'envoye' && channel === 'email') {
    openEmailEditor(selectedAcquereur.id, [bienId]);
    return;
  }
  if (statut === 'envoye' && channel === 'sms') {
    const resp = await fetch('/api/email-queue/enqueue', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ acquereur_id: selectedAcquereur.id, bien_ids: [bienId], channel: 'sms' })
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      showToast(err.error || 'Erreur serveur', 'error');
      return;
    }
    bien.statut_todo = 'envoye';
    updateCounts(); renderResults();
    loadEmailQueueBadge();
    showToast('SMS mis en file d\'envoi', 'success');
    return;
  }
  const resp = await fetch('/api/todos', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ acquereur_id: selectedAcquereur.id, bien_id: bienId, statut })
  });
  if (!resp.ok) { showToast('Erreur serveur', 'error'); return; }
  bien.statut_todo = statut;
  updateCounts(); renderResults();
  showToast('Bien retiré', '');
}

function toggleSelect(bienId, checked) {
  if (checked) selectedBiens.add(bienId); else selectedBiens.delete(bienId);
  document.getElementById('card-' + bienId)?.classList.toggle('selected', checked);
  updateBulkBar();
}

function selectAll() {
  getFilteredResults().forEach(b => selectedBiens.add(b.id));
  renderResults(); updateBulkBar();
}

function clearSelection() {
  selectedBiens.clear(); renderResults(); updateBulkBar();
}

function updateBulkBar() {
  const bar = document.getElementById('bulkBar');
  bar.classList.toggle('show', selectedBiens.size > 0);
  document.getElementById('bulkCount').textContent = selectedBiens.size;
}

async function bulkAction(statut) {
  if (!selectedBiens.size) return;
  const channel = document.getElementById('bulkChannelSelect')?.value || 'email';
  if (statut === 'envoye' && channel === 'email') {
    openEmailEditor(selectedAcquereur.id, [...selectedBiens]);
    return;
  }
  if (statut === 'envoye' && channel === 'sms') {
    const count = selectedBiens.size;
    const resp = await fetch('/api/email-queue/enqueue', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ acquereur_id: selectedAcquereur.id, bien_ids: [...selectedBiens], channel: 'sms' })
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      showToast(err.error || 'Erreur serveur', 'error');
      return;
    }
    selectedBiens.forEach(id => { const b = allResults.find(x => x.id === id); if (b) b.statut_todo = 'envoye'; });
    clearSelection(); updateCounts(); renderResults();
    loadEmailQueueBadge();
    showToast(count + ' bien(s) — SMS mis en file d\'envoi', 'success');
    return;
  }
  const count = selectedBiens.size;
  const resp = await fetch('/api/todos/bulk', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ acquereur_id: selectedAcquereur.id, bien_ids: [...selectedBiens], statut })
  });
  if (!resp.ok) { showToast('Erreur serveur', 'error'); return; }
  selectedBiens.forEach(id => { const b = allResults.find(x => x.id === id); if (b) b.statut_todo = statut; });
  clearSelection(); updateCounts(); renderResults();
  showToast(count + ' bien(s) retirés', 'success');
}

// ============================================================
//  TAB 3 — Bien → Acquéreurs
// ============================================================
let selectedBien = null;
let allResults3 = [];
let currentFilter3 = 'non_traite';
let selectedAcqs3 = new Set();
let bienSearchTimeout = null;

async function searchBiens(q) {
  if (selectedBien) return;
  clearTimeout(bienSearchTimeout);
  bienSearchTimeout = setTimeout(async () => {
    if (q.length < 1) { document.getElementById('bienDropdown').classList.remove('show'); return; }
    try {
      const res = await fetch('/api/biens?q=' + encodeURIComponent(q));
      const data = await res.json();
      renderBienDropdown(data.biens || []);
    } catch(e) {}
  }, 250);
}

let _bienDropdownCache = [];
function renderBienDropdown(biens) {
  _bienDropdownCache = biens;
  const dd = document.getElementById('bienDropdown');
  if (!biens.length) { dd.innerHTML = '<div class="acq-option" style="color:#aaa;font-size:13px;text-align:center">Aucun résultat</div>'; dd.classList.add('show'); return; }
  dd.innerHTML = biens.map((b, i) => {
    const price = b.prix_fai ? formatPrice(b.prix_fai) : '';
    const renta = b.rentabilite_post_rev ? b.rentabilite_post_rev + '%' : '';
    const info = [price, renta, b.occupation_status, b.code_postal, b.ville].filter(Boolean).join(' · ');
    const dateTag = dealDateInfo(b);
    return '<div class="acq-option" onclick="pickBien(' + i + ')" style="padding:10px 16px;">' +
      '<div style="font-size:14px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + esc(b.titre || 'Sans titre') +
      (dateTag ? ' <span style="font-size:11px;color:var(--text-light);font-weight:400;margin-left:6px">' + dateTag + '</span>' : '') +
      '</div>' +
      (info ? '<div style="font-size:12px;color:var(--primary);margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"><i class="fas fa-tag" style="font-size:10px;margin-right:4px"></i>' + esc(info) + '</div>' : '') +
      '<div style="font-size:11px;color:var(--text-light);margin-top:2px;"><a href="' + pipedriveLink(b.pipedrive_deal_id) + '" target="_blank" onclick="event.stopPropagation()" style="color:var(--text-light);text-decoration:none;"><i class="fas fa-external-link-alt" style="font-size:9px;margin-right:3px"></i>Pipedrive #' + b.pipedrive_deal_id + '</a>' + (b.owner_name ? ' · ' + esc(b.owner_name) : '') + '</div></div>';
  }).join('');
  dd.classList.add('show');
}
function pickBien(idx) { const b = _bienDropdownCache[idx]; if (b) selectBien(b.id, b); }

function selectBien(id, bien) {
  selectedBien = bien;
  document.getElementById('bienDropdown').classList.remove('show');
  document.getElementById('bienSearchBox').style.display = 'none';
  document.getElementById('bienSelectedBox').style.display = 'block';

  const price = bien.prix_fai ? formatPrice(bien.prix_fai) : '—';
  const renta = bien.rentabilite_post_rev ? bien.rentabilite_post_rev + '%' : (bien.rentabilite ? bien.rentabilite + '%' : '—');
  const occ = esc(bien.occupation_status || '—');

  document.getElementById('bienSelectedBox').innerHTML =
    '<div class="acq-selected"><div class="acq-info"><div class="acq-name">' + esc(bien.titre || 'Sans titre') +
    ' <span style="color:var(--text-light);font-size:12px">(#' + esc(String(bien.pipedrive_deal_id)) + ')</span></div>' +
    '<div class="acq-contact"><i class="fas fa-map-marker-alt" style="margin-right:4px"></i>' + esc(bien.adresse || '') +
    (bien.code_postal ? ' · ' + esc(bien.code_postal) : '') + (bien.ville ? ' ' + esc(bien.ville) : '') + '</div>' +
    '<div class="bien-detail-link" onclick="openBienDetail(' + bien.id + ')" style="margin-top:6px;"><i class="fas fa-info-circle"></i> Voir tous les détails</div>' +
    '</div><button class="acq-clear" onclick="clearBien()">✕</button></div>';

  document.getElementById('bienRecentSection').style.display = 'none';
  document.getElementById('bienCriteriaSection').style.display = 'block';
  document.getElementById('bienCriteriaGrid').innerHTML =
    '<div class="crit-field"><label><i class="fas fa-euro-sign"></i> Prix FAI</label><input type="text" value="' + esc(price) + '" readonly class="has-value"></div>' +
    '<div class="crit-field"><label><i class="fas fa-percent"></i> Rentabilité</label><input type="text" value="' + esc(renta) + '" readonly class="has-value"></div>' +
    '<div class="crit-field"><label><i class="fas fa-building"></i> Occupation</label><input type="text" value="' + occ + '" readonly class="has-value"></div>' +
    '<div class="crit-field"><label><i class="fas fa-map-marker-alt"></i> Code postal</label><input type="text" value="' + esc(bien.code_postal || '—') + '" readonly class="has-value"></div>';

  launchBienSearch();
}

function clearBien() {
  selectedBien = null;
  document.getElementById('bienSearchBox').style.display = 'block';
  document.getElementById('bienInput').value = '';
  document.getElementById('bienSelectedBox').style.display = 'none';
  document.getElementById('bienCriteriaSection').style.display = 'none';
  document.getElementById('resultsAreaBien').innerHTML = '';
  document.getElementById('bienRecentSection').style.display = 'block';
  allResults3 = [];
  selectedAcqs3.clear();
  loadRecentBiens();
}

let recentBiensMode = 'new';
let _recentBiensAbort = null;
function switchRecentMode(mode) {
  recentBiensMode = mode;
  document.getElementById('btnRecentNew').classList.toggle('active', mode === 'new');
  document.getElementById('btnRecentMod').classList.toggle('active', mode === 'modified');
  loadRecentBiens();
}

async function loadRecentBiens() {
  if (_recentBiensAbort) _recentBiensAbort.abort();
  _recentBiensAbort = new AbortController();
  const signal = _recentBiensAbort.signal;
  const container = document.getElementById('bienRecentList');
  container.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-light)"><i class="fas fa-spinner fa-spin"></i> Chargement...</div>';
  try {
    const res = await fetch('/api/biens/recent?mode=' + recentBiensMode, { signal });
    const data = await res.json();
    if (!data.biens || !data.biens.length) {
      container.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-light)">Aucun bien trouvé</div>';
      return;
    }
    container.innerHTML = data.biens.map((b, i) => {
      const price = b.prix_fai ? formatPrice(b.prix_fai) : '';
      const renta = b.rentabilite_post_rev ? b.rentabilite_post_rev + '%' : '';
      const info = [price, renta, b.occupation_status, b.code_postal, b.ville].filter(Boolean).join(' · ');
      const dateRaw = recentBiensMode === 'new' ? b.pipedrive_created_at : (b.pipedrive_updated_at || b.pipedrive_created_at);
      const dateStr = dateRaw ? new Date(dateRaw).toLocaleDateString('fr-FR') : '';
      return '<div onclick="selectBienFromRecent(' + i + ')" style="display:flex;align-items:center;justify-content:space-between;padding:10px 16px;border-bottom:1px solid var(--border);cursor:pointer;transition:background 0.1s;" onmouseenter="this.style.background=\'var(--primary-lighter)\'" onmouseleave="this.style.background=\'transparent\'">' +
        '<div style="flex:1;min-width:0;">' +
        '<div style="font-size:14px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + esc(b.titre || 'Sans titre') + '</div>' +
        (info ? '<div style="font-size:12px;color:var(--primary);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + esc(info) + '</div>' : '') +
        '<div style="font-size:11px;color:var(--text-light);margin-top:1px;">#' + b.pipedrive_deal_id + (b.owner_name ? ' · ' + esc(b.owner_name) : '') + '</div>' +
        '</div>' +
        (dateStr ? '<div style="font-size:11px;color:var(--text-light);white-space:nowrap;margin-left:12px;">' + dateStr + '</div>' : '') +
        '</div>';
    }).join('');
    window._recentBiensCache = data.biens;
  } catch(e) {
    if (e.name === 'AbortError') return;
    container.innerHTML = '<div style="padding:20px;text-align:center;color:var(--danger)">Erreur de chargement</div>';
  }
}

function selectBienFromRecent(idx) {
  const b = window._recentBiensCache && window._recentBiensCache[idx];
  if (b) selectBien(b.id, b);
}

function setFilter3(f, btn) {
  currentFilter3 = f;
  document.querySelectorAll('[data-filter3]').forEach(t => t.classList.toggle('active', t.dataset.filter3 === f));
  renderResults3();
}

function getFilteredResults3() {
  if (currentFilter3 === 'all') return allResults3;
  if (currentFilter3 === 'non_traite') return allResults3.filter(a => !a.statut_todo || a.statut_todo === 'non_traite');
  if (currentFilter3 === 'envoye') return allResults3.filter(a => a.statut_todo === 'envoye');
  return allResults3;
}

function updateCounts3() {
  document.getElementById('countNonTraite3').textContent = allResults3.filter(a => !a.statut_todo || a.statut_todo === 'non_traite').length;
  document.getElementById('countEnvoye3').textContent = allResults3.filter(a => a.statut_todo === 'envoye').length;
  document.getElementById('countAll3').textContent = allResults3.length;
}

async function launchBienSearch() {
  if (!selectedBien) { showToast('Sélectionnez un bien d\'abord', 'error'); return; }
  const btn = document.getElementById('btnSearchBien');
  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Recherche...';
  document.getElementById('resultsAreaBien').innerHTML = '<div class="loading"><i class="fas fa-spinner"></i><p>Recherche des acquéreurs correspondants...</p></div>';
  try {
    const res = await fetch('/api/match/bien-acquereur', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bienId: selectedBien.id })
    });
    const data = await res.json();
    allResults3 = data.acquereurs || [];
    selectedAcqs3.clear();
    currentFilter3 = 'non_traite';
    document.querySelectorAll('[data-filter3]').forEach(t => t.classList.toggle('active', t.dataset.filter3 === 'non_traite'));
    updateCounts3();
    renderResults3();
  } catch(e) {
    document.getElementById('resultsAreaBien').innerHTML = '<div class="empty-state"><i class="fas fa-exclamation-triangle"></i><h3>Erreur</h3><p>' + esc(e.message) + '</p></div>';
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-search"></i> Lancer la recherche';
  }
}

function renderResults3() {
  const results = getFilteredResults3();
  const area = document.getElementById('resultsAreaBien');
  if (!results.length) {
    area.innerHTML = '<div class="empty-state"><i class="fas fa-search"></i><h3>Aucun acquéreur correspondant</h3><p>Aucun acquéreur ne correspond aux critères de ce bien.</p></div>';
    return;
  }
  area.innerHTML = '<div class="results-header"><div class="results-count"><span>' + results.length + '</span> acquéreur(s) trouvé(s)</div></div>' +
    '<div class="acq-list">' + results.map(a => renderAcqResult3(a)).join('') + '</div>';
}

function renderAcqResult3(acq) {
  const statut = acq.statut_todo || 'non_traite';
  const statutLabel = statut === 'envoye' ? 'Envoyé' : statut === 'refuse' ? 'Retiré' : 'À traiter';
  const statutClass = statut === 'envoye' ? 'envoye' : statut === 'refuse' ? 'refuse' : 'a-traiter';
  const budget = [acq.budget_min ? formatPrice(acq.budget_min) : '', acq.budget_max ? formatPrice(acq.budget_max) : ''].filter(Boolean).join(' - ');
  const renta = acq.rentabilite_min ? acq.rentabilite_min + '%' : '';
  const secteursStr = acq.secteurs || '';
  const details = [budget ? 'Budget: ' + budget : '', renta ? 'Renta min: ' + renta : '', secteursStr ? 'Secteurs: ' + secteursStr : ''].filter(Boolean).join(' | ');

  return '<div class="acq-row" style="cursor:default">' +
    '<div class="acq-header">' +
      '<div class="acq-name-col">' +
        '<div class="acq-name-text">' + esc(acq.titre || 'Sans titre') + ' <span class="acq-id">(#' + acq.pipedrive_deal_id + ')</span></div>' +
        '<div style="font-size:12px;color:var(--text-light);margin-top:2px">' + esc(acq.contact_name || '') + (acq.contact_email ? ' · ' + esc(acq.contact_email) : '') + (acq.owner_name ? ' · Agent: ' + esc(acq.owner_name) : '') + '</div>' +
        '<div style="font-size:11px;color:var(--text-light);margin-top:2px">' + esc(details) + '</div>' +
      '</div>' +
      '<div class="bien-row-actions">' +
        (statut !== 'envoye' ?
          '<button class="btn-envoyer" onclick="actionBien3(' + acq.id + ', \'envoye\')"><i class="fas fa-paper-plane"></i> Envoyer</button>' +
          '<button class="btn-retirer" onclick="actionBien3(' + acq.id + ', \'refuse\')"><i class="fas fa-times"></i> Retirer</button>'
        : '<span style="color:#888;font-size:12px;"><i class="fas fa-check-circle" style="color:#27ae60;"></i> Déjà traité</span>') +
        '<a class="acq-details-link" href="javascript:void(0)" onclick="event.stopPropagation();openAcqDetail(' + acq.id + ')" style="margin-left:4px"><i class="fas fa-info-circle"></i> Détails</a>' +
      '</div>' +
    '</div>' +
  '</div>';
}

async function actionBien3(acqId, statut) {
  const acq = allResults3.find(a => a.id === acqId);
  if (!acq || !selectedBien) return;
  if (statut === 'envoye') {
    openEmailEditor(acqId, [selectedBien.id]);
    return;
  }
  await fetch('/api/todos', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ acquereur_id: acqId, bien_id: selectedBien.id, statut })
  });
  acq.statut_todo = statut;
  updateCounts3();
  renderResults3();
  showToast('Retiré', '');
}

// ============================================================
//  ADMIN
// ============================================================
async function openOwnersModal() {
  document.getElementById('ownersModal').style.display = 'flex';
  const res = await fetch('/api/admin/owners');
  const data = await res.json();
  const tbody = data.owners.map(o => {
    const accountCell = o.compte_flutch
      ? '<span style="color:var(--success);font-size:12px;font-weight:600">' + esc(o.compte_flutch.name) + '</span>'
      : '<span style="color:var(--danger);font-size:12px;font-weight:600">Pas de compte</span>';
    const actionCell = o.compte_flutch
      ? '<button onclick="sendSetupLink(' + o.compte_flutch.id + ', this)" title="Renvoyer un lien d\u2019activation par email" style="background:var(--secondary);color:white;border:none;border-radius:6px;font-size:11px;font-weight:600;cursor:pointer;padding:6px 10px;"><i class="fas fa-paper-plane"></i> Renvoyer lien</button>'
      : '<span style="font-size:11px;color:var(--text-light)">—</span>';
    return '<tr style="border-bottom:1px solid var(--border)">' +
      '<td style="padding:10px 8px"><strong>' + esc(o.owner_name || '—') + '</strong><br><span style="font-size:12px;color:var(--text-light)">' + esc(o.owner_email) + '</span></td>' +
      '<td style="padding:10px 8px;text-align:center;font-size:13px">' + o.nb_acquereurs + ' acq.</td>' +
      '<td style="padding:10px 8px;text-align:center;font-size:13px">' + o.nb_biens + ' biens</td>' +
      '<td style="padding:10px 8px;text-align:center">' + accountCell + '</td>' +
      '<td style="padding:10px 8px;text-align:center">' + actionCell + '</td>' +
    '</tr>';
  }).join('');
  document.getElementById('ownersTable').innerHTML = '<table style="width:100%;border-collapse:collapse;font-size:14px"><thead><tr style="background:var(--primary-lighter)"><th style="padding:10px 8px;text-align:left;font-size:12px;color:var(--primary-dark)">Agent Pipedrive</th><th style="padding:10px 8px;text-align:center;font-size:12px;color:var(--primary-dark)">Acquéreurs</th><th style="padding:10px 8px;text-align:center;font-size:12px;color:var(--primary-dark)">Biens</th><th style="padding:10px 8px;text-align:center;font-size:12px;color:var(--primary-dark)">Compte Flutch</th><th style="padding:10px 8px;text-align:center;font-size:12px;color:var(--primary-dark)">Action</th></tr></thead><tbody>' + (tbody || '<tr><td colspan="5" style="padding:20px;text-align:center;color:var(--text-light)">Aucun owner trouvé.</td></tr>') + '</tbody></table>';
  const missing = data.owners.find(o => o.manque_compte);
  if (missing) { document.getElementById('newUserEmail').value = missing.owner_email; document.getElementById('newUserName').value = missing.owner_name || ''; }
}
function closeOwnersModal() { document.getElementById('ownersModal').style.display = 'none'; }

async function importActivities() {
  const btn = document.getElementById('btnImportAct');
  const report = document.getElementById('integrityReport');
  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Import en cours...';
  report.innerHTML = '<div style="padding:12px;background:var(--primary-lighter);border-radius:8px;font-size:13px;">Import des activités Pipedrive en cours... (peut prendre 30-60s)</div>';
  try {
    const res = await fetch('/api/admin/import-activities', { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      report.innerHTML = '<div style="padding:14px;background:#d4edda;border:1px solid #27AE60;border-radius:8px;font-size:13px;">' +
        '<div style="font-weight:700;color:var(--success);margin-bottom:8px;">Import terminé</div>' +
        '<div>' + data.activities_total + ' activités scannées → ' + data.unique_todos + ' todos uniques</div>' +
        '<div>' + data.inserted + ' nouveaux, ' + data.updated + ' mis à jour</div>' +
        '<div style="margin-top:6px;font-size:12px;color:var(--text-light)">Envois: ' + data.stats.envoyer_new + ' (nouveau) + ' + data.stats.match_old + ' (ancien) + ' + data.stats.bulk_old + ' (bulk) | Retraits: ' + data.stats.retirer_new + '</div>' +
      '</div>';
      loadDashboard();
    } else {
      report.innerHTML = '<div style="padding:12px;background:#f8d7da;border-radius:8px;font-size:13px;color:var(--danger);">Erreur: ' + esc(data.error || 'Inconnue') + '</div>';
    }
  } catch(e) {
    report.innerHTML = '<div style="padding:12px;background:#f8d7da;border-radius:8px;font-size:13px;color:var(--danger);">Erreur: ' + esc(e.message) + '</div>';
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-file-import"></i> Importer activités Pipedrive';
  }
}

async function runIntegrityCheck() {
  const report = document.getElementById('integrityReport');
  report.innerHTML = '<div style="padding:12px;background:var(--primary-lighter);border-radius:8px;font-size:13px;">Vérification en cours...</div>';
  try {
    const res = await fetch('/api/admin/integrity');
    const data = await res.json();
    if (!data.ok && data.issues?.length) {
      report.innerHTML = '<div style="padding:14px;background:#fef3cd;border:1px solid #f6c343;border-radius:8px;font-size:13px;"><div style="font-weight:700;margin-bottom:8px;">' + data.issues.length + ' problème(s)</div><ul style="margin-left:16px">' + data.issues.map(i => '<li><strong>' + i.type + '</strong> : ' + i.count + '</li>').join('') + '</ul><div style="margin-top:8px;color:var(--text-light);font-size:12px;">Biens: ' + data.counts.biens_actifs + ' actifs / ' + data.counts.biens_archives + ' archivés<br>Acquéreurs: ' + data.counts.acquereurs_actifs + ' actifs / ' + data.counts.acquereurs_archives + ' archivés</div></div>';
    } else {
      report.innerHTML = '<div style="padding:14px;background:#d4edda;border:1px solid #27AE60;border-radius:8px;font-size:13px;"><div style="font-weight:700;color:var(--success);margin-bottom:4px;">Base saine</div><div style="color:var(--text-light);font-size:12px;">Biens: ' + data.counts.biens_actifs + ' actifs / ' + data.counts.biens_archives + ' archivés<br>Acquéreurs: ' + data.counts.acquereurs_actifs + ' actifs / ' + data.counts.acquereurs_archives + ' archivés</div></div>';
    }
  } catch(e) { report.innerHTML = '<div style="padding:12px;background:#f8d7da;border-radius:8px;font-size:13px;color:var(--danger);">Erreur: ' + esc(e.message) + '</div>'; }
}

async function createAgent() {
  const name = document.getElementById('newUserName').value.trim();
  const email = document.getElementById('newUserEmail').value.trim();
  if (!name || !email) { showToast('Renseigne le nom et l\u2019email', 'error'); return; }
  const res = await fetch('/api/users', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, email, role: 'agent', send_setup_link: true })
  });
  const data = await res.json();
  if (data.success) {
    if (data.setup_link_sent) {
      showToast('Compte créé. Lien d\u2019activation envoyé à ' + email, 'success');
    } else {
      showToast('Compte créé mais email d\u2019activation non envoyé : ' + (data.error_email || 'erreur Brevo'), 'error');
    }
    document.getElementById('newUserName').value = '';
    document.getElementById('newUserEmail').value = '';
    openOwnersModal();
  } else { showToast(data.error || 'Erreur', 'error'); }
}

async function sendSetupLink(userId, btn) {
  if (!confirm('Renvoyer un lien d\u2019activation par email à cet agent ? Son mot de passe actuel restera valide tant qu\u2019il n\u2019aura pas cliqué sur le nouveau lien.')) return;
  const original = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Envoi…';
  try {
    const res = await fetch('/api/users/' + userId + '/send-setup-link', { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      showToast('Lien envoyé à ' + (data.email || 'l\u2019agent'), 'success');
    } else {
      showToast(data.error || 'Erreur', 'error');
    }
  } catch (e) {
    showToast('Erreur réseau', 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = original;
  }
}

// ============================================================
//  MODAL DÉTAILS BIEN
// ============================================================
let currentBienDetail = null;

async function openBienDetail(bienId) {
  const modal = document.getElementById('bienDetailModal');
  modal.style.display = 'flex';
  document.getElementById('modeConfidentiel').checked = false;
  const content = document.getElementById('bienDetailContent');
  content.innerHTML = '<div class="loading"><i class="fas fa-spinner"></i><p>Chargement...</p></div>';
  try {
    const res = await fetch('/api/biens/' + bienId + '/detail');
    const data = await res.json();
    currentBienDetail = data.bien;
    renderBienDetailContent();
  } catch(e) {
    content.innerHTML = '<div style="color:var(--danger);padding:20px;text-align:center;">Erreur: ' + esc(e.message) + '</div>';
  }
}

function toggleModeConfidentiel() {
  renderBienDetailContent();
}

function renderBienDetailContent() {
  const b = currentBienDetail;
  if (!b) return;
  const content = document.getElementById('bienDetailContent');
  const confidentiel = document.getElementById('modeConfidentiel').checked;
  const addr = [b.adresse, b.code_postal, b.ville].filter(Boolean).join(', ');
  const mapsUrl = addr ? 'https://www.google.com/maps/search/' + encodeURIComponent(addr) : '#';
  const streetUrl = addr ? 'https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=' + encodeURIComponent(addr) : '#';
  const hideVal = '<span style="color:var(--text-light);font-style:italic;">🔒 Masqué (mode confidentiel)</span>';

  let html = '';

  const photos = [b.photo_1, b.photo_2, b.photo_3, b.photo_4, b.autre_photo].filter(Boolean);
  if (photos.length) {
    html += '<div style="display:flex;gap:10px;overflow-x:auto;padding-bottom:16px;margin-bottom:8px;">';
    photos.forEach(function(url) {
      html += '<img src="' + esc(url) + '" alt="Photo" style="max-height:220px;border-radius:10px;cursor:pointer;flex-shrink:0;object-fit:cover;" onclick="window.open(\'' + esc(url) + '\',\'_blank\')" />';
    });
    html += '</div>';
  }

  html += '<div style="background:var(--primary);color:white;padding:14px 20px;border-radius:10px;margin-bottom:16px;font-size:17px;font-weight:700;text-align:center;">' +
    esc(b.titre || 'Bien sans titre') + '</div>';

  var surfaceVal = '';
  if (b.surface) {
    surfaceVal = 'Surface totale : ' + b.surface + ' m²';
    var parts = [];
    if (b.surface_rdc) parts.push(b.surface_rdc + ' en RDC');
    if (b.surface_sous_sol) parts.push(b.surface_sous_sol + ' en sous-sol');
    if (b.surface_etage) parts.push(b.surface_etage + ' en étage supérieur');
    if (parts.length) surfaceVal += ' (' + parts.join(', ') + ')';
  }

  const rows = [
    { icon: 'fa-map-marker-alt', label: 'Adresse', value: esc(addr || '—'), extra: addr ? '<div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap;"><a href="'+mapsUrl+'" target="_blank" style="background:#27AE60;color:white;padding:6px 14px;border-radius:8px;font-size:12px;font-weight:600;text-decoration:none;display:flex;align-items:center;gap:4px;"><i class="fas fa-map"></i> Google Maps</a><a href="'+streetUrl+'" target="_blank" style="background:#2C3E50;color:white;padding:6px 14px;border-radius:8px;font-size:12px;font-weight:600;text-decoration:none;display:flex;align-items:center;gap:4px;"><i class="fas fa-street-view"></i> Street View</a></div>' : '' },
    b.surface ? { icon: 'fa-ruler-combined', label: 'Surface', value: esc(surfaceVal) } : null,
    b.surface_ponderee ? { icon: 'fa-ruler', label: 'Surface pondérée', value: esc(b.surface_ponderee + ' m²') } : null,
    b.occupation_status ? { icon: 'fa-building', label: 'Statut d\'occupation', value: esc(b.occupation_status) } : null,
    b.type_bien ? { icon: 'fa-tag', label: 'Type de bien', value: esc(b.type_bien) } : null,
    b.taxe_fonciere ? { icon: 'fa-file-invoice-dollar', label: 'Taxe foncière', value: confidentiel ? hideVal : formatPrice(b.taxe_fonciere) + (b.imputation_taxe_fonciere ? ' - ' + esc(b.imputation_taxe_fonciere) : ''), sensitive: true } : null,
    b.charge_annuelle ? { icon: 'fa-coins', label: 'Charge annuelle', value: confidentiel ? hideVal : formatPrice(b.charge_annuelle), sensitive: true } : null,
    b.loyer_net_bailleur ? { icon: 'fa-hand-holding-usd', label: 'Loyer net bailleur facturé', value: confidentiel ? hideVal : formatPrice(b.loyer_net_bailleur) + '<br/><i style="font-size:12px;color:var(--text-light);">' + (b.imputation_taxe_fonciere && b.imputation_taxe_fonciere.toLowerCase().includes('locataire') ? 'Loyer net perçu par le bailleur : les charges et la taxe foncière sont imputées au locataire.' : b.imputation_taxe_fonciere && b.imputation_taxe_fonciere.includes('50/50') ? 'Loyer net perçu par le bailleur : les charges sont imputées au locataire, la taxe foncière est partagée 50/50.' : 'Loyer net perçu par le bailleur : les charges sont imputées au locataire, la taxe foncière reste à la charge du bailleur.') + '</i>', sensitive: true } : null,
    b.prise_effet_bail ? { icon: 'fa-calendar-alt', label: 'Prise d\'effet du bail', value: esc(formatDateFR(b.prise_effet_bail)) } : null,
    b.loyer_post_revision ? { icon: 'fa-money-bill-wave', label: 'Loyer post-révision', value: confidentiel ? hideVal : formatPrice(b.loyer_post_revision) + ' net bailleur', sensitive: true } : null,
    b.prix_fai ? { icon: 'fa-euro-sign', label: 'Prix', value: confidentiel ? hideVal : formatPrice(b.prix_fai) + ' honoraires inclus', sensitive: true } : null,
    b.rentabilite_actuelle ? { icon: 'fa-percentage', label: 'Rendement actuel', value: confidentiel ? hideVal : '<span style="color:var(--primary);font-weight:700;">' + Number(b.rentabilite_actuelle).toFixed(2) + '%</span>', sensitive: true } : (b.rentabilite ? { icon: 'fa-percentage', label: 'Rendement actuel', value: confidentiel ? hideVal : '<span style="color:var(--primary);font-weight:700;">' + Number(b.rentabilite).toFixed(2) + '%</span>', sensitive: true } : null),
    b.rentabilite_post_rev ? { icon: 'fa-chart-line', label: 'Rendement post-révision', value: confidentiel ? hideVal : '<span style="color:var(--primary);font-weight:700;">' + Number(b.rentabilite_post_rev).toFixed(2) + '%</span>', sensitive: true } : null,
    b.assujettissement_tva ? { icon: 'fa-receipt', label: 'Assujettissement à la TVA', value: esc(b.assujettissement_tva) } : null,
    b.modalite_augmentation ? { icon: 'fa-sync-alt', label: 'Modalité d\'augmentation du loyer', value: esc(b.modalite_augmentation) } : null,
    b.description ? { icon: 'fa-align-left', label: 'Descriptif', value: esc(b.description) } : null,
    b.is_delegation ? { icon: 'fa-handshake', label: 'Mandat', value: 'Délégation' } : null,
    b.owner_name ? { icon: 'fa-user', label: 'Agent', value: esc(b.owner_name) + (b.owner_email ? ' (' + esc(b.owner_email) + ')' : '') } : null,
  ].filter(Boolean);

  if (b.lien_drive && /^https?:\/\//i.test(b.lien_drive)) {
    html += '<div style="margin-top:16px;padding:14px 16px;background:#E8F0FE;border:1px solid #4285F4;border-radius:10px;">' +
      '<a href="' + esc(b.lien_drive) + '" target="_blank" rel="noopener noreferrer" style="display:flex;align-items:center;gap:10px;text-decoration:none;color:#1A73E8;font-weight:700;font-size:14px;">' +
        '<i class="fab fa-google-drive" style="font-size:22px;"></i> Ouvrir le dossier Drive' +
      '</a>' +
    '</div>';
  }

  html += rows.map(function(r) {
    return '<div style="padding:14px 0;border-bottom:1px solid var(--border);">' +
      '<div style="font-size:14px;font-weight:700;color:var(--text);display:flex;align-items:center;gap:8px;margin-bottom:4px;">' +
        '<i class="fas ' + r.icon + '" style="color:var(--primary);font-size:13px;"></i> ' + r.label +
      '</div>' +
      '<div style="font-size:15px;color:var(--text);line-height:1.6;">' + r.value + '</div>' +
      (r.extra || '') +
    '</div>';
  }).join('');

  if (b.points_positifs) {
    html += '<div style="margin-top:16px;padding:14px 16px;background:#D4EDDA;border:1px solid #28A745;border-radius:10px;">' +
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;font-size:14px;font-weight:700;color:#155724;">' +
        '<i class="fas fa-check-circle"></i> Points positifs' +
      '</div>' +
      '<div style="font-size:13px;color:#155724;line-height:1.6;white-space:pre-line;">' + esc(b.points_positifs) + '</div>' +
    '</div>';
  }

  if (b.point_vigilance) {
    html += '<div style="margin-top:12px;padding:14px 16px;background:#FFF3CD;border:1px solid #F6C343;border-radius:10px;">' +
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;font-size:14px;font-weight:700;color:#856404;">' +
        '<i class="fas fa-exclamation-triangle"></i> Point de vigilance' +
      '</div>' +
      '<div style="font-size:13px;color:#856404;line-height:1.6;white-space:pre-line;">' + esc(b.point_vigilance) + '</div>' +
    '</div>';
  }

  html += '<div style="display:flex;gap:10px;padding-top:16px;">' +
    '<a href="https://leboutiquier.pipedrive.com/deal/' + b.pipedrive_deal_id + '" target="_blank" ' +
    'style="flex:1;text-align:center;padding:12px;background:var(--success);color:white;border-radius:10px;font-size:14px;font-weight:600;text-decoration:none;cursor:pointer;">' +
    '<i class="fas fa-external-link-alt" style="margin-right:6px;"></i> Pipedrive</a>' +
  '</div>';

  content.innerHTML = html;
}

function closeBienDetail() { document.getElementById('bienDetailModal').style.display = 'none'; currentBienDetail = null; }

let recentBiensTimeout = null;
let recentBiensLoaded = false;
async function showRecentBiensTooltip(e) {
  clearTimeout(recentBiensTimeout);
  recentBiensTimeout = setTimeout(async () => {
    const tooltip = document.getElementById('recentBiensTooltip');
    const rect = e.target.closest('.tab-btn').getBoundingClientRect();
    tooltip.style.left = Math.min(rect.left, window.innerWidth - 440) + 'px';
    tooltip.style.top = (rect.bottom + 6) + 'px';
    tooltip.style.display = 'block';

    if (!recentBiensLoaded) {
      tooltip.innerHTML = '<div style="padding:16px;text-align:center;"><i class="fas fa-spinner fa-spin"></i></div>';
      try {
        const res = await fetch('/api/biens/recent');
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        recentBiensLoaded = true;
        const biens = data.biens || [];
        if (!biens.length) {
          tooltip.innerHTML = '<div style="padding:16px;text-align:center;color:var(--text-light);font-size:13px;">Aucun bien récent.</div>';
          return;
        }
        tooltip.innerHTML = '<div style="padding:12px 16px;border-bottom:2px solid var(--primary);font-size:13px;font-weight:700;color:var(--primary);">' +
          '<i class="fas fa-clock" style="margin-right:6px;"></i>30 derniers biens (créés / modifiés)</div>' +
          biens.map(function(b) {
            var isModified = b.pipedrive_updated_at && b.pipedrive_created_at && b.pipedrive_updated_at > b.pipedrive_created_at;
            var icon = isModified
              ? '<i class="fas fa-pencil-alt" style="color:#E67E22;font-size:11px;" title="Modifié"></i>'
              : '<i class="fas fa-plus-circle" style="color:#27AE60;font-size:11px;" title="Créé"></i>';
            var dateStr = formatDateFR(isModified ? b.pipedrive_updated_at : b.pipedrive_created_at);
            var price = b.prix_fai ? formatPrice(b.prix_fai) : '';
            var info = [price, b.occupation_status, b.code_postal, b.ville].filter(Boolean).join(' · ');
            return '<div onclick="switchTab(\'bien-acq\');selectBien(' + b.id + ',' + JSON.stringify(b).replace(/"/g, '&quot;') + ')" style="display:flex;align-items:center;gap:10px;padding:8px 16px;border-bottom:1px solid var(--border);cursor:pointer;transition:background 0.15s;" onmouseenter="this.style.background=\'var(--primary-lighter)\'" onmouseleave="this.style.background=\'transparent\'">' +
              '<div style="width:20px;text-align:center;">' + icon + '</div>' +
              '<div style="flex:1;min-width:0;">' +
                '<div style="font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + esc(b.titre || 'Sans titre') + '</div>' +
                (info ? '<div style="font-size:11px;color:var(--text-light);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + esc(info) + '</div>' : '') +
              '</div>' +
              '<div style="font-size:11px;color:var(--text-light);white-space:nowrap;">' + dateStr + '</div>' +
            '</div>';
          }).join('') +
        '';
      } catch(err) {
        tooltip.innerHTML = '<div style="padding:16px;color:var(--danger);">Erreur</div>';
      }
    }
  }, 300);
}

function hideRecentBiensTooltip() {
  clearTimeout(recentBiensTimeout);
  recentBiensTimeout = setTimeout(function() {
    document.getElementById('recentBiensTooltip').style.display = 'none';
  }, 200);
}

document.addEventListener('DOMContentLoaded', function() {
  var tooltip = document.getElementById('recentBiensTooltip');
  if (tooltip) {
    tooltip.addEventListener('mouseenter', function() { clearTimeout(recentBiensTimeout); });
    tooltip.addEventListener('mouseleave', function() { hideRecentBiensTooltip(); });
  }
});

// ============================================================
//  UTILS
// ============================================================
function formatNum(v) { return (!v && v !== 0) ? '' : Number(v).toLocaleString('fr-FR'); }
function parseBudget(str) { const n = parseFloat(String(str).replace(/\s/g, '').replace(',', '.')); return isNaN(n) ? null : n; }
function formatBudgetInput(el) {
  const pos = el.selectionStart;
  const raw = el.value.replace(/\s/g, '');
  if (!raw) return;
  const n = parseFloat(raw.replace(',', '.'));
  if (isNaN(n)) return;
  const formatted = formatNum(n);
  const diff = formatted.length - el.value.length;
  el.value = formatted;
  el.setSelectionRange(pos + diff, pos + diff);
}
function formatPrice(v) { return new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(v); }
function formatDateFR(d) { if (!d) return ''; var s = String(d).slice(0,10); var p = s.split('-'); return p.length === 3 ? p[2]+'/'+p[1]+'/'+p[0] : s; }
function esc(str) { return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function updateNotificationBadge(count) {
  const badge = document.getElementById('notificationBadge');
  if (!badge) return;
  const n = parseInt(count) || 0;
  if (n > 0) {
    badge.textContent = n;
    badge.style.display = 'flex';
  } else {
    badge.style.display = 'none';
  }
}

let toastTimeout;
function showToast(msg, type = '') {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();
  const t = document.createElement('div');
  t.className = 'toast ' + type;
  t.textContent = msg;
  document.body.appendChild(t);
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => t.remove(), 3000);
}

// ============================================================
//  EMAIL STATUS MODAL
// ============================================================
async function loadEmailQueueBadge() {
  try {
    const res = await fetch('/api/email-queue/status');
    const data = await res.json();
    const badge = document.getElementById('emailQueueBadge');
    const total = (data.pending || 0) + (data.failed || 0);
    if (total > 0) {
      badge.textContent = total;
      badge.style.display = 'flex';
    } else {
      badge.style.display = 'none';
    }
  } catch(e) {}
}

async function openEmailStatusModal() {
  const modal = document.getElementById('emailStatusModal');
  modal.style.display = 'flex';
  await renderEmailStatus();
}

function closeEmailStatusModal() {
  document.getElementById('emailStatusModal').style.display = 'none';
}

async function renderEmailStatus() {
  const content = document.getElementById('emailStatusContent');
  content.innerHTML = '<div class="loading"><i class="fas fa-spinner"></i><p>Chargement...</p></div>';
  try {
    const res = await fetch('/api/email-queue/status');
    const data = await res.json();

    let html = '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:20px;">' +
      '<div style="background:#FFF3CD;border:1px solid #F6C343;border-radius:10px;padding:16px;text-align:center;">' +
        '<div style="font-size:28px;font-weight:800;color:#856404;">' + (data.pending || 0) + '</div>' +
        '<div style="font-size:12px;font-weight:600;color:#856404;margin-top:4px;">En attente</div>' +
      '</div>' +
      '<div style="background:#CCE5FF;border:1px solid #80BFFF;border-radius:10px;padding:16px;text-align:center;">' +
        '<div style="font-size:28px;font-weight:800;color:#004085;">' + (data.sending || 0) + '</div>' +
        '<div style="font-size:12px;font-weight:600;color:#004085;margin-top:4px;">En cours</div>' +
      '</div>' +
      '<div style="background:#D4EDDA;border:1px solid #27AE60;border-radius:10px;padding:16px;text-align:center;">' +
        '<div style="font-size:28px;font-weight:800;color:#155724;">' + (data.sent || 0) + '</div>' +
        '<div style="font-size:12px;font-weight:600;color:#155724;margin-top:4px;">Terminés</div>' +
      '</div>' +
      '<div style="background:#F8D7DA;border:1px solid #E74C3C;border-radius:10px;padding:16px;text-align:center;">' +
        '<div style="font-size:28px;font-weight:800;color:#721C24;">' + (data.failed || 0) + '</div>' +
        '<div style="font-size:12px;font-weight:600;color:#721C24;margin-top:4px;">Échecs</div>' +
      '</div>' +
    '</div>';

    if (data.failedItems && data.failedItems.length > 0) {
      html += '<details style="margin-bottom:16px;">' +
        '<summary style="cursor:pointer;font-size:14px;font-weight:700;color:var(--danger);padding:10px 0;">Biens en échec — détail et raison (' + data.failedItems.length + ')</summary>' +
        '<div style="margin-top:8px;">' +
        data.failedItems.map(item => {
          const chIcon = item.channel === 'sms' ? '<i class="fas fa-sms" style="color:#2980b9;margin-right:4px;" title="SMS"></i>' : item.channel === 'whatsapp' ? '<i class="fab fa-whatsapp" style="color:#25D366;margin-right:4px;" title="WhatsApp"></i>' : '<i class="fas fa-envelope" style="color:var(--primary);margin-right:4px;" title="Email"></i>';
          return '<div style="display:flex;justify-content:space-between;align-items:center;padding:10px 12px;background:#fafafa;border:1px solid var(--border);border-radius:8px;margin-bottom:6px;">' +
            '<div style="flex:1;">' +
              '<div style="font-size:13px;font-weight:600;">' + chIcon + esc(item.bien_titre || 'Bien inconnu') + '</div>' +
              '<div style="font-size:11px;color:var(--text-light);">Acquéreur: ' + esc(item.acquereur_titre || item.acquereur_contact || '—') + '</div>' +
              '<div style="font-size:11px;color:var(--danger);margin-top:2px;">' + esc(item.error_message || 'Erreur inconnue') + ' (tentatives: ' + item.attempts + ')</div>' +
            '</div>' +
            '<button onclick="deleteEmailQueueItem(' + item.id + ')" style="background:none;border:none;color:var(--danger);cursor:pointer;font-size:14px;padding:4px 8px;" title="Supprimer"><i class="fas fa-trash"></i></button>' +
          '</div>'; }
        ).join('') +
        '</div></details>';
    }

    html += '<div style="display:flex;gap:10px;margin-bottom:16px;">' +
      '<button onclick="retryFailedEmails(false)" style="background:var(--primary);color:white;border:none;border-radius:8px;padding:10px 18px;font-size:13px;font-weight:600;cursor:pointer;"><i class="fas fa-redo" style="margin-right:6px;"></i> Renvoyer les mails échoués</button>' +
      '<button onclick="retryFailedEmails(true)" style="background:#20B2AA;color:white;border:none;border-radius:8px;padding:10px 18px;font-size:13px;font-weight:600;cursor:pointer;"><i class="fas fa-exclamation-circle" style="margin-right:6px;"></i> Forcer le renvoi (y compris max tentatives)</button>' +
    '</div>';

    html += '<details>' +
      '<summary style="cursor:pointer;font-size:14px;font-weight:700;color:var(--secondary);padding:10px 0;">Historique des envois (500 derniers)</summary>' +
      '<div style="display:flex;gap:6px;flex-wrap:wrap;margin:10px 0 8px;">' +
        '<button class="email-hist-filter active" data-ehf="all" onclick="setEmailHistFilter(\'all\',this)" style="padding:5px 12px;border-radius:16px;font-size:12px;font-weight:600;cursor:pointer;border:1.5px solid var(--primary);background:var(--primary);color:white;">Tous</button>' +
        '<button class="email-hist-filter" data-ehf="opened" onclick="setEmailHistFilter(\'opened\',this)" style="padding:5px 12px;border-radius:16px;font-size:12px;font-weight:600;cursor:pointer;border:1.5px solid #2980b9;background:white;color:#2980b9;">Ouvert</button>' +
        '<button class="email-hist-filter" data-ehf="not_opened" onclick="setEmailHistFilter(\'not_opened\',this)" style="padding:5px 12px;border-radius:16px;font-size:12px;font-weight:600;cursor:pointer;border:1.5px solid #7f8c8d;background:white;color:#7f8c8d;">Non ouvert</button>' +
        '<button class="email-hist-filter" data-ehf="clicked" onclick="setEmailHistFilter(\'clicked\',this)" style="padding:5px 12px;border-radius:16px;font-size:12px;font-weight:600;cursor:pointer;border:1.5px solid #27ae60;background:white;color:#27ae60;">Cliqué</button>' +
        '<button class="email-hist-filter" data-ehf="delivered" onclick="setEmailHistFilter(\'delivered\',this)" style="padding:5px 12px;border-radius:16px;font-size:12px;font-weight:600;cursor:pointer;border:1.5px solid #95a5a6;background:white;color:#95a5a6;">Délivré</button>' +
        '<button class="email-hist-filter" data-ehf="bounce_blocked" onclick="setEmailHistFilter(\'bounce_blocked\',this)" style="padding:5px 12px;border-radius:16px;font-size:12px;font-weight:600;cursor:pointer;border:1.5px solid #e74c3c;background:white;color:#e74c3c;">Rebond / Bloqué</button>' +
      '</div>' +
      '<div id="emailHistoryList" style="margin-top:8px;"><div class="loading"><i class="fas fa-spinner"></i><p>Chargement...</p></div></div>' +
    '</details>';

    content.innerHTML = html;
    loadEmailHistory();
  } catch(e) {
    content.innerHTML = '<div style="color:var(--danger);padding:20px;text-align:center;">Erreur: ' + esc(e.message) + '</div>';
  }
}

let brevoEventsCache = {};
let emailHistoryItems = [];
let currentEmailHistFilter = 'all';

function setEmailHistFilter(filter, btn) {
  currentEmailHistFilter = filter;
  document.querySelectorAll('.email-hist-filter').forEach(b => {
    const f = b.dataset.ehf;
    const isActive = f === filter;
    b.classList.toggle('active', isActive);
    if (isActive) {
      b.style.background = b.style.borderColor;
      b.style.color = 'white';
    } else {
      b.style.background = 'white';
      b.style.color = b.style.borderColor;
    }
  });
  renderFilteredEmailHistory();
}

function getEmailTrackingStatus(item) {
  if (item.status !== 'sent' || item.channel === 'sms' || item.channel === 'whatsapp' || !item.acquereur_email) return null;
  const events = brevoEventsCache[item.acquereur_email] || [];
  const msgId = item.brevo_message_id;
  const relevantEvents = msgId
    ? events.filter(e => e.messageId === msgId)
    : events.filter(e => {
        const evDate = new Date(e.date);
        const sentDate = new Date(item.sent_at);
        return Math.abs(evDate - sentDate) < 3600000;
      });
  const hasOpen = relevantEvents.some(e => e.event === 'opened');
  const hasClick = relevantEvents.some(e => e.event === 'click');
  const hasDelivered = relevantEvents.some(e => e.event === 'delivered');
  const hasBounce = relevantEvents.some(e => e.event === 'hardBounce' || e.event === 'softBounce');
  const hasBlocked = relevantEvents.some(e => e.event === 'blocked');
  if (hasBounce) return 'bounce';
  if (hasBlocked) return 'blocked';
  if (hasClick) return 'clicked';
  if (hasOpen) return 'opened';
  if (hasDelivered) return 'delivered';
  return 'unknown';
}

function renderFilteredEmailHistory() {
  const list = document.getElementById('emailHistoryList');
  if (!list) return;
  let filtered = emailHistoryItems;
  if (currentEmailHistFilter !== 'all') {
    filtered = emailHistoryItems.filter(item => {
      const ts = getEmailTrackingStatus(item);
      switch (currentEmailHistFilter) {
        case 'opened': return ts === 'opened';
        case 'not_opened': return ts === 'delivered' || ts === 'unknown';
        case 'clicked': return ts === 'clicked';
        case 'delivered': return ts === 'delivered';
        case 'bounce_blocked': return ts === 'bounce' || ts === 'blocked';
        default: return true;
      }
    });
  }
  if (!filtered.length) {
    list.innerHTML = '<div style="font-size:13px;color:var(--text-light);padding:8px;">Aucun email correspondant à ce filtre.</div>';
    return;
  }
  list.innerHTML = '<div style="max-height:400px;overflow-y:auto;">' +
    filtered.map(item => renderEmailHistoryRow(item)).join('') +
  '</div>';
}

function renderEmailHistoryRow(item) {
  const statusColor = item.status === 'sent' ? 'var(--success)' : item.status === 'failed' ? 'var(--danger)' : item.status === 'sending' ? '#3498DB' : '#F39C12';
  const statusLabel = item.status === 'sent' ? 'Envoyé' : item.status === 'failed' ? 'Échoué' : item.status === 'sending' ? 'En cours' : 'En attente';
  const chIcon = item.channel === 'sms' ? '<i class="fas fa-sms" style="color:#2980b9;margin-right:4px;" title="SMS"></i>' : item.channel === 'whatsapp' ? '<i class="fab fa-whatsapp" style="color:#25D366;margin-right:4px;" title="WhatsApp"></i>' : '<i class="fas fa-envelope" style="color:var(--primary);margin-right:4px;" title="Email"></i>';

  let trackingHtml = '';
  const ts = getEmailTrackingStatus(item);
  if (ts !== null) {
    if (ts === 'bounce') trackingHtml = '<span style="color:#e74c3c;font-size:11px;" title="Rebond"><i class="fas fa-exclamation-triangle"></i> Rebond</span>';
    else if (ts === 'blocked') trackingHtml = '<span style="color:#e74c3c;font-size:11px;" title="Bloqué"><i class="fas fa-ban"></i> Bloqué</span>';
    else if (ts === 'clicked') trackingHtml = '<span style="color:#27ae60;font-size:11px;" title="Cliqué"><i class="fas fa-mouse-pointer"></i> Cliqué</span>';
    else if (ts === 'opened') trackingHtml = '<span style="color:#2980b9;font-size:11px;" title="Ouvert"><i class="fas fa-envelope-open"></i> Ouvert</span>';
    else if (ts === 'delivered') trackingHtml = '<span style="color:#7f8c8d;font-size:11px;" title="Délivré"><i class="fas fa-check"></i> Délivré</span>';
    else trackingHtml = '<span style="color:#bdc3c7;font-size:11px;" title="Pas encore d\'info"><i class="fas fa-clock"></i></span>';
  }

  return '<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 10px;border-bottom:1px solid var(--border);font-size:12px;">' +
    '<div style="width:30px;text-align:center;">' + chIcon + '</div>' +
    '<div style="flex:1;">' + esc(item.bien_titre || '—') + '</div>' +
    '<div style="flex:1;color:var(--text-light);">' + esc(item.acquereur_titre || '—') + '</div>' +
    '<div style="width:100px;color:var(--text-light);">' + fmtDate(item.sent_at || item.created_at) + '</div>' +
    '<div style="width:80px;"><span style="background:' + statusColor + ';color:white;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:600;">' + statusLabel + '</span></div>' +
    '<div style="width:80px;text-align:center;">' + trackingHtml + '</div>' +
  '</div>';
}

async function loadEmailHistory() {
  const list = document.getElementById('emailHistoryList');
  if (!list) return;
  try {
    const res = await fetch('/api/email-queue/history');
    const data = await res.json();
    if (!data.items || !data.items.length) {
      emailHistoryItems = [];
      list.innerHTML = '<div style="font-size:13px;color:var(--text-light);padding:8px;">Aucun email dans l\'historique.</div>';
      emailHistoryItems = [];
      return;
    }

    const sentEmails = [...new Set(data.items.filter(i => i.status === 'sent' && i.channel !== 'sms' && i.acquereur_email).map(i => i.acquereur_email))];
    brevoEventsCache = {};
    const eventsPromises = sentEmails.slice(0, 20).map(async email => {
      try {
        const r = await fetch('/api/brevo/events/' + encodeURIComponent(email));
        const d = await r.json();
        if (d.events) brevoEventsCache[email] = d.events;
      } catch(e) {}
    });
    await Promise.all(eventsPromises);

    emailHistoryItems = data.items;
    currentEmailHistFilter = 'all';
    renderFilteredEmailHistory();
  } catch(e) {
    const list = document.getElementById('emailHistoryList');
    if (list) list.innerHTML = '<div style="font-size:13px;color:#c00;padding:8px;">Erreur chargement historique: ' + esc(e.message) + '</div>';
  }
}

// ============================================================
//  SEARCH HISTORY (localStorage)
// ============================================================
function getSearchHistory() {
  try { return JSON.parse(localStorage.getItem('acq_search_history') || '[]'); } catch(e) { return []; }
}

function addToSearchHistory(acq, resultCount) {
  let history = getSearchHistory();
  history = history.filter(h => h.id !== acq.id);
  history.unshift({ id: acq.id, titre: acq.titre, contact_name: acq.contact_name, timestamp: new Date().toISOString() });
  if (history.length > 20) history = history.slice(0, 20);
  try { localStorage.setItem('acq_search_history', JSON.stringify(history)); } catch(e) {}

  let globalHistory = [];
  try { globalHistory = JSON.parse(localStorage.getItem('flutch_search_history') || '[]'); } catch(e) {}
  globalHistory.unshift({ acquereur: acq.titre || acq.contact_name, acquereurId: acq.id, date: new Date().toISOString(), resultCount: resultCount, tab: 'acq-bien' });
  if (globalHistory.length > 50) globalHistory = globalHistory.slice(0, 50);
  try { localStorage.setItem('flutch_search_history', JSON.stringify(globalHistory)); } catch(e) {}
}

function showSearchHistory() {
  const panel = document.getElementById('searchHistoryPanel');
  const isVisible = panel.style.display !== 'none';
  panel.style.display = isVisible ? 'none' : 'block';
  if (!isVisible) renderSearchHistory();
}

function renderSearchHistory() {
  const list = document.getElementById('searchHistoryList');
  const history = getSearchHistory();
  if (!history.length) {
    list.innerHTML = '<div style="text-align:center;color:var(--text-light);font-size:13px;padding:12px;">Aucune recherche récente</div>';
    return;
  }
  list.innerHTML = history.map(h =>
    '<div style="display:flex;align-items:center;gap:12px;padding:10px 12px;border-radius:8px;cursor:pointer;transition:background 0.15s;" onmouseover="this.style.background=\'#f0f0f0\'" onmouseout="this.style.background=\'transparent\'" onclick="selectHistoryAcquereur(' + h.id + ')">' +
      '<div style="flex:1;">' +
        '<div style="font-size:13px;font-weight:600;">' + esc(h.titre) + '</div>' +
        '<div style="font-size:11px;color:var(--text-light);">' + esc(h.contact_name || '') + ' · ' + fmtDate(h.timestamp) + '</div>' +
      '</div>' +
      '<i class="fas fa-arrow-right" style="color:var(--primary);font-size:12px;"></i>' +
    '</div>'
  ).join('');
}

async function selectHistoryAcquereur(acqId) {
  document.getElementById('searchHistoryPanel').style.display = 'none';
  try {
    const res = await fetch('/api/acquereurs/' + acqId);
    const data = await res.json();
    if (data.acquereur) {
      selectAcquereur(acqId, data.acquereur);
    } else {
      showToast('Acquéreur introuvable', 'error');
    }
  } catch(e) { showToast(e.message, 'error'); }
}

function clearSearchHistory() {
  try { localStorage.removeItem('acq_search_history'); } catch(e) {}
  renderSearchHistory();
}

// ============================================================
//  NON TRAITÉS BADGE
// ============================================================
function getNonTraitesCount(acqId) {
  if (!dashData) return 0;
  const acq = dashData.acquereurs.find(a => a.id === acqId);
  if (!acq) return 0;
  return acq.biens.filter(b => !b.statut_todo || b.statut_todo === 'non_traite').length;
}

document.addEventListener('click', (e) => {
  if (!e.target.closest('#acqSearchBox')) closeDropdown();
  if (!e.target.closest('#bienSearchBox')) { const dd = document.getElementById('bienDropdown'); if (dd) dd.classList.remove('show'); }
});

init();
