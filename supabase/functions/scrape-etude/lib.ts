// ============================================================================
// Logique pure (testable) de la fonction scrape-etude — source : FIRECRAWL.
// Parsing du markdown SeLoger -> annonces, calculs prix/m2, typologie,
// filtres (typologie / neuf / annee best-effort) et synthese ponderee.
// Aucune dependance reseau ici -> testable hors ligne via `deno test`.
// ============================================================================

export type Transaction = "location" | "vente";

// Classe de caracteres "espace de nombre" : espace, NBSP, narrow-NBSP.
// (SeLoger ecrit "1 250 €" avec ces espaces insecables.)
const SP = "\\u00A0\\u202F ";

export const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "string" ? parseFloat(v.replace(/\s/g, "").replace(",", ".")) : (v as number);
  return typeof n === "number" && isFinite(n) ? n : null;
};

export const round = (x: number, d = 2): number => {
  const f = Math.pow(10, d);
  return Math.round(x * f) / f;
};

// Typologie T1..T6 a partir du nombre de pieces (T6 = 6 pieces et plus).
export function typologie(pieces: number | null): string | null {
  if (!pieces || pieces < 1) return null;
  return "T" + Math.min(Math.round(pieces), 6);
}

// ----------------------------------------------------------------------------
// Code lieu SeLoger a partir du code INSEE (citycode renvoye par api-adresse).
// SeLoger insere un "0" APRES le code departement (2 chiffres) de l'INSEE.
// Confirme par tests : Bordeaux 33063 -> 330063 ; Lyon 69123 -> 690123.
// (NB : different d'un simple "ajouter un 0 a la fin" qui donnerait 330630.)
// ----------------------------------------------------------------------------
export function selogerCode(citycode: string | number | null | undefined): number | null {
  if (citycode == null) return null;
  const c = String(citycode).trim();
  const m = /^(\d{2})(\d{3})$/.exec(c); // metropole : DD + CCC
  if (m) return Number(m[1] + "0" + m[2]);
  return null; // Corse (2A/2B) / DOM (dept 3 chiffres) non geres -> resolution echoue
}

// ----------------------------------------------------------------------------
// URL de recherche SeLoger (format list.htm, confirme par tests Firecrawl).
// projects=1 location / 2 vente ; types=2,1 = appartement + maison.
// Pagination : &LISTING-LISTpg=<page> (25 annonces par page).
// ----------------------------------------------------------------------------
export function buildListUrl(seloCode: number, transaction: Transaction, page = 1): string {
  const projects = transaction === "vente" ? "2" : "1";
  const places = encodeURIComponent(JSON.stringify([{ inseeCodes: [seloCode] }]));
  let url = `https://www.seloger.com/list.htm?projects=${projects}&types=2,1` +
    `&places=${places}&enterprise=0&qsVersion=1.0`;
  if (page > 1) url += `&LISTING-LISTpg=${page}`;
  return url;
}

// ----------------------------------------------------------------------------
// URL classified-search : format moderne SeLoger. SEUL format qui applique un
// VRAI filtre annee de construction (yearOfConstructionMin) ET dont la
// pagination fonctionne via Firecrawl (&page=N : 0 doublon teste entre pages,
// la ou list.htm&LISTING-LISTpg=2 renvoie ~80% de doublons). Necessite un code
// lieu AD..FR.. (resolu via la page SEO de la ville, cf. index.ts).
// Valide le 12/06/2026 : Bordeaux AD08FR13100 sans filtre 1819 annonces,
// >=2020 -> 64, >=2025 -> 28 ; Lyon AD08FR28808 >=2020 -> 83, >=2025 -> 28.
// ----------------------------------------------------------------------------
export function buildClassifiedUrl(code: string, transaction: Transaction, anneeMin: number | null, page = 1): string {
  const dist = transaction === "vente" ? "Buy" : "Rent";
  let url = `https://www.seloger.com/classified-search?distributionTypes=${dist}` +
    `&estateTypes=Apartment,House&locations=${encodeURIComponent(code)}`;
  if (anneeMin) url += `&yearOfConstructionMin=${anneeMin}`;
  if (page > 1) url += `&page=${page}`;
  return url;
}

// Extrait un code lieu classified-search (format AD<digits>FR<alnum>) d'un
// texte/JSON (reponse autocomplete). Renvoie le 1er trouve, ou null.
export function extractClassifiedCode(text: string): string | null {
  if (!text) return null;
  const m = text.match(/AD\d+FR[A-Za-z0-9]+/);
  return m ? m[0] : null;
}

// Slug SeLoger d'un nom de ville : minuscules, accents retires, tout caractere
// non alphanumerique -> tiret ("L'Haÿ-les-Roses" -> "l-hay-les-roses").
export function villeSlug(ville: string): string {
  return ville
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Page SEO "immobilier/locations/immo-<slug>-<dept>/" : se charge via
// Firecrawl (pas de blocage DataDome constate) et embarque ~100 fois le code
// lieu AD08FR.. de la ville dans son JSON. C'est notre source de resolution
// des codes classified-search (l'autocomplete moderne est elle bloquee :
// HTTP 403 DataDome en direct, 404 via Firecrawl).
export function seoLocationUrl(ville: string, dept: string): string {
  return `https://www.seloger.com/immobilier/locations/immo-${villeSlug(ville)}-${dept}/`;
}

// Code lieu VILLE (prefixe AD08FR) le plus frequent dans le HTML d'une page
// SeLoger : le code de la ville de la page apparait dans chaque lien d'annonce
// (~100x), les codes parents (region/departement) ~30x, les voisins 1-3x.
export function extractCityCode(html: string): string | null {
  if (!html) return null;
  const counts = new Map<string, number>();
  for (const m of html.matchAll(/AD08FR[A-Za-z0-9]+/g)) {
    counts.set(m[0], (counts.get(m[0]) || 0) + 1);
  }
  let best: string | null = null;
  let bestN = 0;
  for (const [code, n] of counts) {
    if (n > bestN) {
      best = code;
      bestN = n;
    }
  }
  // Au moins quelques occurrences, sinon code douteux (page vide/erreur).
  return bestN >= 3 ? best : null;
}

// Une page classified-search avec peu de resultats exacts est completee par
// une section "Plus d'annonces à proximité" (autres villes !) : on coupe le
// markdown a ce marqueur pour ne parser que les resultats exacts.
export function cutProximity(markdown: string): string {
  const i = (markdown || "").indexOf("Plus d'annonces à proximité");
  return i >= 0 ? markdown.slice(0, i) : (markdown || "");
}

// ----------------------------------------------------------------------------
// SeLoger NEUF (selogerneuf.com) — programmes neufs promoteurs ("vente_neuf").
// Valide le 12/06/2026 via Firecrawl : liste + detail se chargent (waitFor
// 6000), la page detail expose nom / "Propose par <promoteur>" / adresse /
// livraison / lots avec prix, "Soit X €/m²" et surface.
// ----------------------------------------------------------------------------

// Liste des programmes d'une ville : /immobilier/neuf/immo-<slug>-<dept>/bien-programme/
// Pagination en suffixe de chemin : .../bien-programme/2/
export function neufListUrl(ville: string, dept: string, page = 1): string {
  const base = `https://www.selogerneuf.com/immobilier/neuf/immo-${villeSlug(ville)}-${dept}/bien-programme/`;
  return page > 1 ? `${base}${page}/` : base;
}

// Liens programmes d'une page liste neuf. Format :
//   /annonces/neuf/programme/<ville>-<dpt>/<id>/  (+ variantes #fragment)
// On retire fragment/query et on dedoublonne. La liste d'une ville inclut des
// communes voisines (ex Bruges dans la liste Bordeaux) : si `slug` est fourni,
// on ne garde que les programmes de la ville demandee — sauf si cela vide tout
// (petites communes), auquel cas on garde tous les liens.
export function neufProgramLinks(links: unknown, slug?: string | null): string[] {
  if (!Array.isArray(links)) return [];
  const urls = links
    .map((l) => {
      if (typeof l === "string") return l;
      if (l && typeof l === "object" && "url" in l) return String((l as { url: unknown }).url);
      return "";
    })
    .filter((u) => /\/annonces\/neuf\/programme\//.test(u))
    .map((u) => u.split("#")[0].split("?")[0]);
  const all = [...new Set(urls)];
  if (!slug) return all;
  const ville = all.filter((u) => u.includes(`/programme/${slug}-`));
  return ville.length ? ville : all;
}

export interface NeufUnit {
  pieces: number | null;
  prix: number;
  prix_m2: number;
  surface: number | null;
}

// Lots d'une page detail programme. Chaque lot s'ecrit (markdown Firecrawl) :
//   - Studio | Appartement2 pièces
//     141 100 €
//     Soit 7 521 €/m²
//     19 m²
// On ancre sur "Soit X €/m²" (propre aux lots) : prix = dernier montant €
// AVANT l'ancre, pieces = derniere mention Studio/"N pièces" avant, surface =
// premier "Y m²" apres. Les entetes de groupe "De X € à Y €" ne genent pas
// (le dernier € avant "Soit" est toujours le prix du lot).
export function parseNeufUnits(markdown: string): NeufUnit[] {
  const md = (markdown || "").replace(new RegExp(`[${SP}]`, "g"), " ");
  const out: NeufUnit[] = [];
  const anchor = /Soit\s*([\d ]{3,12})\s*€\/m²/g;
  let m: RegExpExecArray | null;
  while ((m = anchor.exec(md)) !== null) {
    const prix_m2 = parseInt(m[1].replace(/ /g, ""), 10);
    const back = md.slice(Math.max(0, m.index - 240), m.index);
    let prix: number | null = null;
    for (const p of back.matchAll(/(\d[\d ]{2,12})\s*€(?!\/m)/g)) {
      prix = parseInt(p[1].replace(/ /g, ""), 10);
    }
    let pieces: number | null = null;
    for (const p of back.matchAll(/studio|(\d+)\s*pi[eè]ces?/gi)) {
      pieces = p[1] ? parseInt(p[1], 10) : 1;
    }
    const fwd = md.slice(anchor.lastIndex, anchor.lastIndex + 130);
    const s = fwd.match(/(\d{1,4}(?:[.,]\d{1,2})?)\s*m²/);
    const surface = s ? parseFloat(s[1].replace(",", ".")) : null;
    if (prix != null && prix > 0 && isFinite(prix_m2) && prix_m2 > 0) {
      out.push({ pieces, prix, prix_m2, surface: surface != null && surface >= 8 ? surface : null });
    }
  }
  return out;
}

export interface NeufMeta {
  nom: string | null;
  promoteur: string | null;
  adresse: string | null;
  livraison: string | null;
}

// Metadonnees d'une page detail programme.
export function parseNeufMeta(markdown: string): NeufMeta {
  const md = markdown || "";
  // retire les echappements markdown de Firecrawl ("KLEEZI \| THIERS" -> "KLEEZI | THIERS")
  const nom = md.match(/^#\s+(.+)$/m)?.[1]?.replace(/\\(.)/g, "$1").trim() || null;
  // "Proposé par Marignan, mis à jour le ..." (haut de page) puis fallbacks.
  const promoteur =
    md.match(/Proposé par\s+([^,\n\]]{2,60}?)\s*,\s*mis à jour/i)?.[1]?.trim() ||
    md.match(/vous est proposé par\s*\n+\[([^\]]{2,60})\]/i)?.[1]?.trim() ||
    md.match(/Proposé par\s+([^\n\]]{2,60})/i)?.[1]?.trim() || null;
  // 1ere ligne "..., 33000 Bordeaux" (sous le titre, repetee dans Le Quartier).
  const adresse = md.match(/^([^\n#![\]]{3,90},\s*\d{5}\s+[^\n,]{2,40})\s*$/m)?.[1]?.trim() || null;
  const livraison = md.match(/Livraison\s*\n+\s*([^\n]{3,60})/i)?.[1]?.trim() || null;
  return { nom, promoteur, adresse, livraison };
}

// Garde-fou neuf : prix/m² promoteur plausible en France (2 500 - 15 000 €/m²).
export function isPlausibleNeuf(prix_m2: number | null): boolean {
  return prix_m2 != null && prix_m2 >= 2500 && prix_m2 <= 15000;
}

// ----------------------------------------------------------------------------
// Parsing d'un bloc de texte (markdown) -> champs d'une annonce.
// ----------------------------------------------------------------------------

// Loyer CC (ou prix) : "929 €", "1 250 €" -> 929 / 1250 (espaces retires).
export function parseLoyer(text: string): number | null {
  if (!text) return null;
  const m = text.match(new RegExp(`(\\d[\\d${SP}]{0,8})\\s*€`));
  if (!m) return null;
  const n = parseInt(m[1].replace(new RegExp(`[${SP}]`, "g"), ""), 10);
  return isFinite(n) && n > 0 ? n : null;
}

// Surface HABITABLE : "53 m²", "53m2" -> 53 ; decimales FR "160,2 m²" -> 160.2.
// Priorite au format des titres SeLoger "3 pièces, 2 chambres, 64,5 m²" (surface
// habitable sure), sinon 1ere surface du bloc qui n'est PAS du terrain/jardin
// (les descriptions citent parfois une chambre de 9 m² ou un balcon avant la
// vraie surface -> c'etait la source des surfaces aberrantes).
export function parseSurface(text: string): number | null {
  if (!text) return null;
  let m: RegExpMatchArray | null =
    text.match(/pi[eè]ces?,(?:\s*\d+\s*chambres?,)?\s*(\d{1,4}(?:[.,]\d{1,2})?)\s*m(?:²|2)/i);
  if (!m) {
    for (const c of text.matchAll(/(\d{1,4}(?:[.,]\d{1,2})?)\s*m(?:²|2)(?!\s*de\s*(?:terrain|jardin))/gi)) {
      m = c;
      break;
    }
  }
  if (!m) return null;
  const n = parseFloat(m[1].replace(",", "."));
  return isFinite(n) && n > 0 ? n : null;
}

// Colocation : fausse les stats (loyer d'UNE chambre rapporte a la surface du
// logement entier, ex 620 € / 128 m² = 4,8 €/m²). Detection titre + URL.
export function isColocation(titre: string | null | undefined, url: string | null | undefined): boolean {
  return /coloc/i.test(titre || "") || /colocation/i.test(url || "");
}

// Garde-fou stats : surface < 9 m² (minimum legal de location en France) =
// parsing rate ; en location, prix/m2 CC hors [5, 60] €/m² = aberration
// (colocation residuelle, surface fausse...). Jamais dans la synthese.
export function isPlausible(surface: number | null, prix_m2_cc: number | null, transaction: Transaction): boolean {
  if (surface == null || surface < 9) return false;
  if (transaction === "location" && prix_m2_cc != null && (prix_m2_cc < 5 || prix_m2_cc > 60)) return false;
  return true;
}

// Pieces : "2 pièces" -> 2 ; "Studio"/"T1"/"F1" -> 1 ; "T3" -> 3.
export function parsePieces(text: string): number | null {
  if (!text) return null;
  const t = text.toLowerCase();
  if (/studio/.test(t)) return 1;
  let m = t.match(/(\d+)\s*pi[eè]ce/);
  if (m) return parseInt(m[1], 10);
  m = t.match(/\b[tf]\s?(\d)\b/); // T2 / F2 (notation pieces)
  if (m) return parseInt(m[1], 10);
  return null;
}

// Charges mensuelles (page detail SeLoger). Gere les formulations FR courantes :
//  - "dont 80 € de charges", "80 € de charges"          (montant AVANT "charges")
//  - "charges : 80 €", "charges 80 €/mois",
//    "provision pour charges 80 €"                        (montant APRES "charges")
// IMPORTANT : ne PAS confondre avec "charges comprises 929 €" (929 = loyer, pas
// les charges) -> on n'autorise que des espaces/":" entre "charges" et le montant.
const NUM_RE = `(\\d[\\d${SP}]{0,6})`;
export function parseCharges(text: string): number | null {
  if (!text) return null;
  // 0. "Charges forfaitaires 50 €/mois" -> motif PRINCIPAL valide sur SeLoger
  let m = text.match(new RegExp(`charges\\s+forfaitaires?\\s*:?\\s*${NUM_RE}\\s*€`, "i"));
  // 1. "... 95 € de charges" / "dont 95 € de charges" (montant AVANT, avec "de")
  if (!m) m = text.match(new RegExp(`${NUM_RE}\\s*€\\s*de\\s+charges`, "i"));
  // 2. "charges (:) 80 €" / "provision pour charges 80 €" (montant APRES) —
  //    mais PAS "hors/sans charges 760 €" (760 = loyer HC, pas les charges).
  if (!m) {
    m = text.match(new RegExp(`(?<!hors[ ${SP}])(?<!sans[ ${SP}])charges\\s*:?\\s*${NUM_RE}\\s*€`, "i"));
  }
  if (!m) return null;
  const n = parseInt(m[1].replace(new RegExp(`[${SP}]`, "g"), ""), 10);
  return isFinite(n) && n > 0 ? n : null;
}

// Resultat d'UNE page detail (phase "detail") : charges + loyer_hc + prix/m2.
// charges introuvable -> null (l'annonce reste exploitable en CC).
export function detailResult(loyerCc: number | null, surface: number | null, markdown: string) {
  const charges = parseCharges(markdown);
  const prix_m2_cc = (loyerCc != null && surface != null && surface > 0) ? round(loyerCc / surface) : null;
  let loyer_hc: number | null = null;
  let prix_m2_hc: number | null = null;
  if (charges != null && loyerCc != null && surface != null && surface > 0 && charges < loyerCc) {
    loyer_hc = round(loyerCc - charges);
    prix_m2_hc = round(loyer_hc / surface);
  }
  return { charges, loyer_hc, prix_m2_cc, prix_m2_hc };
}

// Fusionne les annonces partielles (loyer_cc/surface...) avec les markdowns
// detail pour en extraire les charges -> loyer_hc / prix_m2_hc.
// Sans charges trouvees : charges/loyer_hc/prix_m2_hc restent null (stats CC OK).
// deno-lint-ignore no-explicit-any
export function mergeCharges(partielles: any[], markdowns: Array<string | null | undefined>): any[] {
  return partielles.map((a, i) => {
    const charges = parseCharges(markdowns[i] || "");
    if (charges != null && a.loyer_cc != null && a.surface > 0 && charges < a.loyer_cc) {
      const loyer_hc = round(a.loyer_cc - charges);
      return { ...a, charges, loyer_hc, prix_m2_hc: round(loyer_hc / a.surface) };
    }
    return { ...a, charges: null, loyer_hc: null, prix_m2_hc: null };
  });
}

export interface RawAnnonce {
  url: string | null;
  titre: string | null;
  loyer: number | null;
  surface: number | null;
  pieces: number | null;
}

// Nettoie une URL capturee depuis le markdown : un lien markdown peut s'ecrire
// `(url "titre")` -> le groupe capture inclut alors ` "titre"`. Une vraie URL ne
// contient jamais d'espace brut, donc on coupe au 1er espace (retire le titre et
// d'eventuels guillemets/parentheses residuels). Indispensable pour que le lien
// "Voir" pointe vers une URL valide (sinon href casse par l'espace + guillemets).
export function cleanUrl(u: string | null | undefined): string | null {
  if (!u) return null;
  const s = String(u).trim().split(/\s/)[0].replace(/["')\]]+$/, "");
  return s || null;
}

// URLs d'annonces depuis le tableau `links` de Firecrawl (filtre /annonces/).
export function annonceLinks(links: unknown): string[] {
  if (!Array.isArray(links)) return [];
  const urls = links
    .map((l) => {
      if (typeof l === "string") return l;
      if (l && typeof l === "object" && "url" in l) return String((l as { url: unknown }).url);
      return "";
    })
    .filter((u) => /\/annonces\//.test(u));
  return [...new Set(urls)];
}

// ----------------------------------------------------------------------------
// Parse le markdown Firecrawl d'une page liste -> annonces.
//  - Strategie 1 : decoupe sur les liens /annonces/ inline (un bloc par annonce).
//  - Strategie 2 (fallback) : decoupe sur les prix et zippe avec links[].
// On ne garde que les annonces avec loyer + surface, dedoublonnees par url.
// ----------------------------------------------------------------------------
export function parseAnnonces(markdown: string, links: unknown): RawAnnonce[] {
  const md = markdown || "";
  const out: RawAnnonce[] = [];

  const linkRe = /\[([^\]]*)\]\((https?:\/\/[^)]*\/annonces\/[^)]+)\)/g;
  const anchors: { title: string; url: string; idx: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(md)) !== null) {
    anchors.push({ title: m[1].trim(), url: cleanUrl(m[2]) || m[2].trim(), idx: m.index });
  }

  if (anchors.length) {
    for (let i = 0; i < anchors.length; i++) {
      const a = anchors[i];
      const end = i + 1 < anchors.length ? anchors[i + 1].idx : md.length;
      const block = md.slice(a.idx, end);
      out.push({
        url: a.url,
        titre: a.title || null,
        loyer: parseLoyer(block),
        surface: parseSurface(block),
        pieces: parsePieces(block) ?? parsePieces(a.title),
      });
    }
  } else {
    // Fallback : aucun lien inline -> zip prix(markdown) avec links[].
    const urls = annonceLinks(links);
    const idxs: number[] = [];
    const priceRe = new RegExp(`(\\d[\\d${SP}]{0,8})\\s*€`, "g");
    let pm: RegExpExecArray | null;
    while ((pm = priceRe.exec(md)) !== null) idxs.push(pm.index);
    for (let i = 0; i < idxs.length; i++) {
      const block = md.slice(idxs[i], i + 1 < idxs.length ? idxs[i + 1] : md.length);
      out.push({
        url: cleanUrl(urls[i]),
        titre: null,
        loyer: parseLoyer(block),
        surface: parseSurface(block),
        pieces: parsePieces(block),
      });
    }
  }

  const seen = new Set<string>();
  return out
    .filter((a) => a.loyer != null && a.surface != null)
    .filter((a) => {
      if (!a.url) return true;
      if (seen.has(a.url)) return false;
      seen.add(a.url);
      return true;
    });
}

// ----------------------------------------------------------------------------
// Annonce parsee -> ligne `etudes_marche` (avec calculs prix/m2). null si KO.
// ----------------------------------------------------------------------------
export interface Row {
  ville: string;
  quartier: string | null;
  code_postal: string | null;
  transaction: Transaction;
  nb_pieces: number | null;
  typologie: string | null;
  surface: number;
  loyer_cc: number | null;
  charges: number | null;
  loyer_hc: number | null;
  prix_m2_cc: number | null;
  prix_m2_hc: number | null;
  url: string | null;
  source: string;
  titre: string | null;
  scraped_at: string;
}

export interface RowCtx {
  ville: string;
  quartier: string | null;
  code_postal: string | null;
  transaction: Transaction;
  scrapedAt: string;
  charges?: number | null; // optionnel (rempli si scrape detail)
}

export function annonceToRow(a: RawAnnonce, ctx: RowCtx): Row | null {
  if (a.surface == null || a.surface <= 0) return null;
  if (a.loyer == null || a.loyer <= 0) return null;
  const isLoc = ctx.transaction === "location";
  const charges = ctx.charges ?? null;
  const loyer_cc = isLoc ? a.loyer : null;
  const loyer_hc = isLoc && charges != null && charges < a.loyer ? round(a.loyer - charges) : null;
  const prix_m2_cc = round(a.loyer / a.surface);
  const prix_m2_hc = isLoc
    ? (loyer_hc != null ? round(loyer_hc / a.surface) : null)
    : prix_m2_cc; // vente : pas de notion CC/HC -> identique
  return {
    ville: ctx.ville,
    quartier: ctx.quartier,
    code_postal: ctx.code_postal,
    transaction: ctx.transaction,
    nb_pieces: a.pieces,
    typologie: typologie(a.pieces),
    surface: a.surface,
    loyer_cc,
    charges: isLoc ? charges : null,
    loyer_hc,
    prix_m2_cc,
    prix_m2_hc,
    url: a.url,
    source: "firecrawl",
    titre: a.titre,
    scraped_at: ctx.scrapedAt,
  };
}

// ----------------------------------------------------------------------------
// Filtres post-recuperation.
// ----------------------------------------------------------------------------

// Typologie : "T1".."T6" ou null/"" = toutes.
export function matchesTypologie(pieces: number | null, typo: string | null | undefined): boolean {
  if (!typo) return true;
  return typologie(pieces) === typo;
}

// Neuf : best-effort sur le titre (la liste n'expose pas toujours l'info).
export function matchesNeuf(titre: string | null | undefined): boolean {
  return /(neuf|neuve|r[ée]cent)/i.test(titre || "");
}

// Annee : best-effort sur le titre — neuf/recent OU une annee >= anneeMin.
export function matchesAnnee(titre: string | null | undefined, anneeMin: number | null | undefined): boolean {
  if (!anneeMin) return true;
  const t = titre || "";
  if (matchesNeuf(t)) return true;
  const years = t.match(/\b(?:19|20)\d{2}\b/g);
  return !!(years && years.some((y) => parseInt(y, 10) >= anneeMin));
}

// ----------------------------------------------------------------------------
// Synthese : prix/m2 PONDERE PAR SURFACE, par typologie T1..T6 + global.
// Accepte tout objet ayant les champs de stats (Row ou annonce fusionnee).
// ----------------------------------------------------------------------------
export interface StatRow {
  surface: number;
  typologie: string | null;
  loyer_cc: number | null;
  loyer_hc: number | null;
  prix_m2_cc: number | null;
  prix_m2_hc: number | null;
}

export function synthesize(rows: StatRow[], transaction: Transaction) {
  const calc = (arr: StatRow[]) => {
    const n = arr.length;
    if (!n) return null;
    let sumSurf = 0;
    let sumCC = 0, sumSurfCC = 0;
    let sumHC = 0, sumSurfHC = 0;
    let sumPm2CC = 0, nPm2CC = 0;
    let sumPm2HC = 0, nPm2HC = 0;
    for (const r of arr) {
      sumSurf += r.surface;
      const ccVal = transaction === "location" ? r.loyer_cc : (r.prix_m2_cc != null ? r.prix_m2_cc * r.surface : null);
      if (ccVal != null) {
        sumCC += ccVal;
        sumSurfCC += r.surface;
      }
      const hcVal = transaction === "location" ? r.loyer_hc : (r.prix_m2_cc != null ? r.prix_m2_cc * r.surface : null);
      if (hcVal != null) {
        sumHC += hcVal;
        sumSurfHC += r.surface;
      }
      if (r.prix_m2_cc != null) {
        sumPm2CC += r.prix_m2_cc;
        nPm2CC++;
      }
      if (r.prix_m2_hc != null) {
        sumPm2HC += r.prix_m2_hc;
        nPm2HC++;
      }
    }
    return {
      nb_annonces: n,
      surface_moyenne: round(sumSurf / n, 1),
      prix_m2_cc_pondere: sumSurfCC > 0 ? round(sumCC / sumSurfCC) : null,
      prix_m2_hc_pondere: sumSurfHC > 0 ? round(sumHC / sumSurfHC) : null,
      prix_m2_cc_moyen: nPm2CC > 0 ? round(sumPm2CC / nPm2CC) : null,
      prix_m2_hc_moyen: nPm2HC > 0 ? round(sumPm2HC / nPm2HC) : null,
      nb_avec_hc: nPm2HC,
    };
  };

  const groups: Record<string, StatRow[]> = {};
  for (const r of rows) (groups[r.typologie || "?"] ||= []).push(r);

  const parTypologie: Record<string, ReturnType<typeof calc>> = {};
  for (const t of ["T1", "T2", "T3", "T4", "T5", "T6"]) {
    if (groups[t]) parTypologie[t] = calc(groups[t]);
  }
  if (groups["?"]) parTypologie["autre"] = calc(groups["?"]);

  return { parTypologie, global: calc(rows) };
}
