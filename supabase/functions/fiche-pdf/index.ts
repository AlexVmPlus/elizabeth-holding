// ============================================================================
// Edge Function : fiche-pdf (Elizabeth Holding)
// Genere COTE SERVEUR la fiche de synthese 1 page A4 (vrai PDF, jsPDF par
// positionnement — on a abandonne html2canvas qui produisait des PDF blancs).
// Recoit { loc, neuf, insee } (donnees de l'etude calculees par scrape-etude),
// recupere la photo de la ville via Wikipedia REST (pas de CORS cote serveur),
// renvoie application/pdf. Aucune cle externe necessaire.
// ============================================================================

import { jsPDF } from "https://esm.sh/jspdf@2.5.2";

const ALLOWED_ORIGIN = "https://alexvmplus.github.io";
const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin",
};

const BLEU = "#185FA5";
const BLEU_FONCE = "#0c3a66";
const VERT = "#0F6E56";
const GRIS = "#5b6b80";
const ENCRE = "#27303f";

// deno-lint-ignore no-explicit-any
type Any = any;

// Formatage FR avec ESPACE SIMPLE comme separateur de milliers :
// toLocaleString("fr-FR") insere des U+202F (narrow NBSP) que l'encodage
// WinAnsi de jsPDF ne sait pas rendre -> "14 219" devenait "1 4 / 2 1 9".
const eu = (x: number) => Math.round(x).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
const e1 = (x: number) => {
  const v = Math.round(x * 10) / 10;
  const [i, d] = v.toString().split(".");
  return eu(Number(i)) + (d ? "," + d : "");
};

function frDate(iso?: string): string {
  try {
    const d = iso ? new Date(iso) : new Date();
    return d.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric" });
  } catch {
    return String(iso || "");
  }
}

// --- Photo ville : Wikipedia REST cote serveur (sans CORS) -------------------
// Arrondissement "Paris 8e" -> page "8e arrondissement de Paris", sinon ville.
export async function fetchVillePhoto(ville: string): Promise<{ b64: string; fmt: "JPEG" | "PNG" } | null> {
  const names: string[] = [];
  const m = String(ville || "").match(/^(Paris|Lyon|Marseille)\s+(\d{1,2})(?:er|e)?$/i);
  if (m) names.push((m[2] === "1" ? "1er" : m[2] + "e") + " arrondissement de " + m[1]);
  names.push(String(ville || "").replace(/\s+\d.*$/, ""));
  for (const name of names) {
    try {
      const r = await fetch("https://fr.wikipedia.org/api/rest_v1/page/summary/" + encodeURIComponent(name));
      if (!r.ok) continue;
      const j = await r.json();
      let url: string | null = j?.thumbnail?.source || j?.originalimage?.source || null;
      if (!url) continue;
      // les vignettes wikimedia sont redimensionnables via le segment NNNpx-
      const big = url.replace(/\/(\d+)px-/, "/900px-");
      for (const u of [big, url]) {
        try {
          const ir = await fetch(u);
          if (!ir.ok) continue;
          const ct = ir.headers.get("content-type") || "";
          if (!/image\/(jpe?g|png)/.test(ct)) continue;
          const buf = new Uint8Array(await ir.arrayBuffer());
          // garde-fous : taille minimale + magic bytes (wikimedia renvoie une
          // page d'erreur si la taille demandee depasse l'original)
          if (buf.length < 5000) continue;
          const isJpeg = buf[0] === 0xFF && buf[1] === 0xD8;
          const isPng = buf[0] === 0x89 && buf[1] === 0x50;
          if (!isJpeg && !isPng) continue;
          let bin = "";
          for (let i = 0; i < buf.length; i += 8192) bin += String.fromCharCode(...buf.subarray(i, i + 8192));
          return { b64: btoa(bin), fmt: isPng ? "PNG" : "JPEG" };
        } catch { /* taille suivante */ }
      }
    } catch { /* nom suivant */ }
  }
  return null;
}

// --- Lecture marche : 1-2 phrases par regles ---------------------------------
function lectureMarche(rdt: number | null, insee: Any, nbProgs: number): string {
  const ph: string[] = [];
  if (rdt != null) {
    ph.push("Rendement brut moyen de " + e1(rdt) + " % : " +
      (rdt < 3.5
        ? "marché patrimonial à rendement modéré, porté par la valorisation du foncier"
        : (rdt <= 5
          ? "équilibre prix/loyers correct pour un investissement locatif"
          : "rendement locatif attractif pour de l'investissement")));
  }
  if (insee && insee.pct_loc != null) {
    ph.push(insee.pct_loc >= 55
      ? e1(insee.pct_loc) + " % de locataires : demande locative structurellement forte"
      : (insee.pct_loc >= 40
        ? e1(insee.pct_loc) + " % de locataires : demande locative solide"
        : "majorité de propriétaires" + (insee.pct_prop != null ? " (" + e1(insee.pct_prop) + " %)" : "") + " : marché de résidences principales"));
  }
  if (ph.length < 2 && nbProgs) ph.push(nbProgs + " programme" + (nbProgs > 1 ? "s" : "") + " neuf" + (nbProgs > 1 ? "s" : "") + " actif" + (nbProgs > 1 ? "s" : "") + " : offre neuve dynamique");
  return ph.slice(0, 2).join(". ") + (ph.length ? "." : "");
}

// --- Construction du PDF (1 page A4 PLEINE, 210 x 297 mm) --------------------
export function buildPdf(data: Any, photo: { b64: string; fmt: "JPEG" | "PNG" } | null): Uint8Array {
  const loc: Any = data.loc || null;
  const nf: Any = data.neuf || null;
  const insee: Any = data.insee || {};
  const ville = (loc && loc.ville) || (nf && nf.ville) || "";
  const quartier = (loc && loc.quartier) || (nf && nf.quartier) || null;
  const dateStr = frDate((loc && loc.scrapedAt) || (nf && nf.scrapedAt));
  const lm: Any = loc && loc.loyersMeuble;

  const doc = new jsPDF({ unit: "mm", format: "a4", orientation: "portrait" });
  const W = 210;
  const L = 12, R = 198;

  // ---------- agregats ----------
  const lG: Any = loc && loc.global, nG: Any = nf && nf.global;
  const loyerNM = lm && lm.global ? lm.global.non_meuble : (lG ? lG.prix_m2_cc_pondere : null);
  const loyerM = lm && lm.global ? lm.global.meuble : null;
  const prixM2 = nG ? nG.prix_m2_cc_pondere : null;
  const rdt = (loyerNM != null && prixM2) ? loyerNM * 12 / prixM2 * 100 : null;
  const lots: Any[] = (nf && nf.annonces) || [];
  let minPrix: number | null = null, minM2: number | null = null, maxM2: number | null = null;
  for (const a of lots) {
    if (a.prix_total != null && (minPrix == null || a.prix_total < minPrix)) minPrix = a.prix_total;
    if (a.prix_m2 != null) {
      if (minM2 == null || a.prix_m2 < minM2) minM2 = a.prix_m2;
      if (maxM2 == null || a.prix_m2 > maxM2) maxM2 = a.prix_m2;
    }
  }
  const progs: Record<string, Any[]> = {};
  for (const a of lots) (progs[a.nom_programme || a.url || "?"] ||= []).push(a);
  const progKeys = Object.keys(progs);
  const promoSet = new Set<string>();
  for (const a of lots) if (a.promoteur) promoSet.add(a.promoteur);

  // ---------- A. bandeau photo (48 mm) ----------
  const BAN = 48;
  if (photo) {
    try {
      doc.addImage(photo.b64, photo.fmt, 0, 0, W, 76, undefined, "FAST");
    } catch (e) {
      console.warn("addImage:", e instanceof Error ? e.message : e);
      photo = null;
    }
  }
  if (!photo) {
    doc.setFillColor(BLEU);
    doc.rect(0, 0, W, BAN, "F");
    doc.setFillColor(BLEU_FONCE);
    doc.triangle(W, 0, W, BAN, 80, BAN, "F");
  }
  doc.setFillColor("#ffffff");
  doc.rect(0, BAN, W, 297 - BAN, "F");
  doc.saveGraphicsState();
  doc.setGState(new (doc as Any).GState({ opacity: 0.55 }));
  doc.setFillColor("#081a30");
  doc.rect(0, 0, W, BAN, "F");
  doc.restoreGraphicsState();
  doc.setFillColor("#ffffff");
  doc.roundedRect(L, 8, 11, 11, 2.2, 2.2, "F");
  doc.setTextColor(BLEU);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  doc.text("EH", L + 5.5, 15.2, { align: "center" });
  doc.setTextColor("#ffffff");
  doc.setFontSize(7.5);
  doc.text("ELIZABETH HOLDING  ·  INTELLIGENCE IMMOBILIÈRE", L + 14.5, 14.5);
  doc.setFontSize(20);
  doc.text(ville + (quartier ? " · " + quartier : ""), L, 35);
  doc.setFontSize(11);
  doc.setFont("helvetica", "normal");
  doc.text("Synthèse de marché — location & achat neuf", L, 42);
  doc.setFontSize(9);
  doc.text(dateStr, R, 42, { align: "right" });
  doc.text(((loc && loc.annoncesRetenues) || 0) + " annonces · " + lots.length + " lots neufs", R, 36, { align: "right" });

  // ---------- B. 4 grands chiffres cles + 3 secondaires ----------
  const kpi = (x: number, y: number, w: number, h: number, val: string, lab: string, color = BLEU, fs = 14) => {
    doc.setFillColor("#f3f7fc");
    doc.roundedRect(x, y, w, h, 2.5, 2.5, "F");
    doc.setTextColor(color);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(fs);
    doc.text(val, x + w / 2, y + h / 2 + 0.5, { align: "center" });
    doc.setTextColor(GRIS);
    doc.setFontSize(5.8);
    doc.text(lab, x + w / 2, y + h - 3.2, { align: "center" });
  };
  const k1: Array<[string, string, string]> = [
    [loyerNM != null ? e1(loyerNM) + " €/m²" : "n/d", "LOYER NON MEUBLÉ (CC)", BLEU],
    [loyerM != null ? e1(loyerM) + " €/m²" : "n/d", "LOYER MEUBLÉ (CC)", BLEU],
    [prixM2 != null ? eu(prixM2) + " €/m²" : "n/d", "PRIX NEUF MOYEN", BLEU],
    [rdt != null ? e1(rdt) + " %" : "n/d", "RENDEMENT BRUT MOYEN", VERT],
  ];
  k1.forEach((k, i) => kpi(L + i * 47.5, 55, 44.5, 19, k[0], k[1], k[2], 13.5));
  const k2: Array<[string, string]> = [
    [minPrix != null ? eu(Math.round(minPrix / 1000)) + " k€" : "n/d", "PRIX D'ENTRÉE NEUF"],
    [minM2 != null && maxM2 != null ? eu(minM2) + " – " + eu(maxM2) + " €/m²" : "n/d", "FOURCHETTE PRIX NEUF"],
    [progKeys.length + " · " + promoSet.size, "PROGRAMMES · PROMOTEURS"],
  ];
  k2.forEach((k, i) => kpi(L + i * 63.4, 78, 59.2, 13, k[0], k[1], BLEU_FONCE, 9.5));

  // helpers section / table
  const secTitle = (txt: string, x: number, y: number, color = BLEU) => {
    doc.setFillColor(color);
    doc.rect(x, y - 3, 2.6, 3.6, "F");
    doc.setTextColor(color);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(9.5);
    doc.text(txt.toUpperCase(), x + 4.6, y);
  };
  const trunc = (t: string, n: number) => (t.length > n ? t.slice(0, n - 1) + "…" : t);

  // ---------- C. offre neuve (pleine largeur) ----------
  let y = 102;
  secTitle("Offre neuve — " + progKeys.length + " programme" + (progKeys.length > 1 ? "s" : "") + " · " + promoSet.size + " promoteur" + (promoSet.size > 1 ? "s" : ""), L, y);
  y += 5.5;
  const gx = [L, L + 56, L + 102, L + 126, L + 152, L + 180]; // Programme|Promoteur|EUR/m2|Des|Livraison|TVA
  doc.setFontSize(6.6);
  doc.setTextColor(BLEU);
  doc.setFont("helvetica", "bold");
  ["PROGRAMME", "PROMOTEUR", "€/M² MOYEN", "DÈS", "LIVRAISON", "TVA"].forEach((h, i) => doc.text(h, gx[i], y));
  doc.setDrawColor(BLEU);
  doc.setLineWidth(0.45);
  doc.line(L, y + 1.4, R, y + 1.4);
  y += 6;
  const top = progKeys.map((k) => {
    const ls = progs[k], p = ls[0];
    let sum = 0, n = 0, mn: number | null = null;
    for (const a of ls) {
      if (a.prix_m2) { sum += a.prix_m2; n++; }
      if (a.prix_total != null && (mn == null || a.prix_total < mn)) mn = a.prix_total;
    }
    return { nom: p.nom_programme || "Programme", promoteur: p.promoteur || "-", pm2: n ? Math.round(sum / n) : null, mn, livraison: p.date_livraison || "-", tva: p.tva || "-" };
  }).sort((a, b) => (a.pm2 || 1e9) - (b.pm2 || 1e9));
  const NPROG = 8;
  doc.setTextColor(ENCRE);
  for (const p of top.slice(0, NPROG)) {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(7.5);
    doc.text(trunc(p.nom, 33), gx[0], y);
    doc.setFont("helvetica", "normal");
    doc.text(trunc(p.promoteur, 26), gx[1], y);
    doc.text(p.pm2 != null ? eu(p.pm2) + " €" : "n/d", gx[2], y);
    doc.text(p.mn != null ? eu(Math.round(p.mn / 1000)) + " k€" : "n/d", gx[3], y);
    doc.text(trunc(p.livraison, 16), gx[4], y);
    doc.text(p.tva, gx[5], y);
    doc.setDrawColor("#e8ecf3");
    doc.setLineWidth(0.2);
    doc.line(L, y + 1.6, R, y + 1.6);
    y += 5.6;
  }
  if (!top.length) {
    doc.setFontSize(7.5);
    doc.setTextColor(GRIS);
    doc.text("Aucun programme neuf trouvé pour cette recherche.", L, y);
    y += 6;
  } else if (progKeys.length > NPROG) {
    doc.setFontSize(7);
    doc.setTextColor(GRIS);
    doc.text("… et " + (progKeys.length - NPROG) + " autres programmes sourcés", L, y);
    y += 5;
  }

  // ---------- D. loyers & rendement par typologie (pleine largeur) ----------
  y = Math.max(y + 6, 165);
  secTitle("Loyers & rendement par typologie", L, y);
  y += 5.5;
  const dx = [L, L + 28, L + 62, L + 96, L + 126, L + 156, L + 180];
  doc.setFontSize(6.6);
  doc.setTextColor(BLEU);
  doc.setFont("helvetica", "bold");
  ["TYPO", "LOYER NON MEUBLÉ", "LOYER MEUBLÉ", "LOYER/MOIS (NM)", "PRIX/M² NEUF", "RENDEMENT", "ANNONCES"].forEach((h, i) => doc.text(h, dx[i], y));
  doc.setDrawColor(BLEU);
  doc.setLineWidth(0.45);
  doc.line(L, y + 1.4, R, y + 1.4);
  y += 6;
  const orderT = ["T1", "T2", "T3", "T4", "T5", "T6", "GLOBAL"];
  doc.setTextColor(ENCRE);
  for (const t of orderT) {
    const l: Any = loc && (t === "GLOBAL" ? loc.global : loc.parTypologie && loc.parTypologie[t]);
    const n2: Any = nf && (t === "GLOBAL" ? nf.global : nf.parTypologie && nf.parTypologie[t]);
    const lmT: Any = lm && (t === "GLOBAL" ? lm.global : lm.parTypologie && lm.parTypologie[t]);
    if (!l && !n2) continue;
    const vNM = lmT ? lmT.non_meuble : (l ? l.prix_m2_cc_pondere : null);
    const vM = lmT ? lmT.meuble : null;
    const vN = n2 ? n2.prix_m2_cc_pondere : null;
    const r = (vNM != null && vN) ? vNM * 12 / vN * 100 : null;
    const mens = (vNM != null && l && l.surface_moyenne) ? Math.round(vNM * l.surface_moyenne) : null;
    const bold = t === "GLOBAL";
    doc.setFont("helvetica", bold ? "bold" : "normal");
    doc.setFontSize(7.6);
    doc.text(t === "GLOBAL" ? "Global" : t, dx[0], y);
    doc.text(vNM != null ? e1(vNM) + " €/m²" + (lmT && lmT.non_meuble_source === "estime" ? "*" : "") : "n/d", dx[1], y);
    doc.text(vM != null ? e1(vM) + " €/m²" + (lmT && lmT.meuble_source === "estime" ? "*" : "") : "n/d", dx[2], y);
    doc.text(mens != null ? eu(mens) + " €" : "n/d", dx[3], y);
    doc.text(vN != null ? eu(vN) + " €" : "n/d", dx[4], y);
    if (r != null) {
      doc.setTextColor(VERT);
      doc.setFont("helvetica", "bold");
      doc.text(e1(r) + " %", dx[5], y);
      doc.setTextColor(ENCRE);
      doc.setFont("helvetica", bold ? "bold" : "normal");
    } else doc.text("n/d", dx[5], y);
    doc.text(l ? String(l.nb_annonces) : "-", dx[6], y);
    doc.setDrawColor("#e8ecf3");
    doc.setLineWidth(0.2);
    doc.line(L, y + 1.6, R, y + 1.6);
    y += 5.6;
  }
  doc.setFontSize(6.3);
  doc.setTextColor(GRIS);
  doc.text("Loyers CC pondérés par surface · * = estimé par conversion (meublé = non meublé × 1,15) · rendement brut = loyer non meublé × 12 ÷ prix/m² neuf", L, y + 1.5);

  // ---------- E. INSEE + lecture marche (ancres bas de page) ----------
  const yB = 240;
  secTitle("Profil commune (INSEE)", L, yB);
  doc.setFillColor("#f3f7fc");
  doc.roundedRect(L, yB + 3.5, 110, 26, 2.5, 2.5, "F");
  const stats: Array<[string, string]> = [
    [insee.population != null ? eu(insee.population) : "n.c.", "POPULATION"],
    [insee.evolution != null ? (insee.evolution > 0 ? "+" : "") + e1(insee.evolution) + " %/an" : "n.c.", "ÉVOLUTION"],
    [insee.revenu != null ? eu(insee.revenu) + " €" : "n.c.", "REVENU MÉDIAN"],
    [insee.pct_prop != null ? e1(insee.pct_prop) + " %" : "n.c.", "PROPRIÉTAIRES"],
    [insee.pct_loc != null ? e1(insee.pct_loc) + " %" : "n.c.", "LOCATAIRES"],
    [insee.recents != null ? e1(insee.recents) + " %" : "n.c.", "LOGEMENTS RÉCENTS"],
  ];
  stats.forEach((st, i) => {
    const cx = L + 9.2 + (i % 3) * 36.7;
    const cy = yB + 12 + Math.floor(i / 3) * 11.5;
    doc.setTextColor(ENCRE);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(9);
    doc.text(st[0], cx + 9, cy, { align: "center" });
    doc.setTextColor(GRIS);
    doc.setFontSize(5);
    doc.text(st[1], cx + 9, cy + 3.6, { align: "center" });
  });
  const dxL2 = 128;
  secTitle("Lecture marché", dxL2, yB, VERT);
  const lect = lectureMarche(rdt, insee, progKeys.length);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(7.6);
  const lines = doc.splitTextToSize(lect, R - dxL2 - 9);
  doc.setFillColor("#e9f5f0");
  doc.roundedRect(dxL2, yB + 3.5, R - dxL2, 26, 2.5, 2.5, "F");
  doc.setFillColor(VERT);
  doc.rect(dxL2, yB + 3.5, 1.7, 26, "F");
  doc.setTextColor("#15473a");
  doc.text(lines, dxL2 + 5.2, yB + 9.5);

  // ---------- F. pied ----------
  doc.setDrawColor("#e0e6ef");
  doc.setLineWidth(0.3);
  doc.line(L, 285, R, 285);
  doc.setTextColor(GRIS);
  doc.setFontSize(6.3);
  doc.text("Sources : SeLoger & SeLoger Neuf (scraping du " + dateStr + ") · INSEE / geo.api.gouv.fr · Wikipedia", L, 290);
  doc.text("Document indicatif, non contractuel · Elizabeth Holding", R, 290, { align: "right" });

  return new Uint8Array(doc.output("arraybuffer") as ArrayBuffer);
}

// ----------------------------------------------------------------------------
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "POST uniquement" }), { status: 405, headers: { ...CORS, "Content-Type": "application/json" } });
  }
  let body: Any;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Body JSON invalide" }), { status: 400, headers: { ...CORS, "Content-Type": "application/json" } });
  }
  try {
    const ville = (body.loc && body.loc.ville) || (body.neuf && body.neuf.ville) || "";
    if (!ville) return new Response(JSON.stringify({ error: "donnees etude manquantes" }), { status: 400, headers: { ...CORS, "Content-Type": "application/json" } });
    const photo = await fetchVillePhoto(ville);
    const pdf = buildPdf(body, photo);
    console.log(`[fiche-pdf] ${ville} : ${pdf.length} octets, photo=${photo ? photo.fmt : "non"}`);
    return new Response(pdf.buffer as ArrayBuffer, {
      headers: {
        ...CORS,
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="Etude-${ville.replace(/\s+/g, "-")}.pdf"`,
      },
    });
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    console.error("[fiche-pdf]", detail);
    return new Response(JSON.stringify({ error: "Echec generation PDF", detail }), { status: 500, headers: { ...CORS, "Content-Type": "application/json" } });
  }
});
