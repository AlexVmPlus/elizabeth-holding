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

// --- Construction du PDF (1 page A4, 210 x 297 mm) ---------------------------
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
  const L = 12, R = 198; // marges

  // ---------- A. bandeau photo ----------
  if (photo) {
    try {
      doc.addImage(photo.b64, photo.fmt, 0, 0, W, 60, undefined, "FAST"); // deborde, recouvert ensuite
    } catch (e) {
      console.warn("addImage:", e instanceof Error ? e.message : e);
      photo = null;
    }
  }
  if (!photo) {
    doc.setFillColor(BLEU);
    doc.rect(0, 0, W, 36, "F");
    doc.setFillColor(BLEU_FONCE);
    doc.triangle(W, 0, W, 36, 90, 36, "F");
  }
  // masque sous le bandeau (la photo a ete dessinee plus haute que 36mm)
  doc.setFillColor("#ffffff");
  doc.rect(0, 36, W, 297 - 36, "F");
  // overlay sombre
  doc.saveGraphicsState();
  doc.setGState(new (doc as Any).GState({ opacity: 0.55 }));
  doc.setFillColor("#081a30");
  doc.rect(0, 0, W, 36, "F");
  doc.restoreGraphicsState();
  // logo + marque
  doc.setFillColor("#ffffff");
  doc.roundedRect(L, 6.5, 10, 10, 2, 2, "F");
  doc.setTextColor(BLEU);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(10);
  doc.text("EH", L + 5, 13, { align: "center" });
  doc.setTextColor("#ffffff");
  doc.setFontSize(7);
  doc.text("ELIZABETH HOLDING  ·  INTELLIGENCE IMMOBILIÈRE", L + 13, 12.5);
  // titre + date
  doc.setFontSize(17);
  doc.text(ville + (quartier ? " · " + quartier : "") + " — Synthèse de marché", L, 30);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  doc.text(dateStr, R, 30, { align: "right" });

  // ---------- B. 4 chiffres cles ----------
  const lG: Any = loc && loc.global, nG: Any = nf && nf.global;
  const loyerNM = lm && lm.global ? lm.global.non_meuble : (lG ? lG.prix_m2_cc_pondere : null);
  const loyerM = lm && lm.global ? lm.global.meuble : null;
  const prixM2 = nG ? nG.prix_m2_cc_pondere : null;
  const rdt = (loyerNM != null && prixM2) ? loyerNM * 12 / prixM2 * 100 : null;
  const lots: Any[] = (nf && nf.annonces) || [];
  let minPrix: number | null = null;
  for (const a of lots) if (a.prix_total != null && (minPrix == null || a.prix_total < minPrix)) minPrix = a.prix_total;

  const kpis: Array<[string, string]> = [
    [loyerNM != null ? e1(loyerNM) + " €/m²" : "n/d", "LOYER MOYEN NON MEUBLÉ"],
    [prixM2 != null ? eu(prixM2) + " €/m²" : "n/d", "PRIX NEUF MOYEN"],
    [rdt != null ? e1(rdt) + " %" : "n/d", "RENDEMENT BRUT MOYEN"],
    [minPrix != null ? Math.round(minPrix / 1000) + " k€" : "n/d", "PRIX D'ENTRÉE NEUF"],
  ];
  const kw = 44.25, kg = 3;
  kpis.forEach((k, i) => {
    const x = L + i * (kw + kg);
    doc.setFillColor("#f3f7fc");
    doc.roundedRect(x, 42, kw, 17, 2.5, 2.5, "F");
    doc.setTextColor(i === 2 ? VERT : BLEU);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(13);
    doc.text(k[0], x + kw / 2, 50, { align: "center" });
    doc.setTextColor(GRIS);
    doc.setFontSize(5.6);
    doc.text(k[1], x + kw / 2, 55.5, { align: "center" });
  });

  // helpers de sections / tables
  const secTitle = (txt: string, x: number, y: number, color = BLEU) => {
    doc.setTextColor(color);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(8.5);
    doc.text(txt.toUpperCase(), x, y);
  };
  const trunc = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

  // ---------- C. deux colonnes ----------
  const yCols = 68;
  // -- gauche : offre neuve
  const progs: Record<string, Any[]> = {};
  for (const a of lots) (progs[a.nom_programme || a.url || "?"] ||= []).push(a);
  const progKeys = Object.keys(progs);
  const promoSet = new Set<string>();
  for (const a of lots) if (a.promoteur) promoSet.add(a.promoteur);
  secTitle("Offre neuve · " + progKeys.length + " programme" + (progKeys.length > 1 ? "s" : "") + " · " + promoSet.size + " promoteur" + (promoSet.size > 1 ? "s" : ""), L, yCols);
  const gx = [L, L + 42, L + 76, L + 92]; // Programme | Promoteur | EUR/m2 | TVA
  let gy = yCols + 5;
  doc.setFontSize(6.3);
  doc.setTextColor(BLEU);
  ["PROGRAMME", "PROMOTEUR", "€/M²", "TVA"].forEach((h, i) => doc.text(h, gx[i], gy));
  doc.setDrawColor(BLEU);
  doc.setLineWidth(0.4);
  doc.line(L, gy + 1.2, L + 102, gy + 1.2);
  gy += 5;
  const top = progKeys.map((k) => {
    const ls = progs[k], p = ls[0];
    let sum = 0, n = 0;
    for (const a of ls) if (a.prix_m2) { sum += a.prix_m2; n++; }
    return { nom: p.nom_programme || "Programme", promoteur: p.promoteur || "-", pm2: n ? Math.round(sum / n) : null, tva: p.tva || "-" };
  }).sort((a, b) => (a.pm2 || 1e9) - (b.pm2 || 1e9));
  doc.setFont("helvetica", "normal");
  doc.setTextColor(ENCRE);
  for (const p of top.slice(0, 8)) {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(7);
    doc.text(trunc(p.nom, 26), gx[0], gy);
    doc.setFont("helvetica", "normal");
    doc.text(trunc(p.promoteur, 20), gx[1], gy);
    doc.text(p.pm2 != null ? eu(p.pm2) + " €" : "n/d", gx[2], gy);
    doc.text(p.tva, gx[3], gy);
    doc.setDrawColor("#e8ecf3");
    doc.setLineWidth(0.2);
    doc.line(L, gy + 1.4, L + 102, gy + 1.4);
    gy += 5.1;
  }
  if (!top.length) {
    doc.setFontSize(7);
    doc.setTextColor(GRIS);
    doc.text("Aucun programme neuf trouvé.", L, gy);
    gy += 5;
  } else if (progKeys.length > 8) {
    doc.setFontSize(6.5);
    doc.setTextColor(GRIS);
    doc.text("… et " + (progKeys.length - 8) + " autres programmes", L, gy);
    gy += 4;
  }

  // -- droite : loyers (NM / M) & rendement par typologie
  const dxL = 122;
  secTitle("Loyers & rendement", dxL, yCols);
  const dx = [dxL, dxL + 13, dxL + 31, dxL + 49, dxL + 65]; // Typo | NM | M | Neuf | Rdt
  let dy = yCols + 5;
  doc.setFontSize(6.3);
  doc.setTextColor(BLEU);
  ["TYPO", "NON MEUBLÉ", "MEUBLÉ", "€/M² NEUF", "RDT"].forEach((h, i) => doc.text(h, dx[i], dy));
  doc.setDrawColor(BLEU);
  doc.setLineWidth(0.4);
  doc.line(dxL, dy + 1.2, R, dy + 1.2);
  dy += 5;
  doc.setTextColor(ENCRE);
  const orderT = ["T1", "T2", "T3", "T4", "T5", "T6", "GLOBAL"];
  for (const t of orderT) {
    const l: Any = loc && (t === "GLOBAL" ? loc.global : loc.parTypologie && loc.parTypologie[t]);
    const n2: Any = nf && (t === "GLOBAL" ? nf.global : nf.parTypologie && nf.parTypologie[t]);
    const lmT: Any = lm && (t === "GLOBAL" ? lm.global : lm.parTypologie && lm.parTypologie[t]);
    if (!l && !n2) continue;
    const vNM = lmT ? lmT.non_meuble : (l ? l.prix_m2_cc_pondere : null);
    const vM = lmT ? lmT.meuble : null;
    const vN = n2 ? n2.prix_m2_cc_pondere : null;
    const r = (vNM != null && vN) ? vNM * 12 / vN * 100 : null;
    const bold = t === "GLOBAL";
    doc.setFont("helvetica", bold ? "bold" : "normal");
    doc.setFontSize(7);
    doc.text(t === "GLOBAL" ? "Global" : t, dx[0], dy);
    doc.text(vNM != null ? e1(vNM) + " €" + (lmT && lmT.non_meuble_source === "estime" ? "*" : "") : "n/d", dx[1], dy);
    doc.text(vM != null ? e1(vM) + " €" + (lmT && lmT.meuble_source === "estime" ? "*" : "") : "n/d", dx[2], dy);
    doc.text(vN != null ? eu(vN) + " €" : "n/d", dx[3], dy);
    if (r != null) {
      doc.setTextColor(VERT);
      doc.text(e1(r) + " %", dx[4], dy);
      doc.setTextColor(ENCRE);
    } else doc.text("n/d", dx[4], dy);
    doc.setDrawColor("#e8ecf3");
    doc.setLineWidth(0.2);
    doc.line(dxL, dy + 1.4, R, dy + 1.4);
    dy += 5.1;
  }
  doc.setFontSize(6);
  doc.setTextColor(GRIS);
  doc.text("Loyers CC pondérés par surface · * = estimé (meublé = non meublé × 1,15)", dxL, dy + 1);
  doc.text("Rendement brut = loyer non meublé × 12 ÷ prix/m² neuf", dxL, dy + 4.2);

  // ---------- D. INSEE + lecture marche ----------
  const yB = Math.max(gy, dy) + 12;
  secTitle("Profil commune (INSEE)", L, yB);
  doc.setFillColor("#f3f7fc");
  doc.roundedRect(L, yB + 3, 102, 19, 2.5, 2.5, "F");
  const stats: Array<[string, string]> = [
    [insee.population != null ? eu(insee.population) : "n.c.", "POPULATION"],
    [insee.revenu != null ? eu(insee.revenu) + " €" : "n.c.", "REVENU MÉDIAN"],
    [insee.pct_prop != null ? e1(insee.pct_prop) + " %" : "n.c.", "PROPRIÉTAIRES"],
    [insee.pct_loc != null ? e1(insee.pct_loc) + " %" : "n.c.", "LOCATAIRES"],
  ];
  stats.forEach((st, i) => {
    const cx = L + 12.75 + i * 25.5;
    doc.setTextColor(ENCRE);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(9);
    doc.text(st[0], cx, yB + 12, { align: "center" });
    doc.setTextColor(GRIS);
    doc.setFontSize(5.2);
    doc.text(st[1], cx, yB + 17, { align: "center" });
  });
  secTitle("Lecture marché", dxL, yB, VERT);
  const lect = lectureMarche(rdt, insee, progKeys.length);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(7.2);
  const lines = doc.splitTextToSize(lect, R - dxL - 8);
  const lh = Math.max(19, lines.length * 3.6 + 7);
  doc.setFillColor("#e9f5f0");
  doc.roundedRect(dxL, yB + 3, R - dxL, lh, 2.5, 2.5, "F");
  doc.setFillColor(VERT);
  doc.rect(dxL, yB + 3, 1.6, lh, "F");
  doc.setTextColor("#15473a");
  doc.text(lines, dxL + 5, yB + 9);

  // ---------- E. pied de page ----------
  doc.setDrawColor("#e0e6ef");
  doc.setLineWidth(0.3);
  doc.line(L, 284, R, 284);
  doc.setTextColor(GRIS);
  doc.setFontSize(6);
  doc.text("Sources : SeLoger & SeLoger Neuf (scraping du " + dateStr + ") · INSEE / geo.api.gouv.fr · Wikipedia", L, 289);
  doc.text("Document indicatif, non contractuel · Elizabeth Holding", R, 289, { align: "right" });

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
