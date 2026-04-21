let bugDrawing = false;
let bugStartX = 0, bugStartY = 0;
let bugCanvasCtx = null;
let bugCircles = [];

function openBugReport() {
  document.getElementById('bugStep1').classList.add('active');
  document.getElementById('bugStep2').classList.remove('active');
  document.getElementById('bugNote').value = '';
  document.getElementById('bugOverlay').classList.add('active');
}
function closeBugReport() {
  document.getElementById('bugOverlay').classList.remove('active');
}
function bugGoStep1() {
  document.getElementById('bugStep2').classList.remove('active');
  document.getElementById('bugStep1').classList.add('active');
}

async function bugGoStep2() {
  if (!document.getElementById('bugNote').value.trim()) {
    document.getElementById('bugNote').focus();
    document.getElementById('bugNote').style.borderColor = '#e74c3c';
    setTimeout(() => document.getElementById('bugNote').style.borderColor = '#e8e8e8', 2000);
    return;
  }
  document.getElementById('bugOverlay').style.display = 'none';
  await new Promise(r => setTimeout(r, 300));
  try {
    const canvas = await html2canvas(document.body, { useCORS: true, scale: 0.6 });
    const dataUrl = canvas.toDataURL('image/jpeg', 0.55);
    const img = document.getElementById('bugScreenshotImg');
    img.src = dataUrl;
    img.onload = () => {
      const dc = document.getElementById('bugDrawCanvas');
      dc.width = img.naturalWidth;
      dc.height = img.naturalHeight;
      dc.style.width = '100%';
      dc.style.height = '100%';
      bugCanvasCtx = dc.getContext('2d');
      bugCanvasCtx.lineCap = 'round';
      bugCircles = [];
      setupBugDraw(dc);
    };
  } catch(e) { console.error(e); }
  document.getElementById('bugOverlay').style.display = 'flex';
  document.getElementById('bugOverlay').classList.add('active');
  document.getElementById('bugStep1').classList.remove('active');
  document.getElementById('bugStep2').classList.add('active');
}

function setupBugDraw(c) {
  const getPos = (e) => {
    const rect = c.getBoundingClientRect();
    const t = e.touches ? e.touches[0] : e;
    return { x: (t.clientX - rect.left) * (c.width / rect.width), y: (t.clientY - rect.top) * (c.height / rect.height) };
  };
  const onDown = (e) => { e.preventDefault(); bugDrawing = true; const p = getPos(e); bugStartX = p.x; bugStartY = p.y; };
  const onMove = (e) => {
    if (!bugDrawing) return; e.preventDefault();
    const p = getPos(e);
    redrawBugCanvas();
    const rx = Math.abs(p.x - bugStartX) / 2, ry = Math.abs(p.y - bugStartY) / 2;
    const cx = (p.x + bugStartX) / 2, cy = (p.y + bugStartY) / 2;
    if (rx > 5 || ry > 5) {
      bugCanvasCtx.strokeStyle = '#e74c3c'; bugCanvasCtx.lineWidth = 4;
      bugCanvasCtx.beginPath(); bugCanvasCtx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2); bugCanvasCtx.stroke();
    }
  };
  const onUp = (e) => {
    if (!bugDrawing) return; bugDrawing = false;
    const p = getPos(e.changedTouches ? e.changedTouches[0] : e);
    const rx = Math.abs(p.x - bugStartX) / 2, ry = Math.abs(p.y - bugStartY) / 2;
    if (rx > 5 || ry > 5) bugCircles.push({ sx: bugStartX, sy: bugStartY, ex: p.x, ey: p.y });
  };
  c.onmousedown = onDown; c.onmousemove = onMove; c.onmouseup = onUp; c.onmouseleave = (e) => { if (bugDrawing) onUp(e); };
  c.ontouchstart = onDown; c.ontouchmove = onMove; c.ontouchend = onUp;
}

function redrawBugCanvas() {
  if (!bugCanvasCtx) return;
  bugCanvasCtx.clearRect(0, 0, bugCanvasCtx.canvas.width, bugCanvasCtx.canvas.height);
  bugCircles.forEach(c => {
    const rx = Math.abs(c.ex - c.sx) / 2, ry = Math.abs(c.ey - c.sy) / 2;
    const cx = (c.ex + c.sx) / 2, cy = (c.ey + c.sy) / 2;
    bugCanvasCtx.strokeStyle = '#e74c3c'; bugCanvasCtx.lineWidth = 4;
    bugCanvasCtx.beginPath(); bugCanvasCtx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2); bugCanvasCtx.stroke();
  });
}

function clearBugDraw() {
  if (!bugCanvasCtx) return;
  bugCanvasCtx.clearRect(0, 0, bugCanvasCtx.canvas.width, bugCanvasCtx.canvas.height);
  bugCircles = [];
}

async function sendBugReport() {
  const note = document.getElementById('bugNote').value.trim();
  const mergeCanvas = document.createElement('canvas');
  const img = document.getElementById('bugScreenshotImg');
  mergeCanvas.width = img.naturalWidth; mergeCanvas.height = img.naturalHeight;
  const mCtx = mergeCanvas.getContext('2d');
  mCtx.drawImage(img, 0, 0);
  mCtx.drawImage(document.getElementById('bugDrawCanvas'), 0, 0);
  const screenshotData = mergeCanvas.toDataURL('image/jpeg', 0.55);

  const btn = document.getElementById('bugSendBtn');
  btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Envoi...';

  try {
    const r = await fetch('/api/bug-report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + localStorage.getItem('token') },
      body: JSON.stringify({ note, screenshot: screenshotData })
    });
    const d = await r.json();
    if (d.success) {
      btn.innerHTML = '<i class="fas fa-check"></i> Envoyé !';
      setTimeout(() => { closeBugReport(); btn.disabled = false; btn.innerHTML = '<i class="fas fa-paper-plane"></i> Envoyer'; }, 1500);
    } else {
      alert('Erreur: ' + (d.error || 'Échec'));
      btn.disabled = false; btn.innerHTML = '<i class="fas fa-paper-plane"></i> Envoyer';
    }
  } catch(e) {
    alert('Erreur réseau');
    btn.disabled = false; btn.innerHTML = '<i class="fas fa-paper-plane"></i> Envoyer';
  }
}

let waCurrentData = null;

function closeWhatsAppModal() {
  document.getElementById('whatsappOverlay').style.display = 'none';
  waCurrentData = null;
}

async function openWhatsAppPreview(acqId, bienIds) {
  const overlay = document.getElementById('whatsappOverlay');
  overlay.style.display = 'flex';
  document.getElementById('waLoading').style.display = 'block';
  document.getElementById('waContent').style.display = 'none';

  try {
    const r = await fetch('/api/whatsapp-preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ acquereur_id: acqId, bien_ids: bienIds })
    });
    const d = await r.json();
    if (!d.success) { alert(d.error || 'Erreur'); closeWhatsAppModal(); return; }

    waCurrentData = d;
    document.getElementById('waAvatar').textContent = (d.contactName || '?')[0].toUpperCase();
    document.getElementById('waContactName').textContent = d.contactName || 'Contact';
    document.getElementById('waPhone').textContent = d.phoneDisplay || d.phone;
    document.getElementById('waMessageEdit').value = d.message;
    document.getElementById('waLoading').style.display = 'none';
    document.getElementById('waContent').style.display = 'block';
  } catch (e) {
    alert('Erreur: ' + e.message);
    closeWhatsAppModal();
  }
}

async function sendWhatsApp() {
  if (!waCurrentData) return;
  const btn = document.getElementById('waSendBtn');
  const msg = document.getElementById('waMessageEdit').value.trim();
  if (!msg) { alert('Le message ne peut pas être vide'); return; }

  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Envoi...';

  try {
    const r = await fetch('/api/whatsapp-send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        acquereur_id: waCurrentData.acqId,
        bien_ids: waCurrentData.bienIds,
        message: msg
      })
    });
    const d = await r.json();
    if (d.success) {
      btn.innerHTML = '<i class="fas fa-check"></i> Envoyé !';
      btn.style.background = '#27ae60';
      setTimeout(() => {
        closeWhatsAppModal();
        btn.disabled = false;
        btn.innerHTML = '<i class="fab fa-whatsapp" style="margin-right:6px;"></i>Envoyer';
        btn.style.background = '#25D366';
        if (typeof loadDashboard === 'function') loadDashboard();
        if (typeof loadBienResults === 'function') loadBienResults();
      }, 1200);
    } else {
      alert('Erreur: ' + (d.error || 'Échec envoi'));
      btn.disabled = false;
      btn.innerHTML = '<i class="fab fa-whatsapp" style="margin-right:6px;"></i>Envoyer';
    }
  } catch (e) {
    alert('Erreur réseau: ' + e.message);
    btn.disabled = false;
    btn.innerHTML = '<i class="fab fa-whatsapp" style="margin-right:6px;"></i>Envoyer';
  }
}

function dashWhatsAppAction() {
  const entries = Object.entries(dashSelectedBiens).filter(([,set]) => set.size > 0);
  if (!entries.length) { showToast('Sélectionnez des biens d\'abord', 'error'); return; }
  if (entries.length > 1) { showToast('WhatsApp: sélectionnez les biens d\'un seul acquéreur à la fois', 'error'); return; }
  const [acqIdStr, bienSet] = entries[0];
  openWhatsAppPreview(parseInt(acqIdStr), [...bienSet]);
}

function openWhatsAppPreviewTab2(bienId) {
  if (!selectedAcquereur) { showToast('Sélectionnez d\'abord un acquéreur', 'error'); return; }
  openWhatsAppPreview(selectedAcquereur.id, [bienId]);
}

function bulkWhatsAppAction() {
  if (!selectedAcquereur) { showToast('Sélectionnez d\'abord un acquéreur', 'error'); return; }
  if (!selectedBiens.size) { showToast('Sélectionnez au moins un bien', 'error'); return; }
  openWhatsAppPreview(selectedAcquereur.id, [...selectedBiens]);
}

function toggleHistoryPanel() {
  const panel = document.getElementById('historySlidePanel');
  const overlay = document.getElementById('historyOverlay');
  const isOpen = panel.classList.contains('open');
  if (isOpen) {
    panel.classList.remove('open');
    overlay.classList.remove('open');
  } else {
    panel.classList.add('open');
    overlay.classList.add('open');
    setHistoryTab('envois');
  }
}

function setHistoryTab(tab) {
  document.querySelectorAll('.history-panel-tab').forEach(t => t.classList.toggle('active', t.dataset.htab === tab));
  if (tab === 'recherches') {
    renderHistorySearches();
  } else {
    renderHistoryEnvois();
  }
}

function renderHistorySearches() {
  const body = document.getElementById('historyPanelBody');
  const searches = JSON.parse(localStorage.getItem('flutch_search_history') || '[]');
  if (!searches.length) {
    body.innerHTML = '<div style="text-align:center;padding:40px 0;color:var(--text-light);"><i class="fas fa-search" style="font-size:28px;margin-bottom:12px;display:block;opacity:0.3;"></i><p>Aucune recherche récente</p></div>';
    return;
  }
  body.innerHTML = searches.map((s, i) => {
    const date = new Date(s.date);
    const dateStr = date.toLocaleDateString('fr-FR') + ' ' + date.toLocaleTimeString('fr-FR', {hour:'2-digit',minute:'2-digit'});
    return '<div class="history-item" onclick="recallSearch(' + i + ')">' +
      '<div class="history-item-title"><i class="fas fa-user" style="color:var(--primary);margin-right:6px;"></i>' + esc(s.acquereur || 'Recherche libre') + '</div>' +
      '<div class="history-item-meta"><i class="fas fa-calendar"></i> ' + dateStr +
      (s.resultCount !== undefined ? ' &middot; ' + s.resultCount + ' résultat(s)' : '') + '</div>' +
    '</div>';
  }).join('');
}

async function renderHistoryEnvois() {
  const body = document.getElementById('historyPanelBody');
  body.innerHTML = '<div style="text-align:center;padding:20px;"><i class="fas fa-spinner fa-spin"></i> Chargement...</div>';
  try {
    const res = await fetch('/api/email-queue/history');
    const data = await res.json();
    const envois = (data.items || data).slice(0, 100);
    if (!envois.length) {
      body.innerHTML = '<div style="text-align:center;padding:40px 0;color:var(--text-light);"><i class="fas fa-paper-plane" style="font-size:28px;margin-bottom:12px;display:block;opacity:0.3;"></i><p>Aucun envoi récent</p></div>';
      return;
    }
    body.innerHTML = envois.map(e => {
      const channel = (e.channel || 'email').toLowerCase();
      const channelIcon = channel === 'sms' ? 'fa-sms' : channel === 'whatsapp' ? 'fa-whatsapp' : 'fa-envelope';
      const channelClass = channel === 'sms' ? 'sms' : channel === 'whatsapp' ? 'whatsapp' : 'email';
      const statusClass = e.status === 'sent' ? 'success' : e.status === 'failed' ? 'error' : 'pending';
      const statusIcon = statusClass === 'success' ? 'fa-check-circle' : statusClass === 'error' ? 'fa-exclamation-circle' : 'fa-clock';
      const statusLabel = e.status === 'sent' ? 'Envoyé' : e.status === 'failed' ? 'Erreur' : e.status === 'pending' ? 'En attente' : e.status === 'sending' ? 'En cours' : (e.status || '—');
      const date = e.created_at ? new Date(e.created_at) : null;
      const dateStr = date ? date.toLocaleDateString('fr-FR') + ' ' + date.toLocaleTimeString('fr-FR', {hour:'2-digit',minute:'2-digit'}) : '';
      const recipient = e.acquereur_contact || e.acquereur_titre || e.acquereur_email || '—';
      const bienInfo = e.bien_titre || (e.bien_pd_id ? '#' + e.bien_pd_id : '');
      return '<div class="history-item">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">' +
          '<div class="history-item-title" style="margin:0;"><i class="fas fa-user" style="color:var(--primary);margin-right:4px;font-size:11px;"></i>' + esc(recipient) + '</div>' +
          '<span class="history-item-channel ' + channelClass + '"><i class="fas ' + channelIcon + '"></i> ' + channel.toUpperCase() + '</span>' +
        '</div>' +
        (bienInfo ? '<div style="font-size:11px;color:var(--text-light);margin-bottom:4px;"><i class="fas fa-home" style="margin-right:4px;"></i>' + esc(bienInfo) + '</div>' : '') +
        '<div class="history-item-meta">' +
          '<span class="history-status ' + statusClass + '"><i class="fas ' + statusIcon + '"></i> ' + statusLabel + '</span>' +
          (dateStr ? ' &middot; ' + dateStr : '') +
        '</div>' +
      '</div>';
    }).join('');
  } catch(err) {
    body.innerHTML = '<div style="text-align:center;padding:20px;color:var(--danger);"><i class="fas fa-exclamation-triangle"></i> Erreur: ' + err.message + '</div>';
  }
}

function recallSearch(index) {
  const searches = JSON.parse(localStorage.getItem('flutch_search_history') || '[]');
  const s = searches[index];
  if (!s) return;
  toggleHistoryPanel();
  if (s.tab === 'acq-bien' && s.acquereurId) {
    switchTab('acq-bien');
    selectAcquereur(s.acquereurId);
  }
}

function clearAllHistory(type) {
  if (type === 'recherches') {
    localStorage.removeItem('flutch_search_history');
    renderHistorySearches();
    showToast('Historique des recherches effacé', 'success');
  } else {
    showToast('L\'historique des envois est géré côté serveur', 'info');
  }
}

let currentHistoryTab = 'envois';
