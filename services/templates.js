'use strict';

/**
 * Templates d'emails / SMS / WhatsApp et helpers de mise en forme spécifiques.
 * Ne pas confondre avec lib/format.js qui contient des helpers généraux ; ici
 * la mise en forme est calibrée pour les rendus envoyés aux clients.
 */

/**
 * @param {unknown} str
 * @returns {string}
 */
function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * @param {number|string|null|undefined} v
 * @returns {string}
 */
function formatPrice(v) {
  if (!v && v !== 0) return 'N/A';
  return Number(v).toLocaleString('fr-FR', { maximumFractionDigits: 0 }) + ' €';
}

/**
 * @param {number|string|null|undefined} v
 * @returns {string|null}
 */
function formatPercent(v) {
  if (!v && v !== 0) return null;
  return Number(v).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '%';
}

/**
 * @param {string|null|undefined} d
 * @returns {string|null}
 */
function formatDateFR(d) {
  if (!d) return null;
  const s = String(d).slice(0, 10);
  const parts = s.split('-');
  if (parts.length === 3) return parts[2] + '/' + parts[1] + '/' + parts[0];
  return s;
}

/**
 * @param {string|null|undefined} phone
 * @returns {string|null}
 */
function formatPhoneE164(phone) {
  if (!phone) return null;
  let cleaned = phone.replace(/[\s\-\.\(\)]/g, '');
  if (cleaned.startsWith('00')) cleaned = '+' + cleaned.slice(2);
  if (cleaned.startsWith('0') && !cleaned.startsWith('+')) cleaned = '+33' + cleaned.slice(1);
  if (!cleaned.startsWith('+')) cleaned = '+33' + cleaned;
  return cleaned;
}

/**
 * Carte HTML d'un bien immobilier pour l'email.
 * @param {Record<string, unknown>} bien
 * @param {number} index
 * @returns {string}
 */
function buildBienCard(bien, index) {
  const photos = [bien.photo_1, bien.photo_2, bien.photo_3, bien.photo_4].filter(Boolean);
  const photosHtml = photos.length
    ? photos.map((url) => `<img src="${escapeHtml(url)}" alt="Photo" style="max-width:200px;max-height:150px;border-radius:4px;margin:4px;" />`).join('')
    : '';

  const adresse = bien.adresse || '';
  const fullAddr = [adresse, bien.code_postal, bien.ville].filter(Boolean).join(', ');
  const escapedFullAddr = escapeHtml(fullAddr);
  const mapsLink = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(fullAddr)}`;

  const renta = bien.rentabilite ? formatPercent(bien.rentabilite) : null;
  const rentaPostRev = bien.rentabilite_post_rev ? formatPercent(bien.rentabilite_post_rev) : null;

  const surfaceParts = [];
  if (bien.surface_rdc) surfaceParts.push(`${escapeHtml(bien.surface_rdc)} en RDC`);
  if (bien.surface_sous_sol) surfaceParts.push(`${escapeHtml(bien.surface_sous_sol)} en sous-sol`);
  if (bien.surface_etage) surfaceParts.push(`${escapeHtml(bien.surface_etage)} en étage supérieur`);
  const surfaceDetail = surfaceParts.length ? ` (${surfaceParts.join(', ')})` : '';

  const rentaActuelle = bien.rentabilite_actuelle
    ? formatPercent(bien.rentabilite_actuelle)
    : (bien.rentabilite ? formatPercent(bien.rentabilite) : null);

  const lines = [];
  if (fullAddr) lines.push(`📍 <b>Adresse :</b> <a href="${escapeHtml(mapsLink)}" style="color:#d6336c;">${escapedFullAddr}</a>`);
  if (bien.surface) lines.push(`📐 <b>Surface :</b> Surface totale : ${escapeHtml(bien.surface)} m²${surfaceDetail}`);
  if (bien.surface_ponderee) lines.push(`📐 <b>Surface pondérée :</b> ${escapeHtml(bien.surface_ponderee)} m²`);
  if (bien.taxe_fonciere) {
    const imput = bien.imputation_taxe_fonciere ? ` - ${escapeHtml(bien.imputation_taxe_fonciere)}` : '';
    lines.push(`🏛️ <b>Taxe foncière :</b> ${formatPrice(bien.taxe_fonciere)}${imput}`);
  }
  if (bien.charge_annuelle) lines.push(`🏠 <b>Charge annuelle :</b> ${formatPrice(bien.charge_annuelle)}`);
  if (bien.loyer_net_bailleur) {
    lines.push(`💰 <b>Loyer net bailleur facturé :</b> ${formatPrice(bien.loyer_net_bailleur)}`);
    const imputTfNote = bien.imputation_taxe_fonciere || '';
    const tfLocataire = imputTfNote.toLowerCase().includes('locataire');
    const tf5050 = imputTfNote.includes('50/50');
    let loyerNote;
    if (tfLocataire) {
      loyerNote = 'Loyer net perçu par le bailleur : les charges et la taxe foncière sont imputées au locataire.';
    } else if (tf5050) {
      loyerNote = 'Loyer net perçu par le bailleur : les charges sont imputées au locataire, la taxe foncière est partagée 50/50.';
    } else {
      loyerNote = 'Loyer net perçu par le bailleur : les charges sont imputées au locataire, la taxe foncière reste à la charge du bailleur.';
    }
    lines.push(`<i style="font-size:12px;color:#666;">${loyerNote}</i>`);
  }
  if (bien.prise_effet_bail) lines.push(`📅 <b>Prise d'effet du bail :</b> ${formatDateFR(bien.prise_effet_bail)}`);
  if (bien.loyer_post_revision) lines.push(`💵 <b>Loyer post-révision :</b> ${formatPrice(bien.loyer_post_revision)} net bailleur`);
  if (bien.prix_fai) lines.push(`🏷️ <b>Prix :</b> ${formatPrice(bien.prix_fai)} honoraires inclus`);
  if (rentaActuelle) lines.push(`📊 <b>Rendement actuel :</b> ${rentaActuelle}`);
  if (rentaPostRev) lines.push(`📈 <b>Rendement post-révision :</b> ${rentaPostRev}`);
  if (bien.assujettissement_tva) lines.push(`📋 <b>Assujettissement à la TVA :</b> ${escapeHtml(bien.assujettissement_tva)}`);
  if (bien.modalite_augmentation) lines.push(`📝 <b>Modalité d'augmentation du loyer :</b> ${escapeHtml(bien.modalite_augmentation)}`);
  if (bien.points_positifs) lines.push(`✅ <b>Point positif :</b> ${escapeHtml(bien.points_positifs)}`);
  if (bien.point_vigilance) lines.push(`⚠️ <b>Point de vigilance :</b> ${escapeHtml(bien.point_vigilance)}`);

  let calcHtml = '';
  if (bien.loyer_net_bailleur && bien.prix_fai) {
    const loyerAnnuel = Number(bien.loyer_net_bailleur);
    const loyerMensuel = loyerAnnuel / 12;
    const tf = bien.taxe_fonciere ? Number(bien.taxe_fonciere) : 0;
    const charges = bien.charge_annuelle ? Number(bien.charge_annuelle) : 0;
    const prix = Number(bien.prix_fai);
    const imputTf = bien.imputation_taxe_fonciere || '';
    const tfImputee = imputTf.toLowerCase().includes('locataire');
    const tf5050 = imputTf.includes('50/50');

    const equationParts = [];
    equationParts.push(`Loyer net bailleur : ${formatPrice(loyerMensuel)}/mois × 12 = <b>${formatPrice(loyerAnnuel)}/an</b>`);
    if (charges) equationParts.push(`Charges annuelles : ${formatPrice(charges)} <i style="color:#888;">(imputées au locataire, déjà déduites du loyer net)</i>`);

    let netAnnuel = loyerAnnuel;
    if (tf) {
      if (tfImputee) {
        equationParts.push(`Taxe foncière : ${formatPrice(tf)} <i style="color:#888;">(imputée au locataire, déjà déduite du loyer net)</i>`);
      } else if (tf5050) {
        const tfPart = Math.round(tf / 2);
        equationParts.push(`Taxe foncière : ${formatPrice(tf)} (50/50) → part bailleur : <b>- ${formatPrice(tfPart)}</b>`);
        netAnnuel -= tfPart;
      } else {
        equationParts.push(`Taxe foncière (non imputée) : <b>- ${formatPrice(tf)}</b>`);
        netAnnuel -= tf;
      }
    }
    const rendement = prix > 0 ? ((netAnnuel / prix) * 100).toFixed(2) : '—';

    calcHtml = `
      <div style="margin-top:12px;padding:16px 20px;background:#f5f0ff;border:1px solid #d6c8ed;border-radius:8px;">
        <div style="font-size:13px;font-weight:700;color:#4a1942;margin-bottom:10px;">📊 Calcul du rendement net :</div>
        <div style="font-size:13px;color:#333;line-height:2;">
          ${equationParts.join('<br/>')}
          <br/><b style="color:#4a1942;">Revenu net annuel : ${formatPrice(netAnnuel)}</b>
          <br/><b style="color:#d6336c;">Rendement net : ${formatPrice(netAnnuel)} / ${formatPrice(prix)} = ${rendement}%</b>
        </div>
      </div>
    `;
  }

  return `
    <div style="border:2px solid #d6336c;border-radius:12px;margin:30px 0;overflow:hidden;">
      <div style="background:#d6336c;color:white;padding:18px 30px;font-size:17px;font-weight:bold;text-align:center;">
        ${index}. ${escapeHtml(bien.titre || 'Bien sans titre')}
      </div>
      ${photosHtml ? `<div style="text-align:center;padding:20px 30px;background:#f9f9f9;">${photosHtml}</div>` : ''}
      <div style="padding:24px 30px;font-size:14px;line-height:2;color:#333;">
        ${lines.join('<br/>')}
        ${calcHtml}
      </div>
    </div>
  `;
}

/**
 * Construit le texte d'un SMS de prospection.
 * @param {Record<string, unknown>} acq
 * @param {Array<Record<string, unknown>>} biens
 * @returns {string}
 */
function buildSMSText(acq, biens) {
  const ownerName = acq.owner_name || 'Le Boutiquier';
  const contactName = acq.contact_name || acq.titre || '';
  const prenom = String(contactName).split(' ')[0] || contactName;
  const nbBiens = biens.length;

  let text = `Bonjour ${prenom},\n`;
  text += `${ownerName} vous propose ${nbBiens} bien${nbBiens > 1 ? 's' : ''} correspondant à vos critères :\n\n`;

  for (const b of biens.slice(0, 3)) {
    const titre = b.titre || 'Bien';
    const prix = b.prix_fai ? ` - ${Number(b.prix_fai).toLocaleString('fr-FR')}€` : '';
    const renta = b.rentabilite_actuelle || b.rentabilite;
    const rentaStr = renta ? ` (${Number(renta).toFixed(1)}%)` : '';
    const ville = b.ville || '';
    text += `• ${titre}${ville ? ' (' + ville + ')' : ''}${prix}${rentaStr}\n`;
  }
  if (nbBiens > 3) text += `+ ${nbBiens - 3} autre(s)...\n`;
  text += `\nCordialement, ${ownerName}\nLe Boutiquier`;
  return text;
}

/**
 * Construit le texte d'un message WhatsApp.
 * @param {Record<string, unknown>} acq
 * @param {Array<Record<string, unknown>>} biens
 * @param {string} ownerName
 * @returns {string}
 */
function buildWhatsAppText(acq, biens, ownerName) {
  const contactName = acq.contact_name || acq.titre || '';
  const prenom = String(contactName).split(' ')[0] || contactName;
  const nbBiens = biens.length;

  let text = `Bonjour ${prenom},\n\n`;
  text += `${ownerName} de l'agence *Le Boutiquier* vous propose ${nbBiens} bien${nbBiens > 1 ? 's' : ''} correspondant à vos critères :\n\n`;

  for (const b of biens) {
    const titre = b.titre || 'Bien';
    const prix = b.prix_fai ? ` — ${Number(b.prix_fai).toLocaleString('fr-FR')} €` : '';
    const renta = b.rentabilite_post_rev || b.rentabilite_actuelle || b.rentabilite;
    const rentaStr = renta ? ` (renta ${Number(renta).toFixed(1)}%)` : '';
    const ville = b.ville || '';
    const surface = b.surface ? ` · ${b.surface} m²` : '';
    text += `🏠 *${titre}*\n`;
    text += `   📍 ${ville || 'Localisation non précisée'}${surface}\n`;
    text += `   💰 ${prix || 'Prix non communiqué'}${rentaStr}\n\n`;
  }
  text += `N'hésitez pas à me contacter pour plus d'informations ou organiser une visite.\n\n`;
  text += `Cordialement,\n${ownerName}\n📞 Le Boutiquier`;
  return text;
}

module.exports = {
  escapeHtml,
  formatPrice,
  formatPercent,
  formatDateFR,
  formatPhoneE164,
  buildBienCard,
  buildSMSText,
  buildWhatsAppText,
};
