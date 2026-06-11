// ============================================================================
// Logique pure (testable) de la fonction scrape-etude :
// nettoyage des annonces, calculs de prix, typologie, URL SeLoger, synthese.
// Aucune dependance reseau ici -> testable hors ligne via deno test.
// ============================================================================

// Annonces atypiques a exclure (detectees via le titre)
export const ATYPIQUE =
  /(coloc|colocation|chambre de service|chambre de bonne|chambre meubl|chambre a louer|chambre étudiant|chambre etudiant|chambre individuelle)/i;

export const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "string" ? parseFloat(v.replace(/\s/g, "").replace(",", ".")) : (v as number);
  return typeof n === "number" && isFinite(n) ? n : null;
};

export const round = (x: number, d = 2): number => {
  const f = Math.pow(10, d);
  return Math.round(x * f) / f;
};

export function typologie(rooms: number | null): string | null {
  if (!rooms || rooms < 1) return null;
  return "T" + Math.min(Math.round(rooms), 6);
}

// Extrait la lettre DPE (A..G) depuis energyBalance, qui peut etre une chaine
// ("C"), un objet ({letter|value|grade|label|...: "C"}) ou un objet vide ({}).
export function dpeLetter(v: unknown): string | null {
  if (!v) return null;
  if (typeof v === "string") return v.trim().toUpperCase() || null;
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    const cand = o.letter ?? o.value ?? o.grade ?? o.label ?? o.energyClass ?? o.classe ?? o.dpe;
    if (typeof cand === "string" && cand.trim()) return cand.trim().toUpperCase();
    if (typeof cand === "number") return String(cand);
  }
  return null;
}

export interface GeoInfo {
  insee: string;
  nom: string;
  lat: number | null;
  lng: number | null;
  codePostal: string | null;
}

export type Transaction = "location" | "vente";

export interface UrlFilters {
  rooms?: string | null; // valeur du param SeLoger `rooms` (ex "2" ou "6,7,8,9,10")
}

// Param SeLoger `rooms` pour une typologie T1..T6 (T6 = 6 pieces et plus).
export function roomsParam(typo: string | null | undefined): string | null {
  if (!typo) return null;
  const m = /^T([1-6])$/.exec(typo);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 6 ? "6,7,8,9,10" : String(n);
}

// --- Construit l'URL de recherche SeLoger filtree neuf ----------------------
// `ci` = code place SeLoger (6 chiffres, ex Bordeaux 330063), resolu via
// l'autocomplete SeLoger. Doit etre un NOMBRE dans le parametre places.
// Filtre typologie via le param list.htm confirme `rooms`.
export function buildSearchUrl(
  ci: string | number,
  transaction: Transaction,
  natures: string,
  filters: UrlFilters = {},
): string {
  const dist = transaction === "vente" ? "Buy" : "Rent";
  const projects = transaction === "vente" ? "2" : "1";
  const places = encodeURIComponent(JSON.stringify([{ inseeCodes: [Number(ci)] }]));
  // types=1,2 : appartement + maison ; natures=1,2 : neuf + ancien
  // Format confirme cote API Apify (pas de parametre sort).
  let url = `https://www.seloger.com/list.htm?projects=${projects}&types=1,2` +
    `&natures=${natures}&places=${places}&distributionTypes=${dist}` +
    `&enterprise=0&qsVersion=1.0`;
  if (filters.rooms) url += `&rooms=${filters.rooms}`;
  return url;
}

// Extrait le montant MENSUEL des charges d'une annonce de location.
// SeLoger expose les charges dans l'objet `alur` (alur.flatRateCharges), que ce
// soit des charges forfaitaires (ifProvisionsOnCharges=false) ou des provisions
// avec regularisation (ifProvisionsOnCharges=true). Le champ racine flatRateCharges
// est generalement vide et condoAnnualCharges = 0.
// Fallback : alur.flatRateCharges -> flatRateCharges racine -> condoAnnualCharges/12.
// deno-lint-ignore no-explicit-any
export function chargesFromDetail(d: any): number | null {
  const alur = num(d?.alur?.flatRateCharges);
  if (alur !== null && alur > 0) return round(alur);
  const root = num(d?.flatRateCharges);
  if (root !== null && root > 0) return round(root);
  const condoAnnual = num(d?.condoAnnualCharges);
  if (condoAnnual !== null && condoAnnual > 0) return round(condoAnnual / 12);
  return null;
}

// Nettoie une annonce detaillee Apify -> ligne `etudes_marche`, ou null si rejetee.
export function cleanDetail(
  // deno-lint-ignore no-explicit-any
  d: any,
  transaction: Transaction,
  quartier: string,
  geo: GeoInfo,
  scrapedAt: string,
) {
  const title = String(d?.title || "");
  if (ATYPIQUE.test(title)) return null; // colocation, chambre de service...

  const surface = num(d?.livingArea);
  if (!surface || surface <= 0) return null; // ignore les annonces sans surface

  const price = num(d?.price);
  if (!price || price <= 0) return null;

  const rooms = num(d?.rooms);

  // En location, le prix SeLoger est charges comprises (CC). Les charges
  // mensuelles viennent de l'objet alur (forfait OU provisions). Si introuvables
  // ou incoherentes, on laisse charges / loyer_hc a null (le loyer CC reste OK).
  let charges: number | null = null;
  let loyer_cc: number | null = null;
  let loyer_hc: number | null = null;
  if (transaction === "location") {
    loyer_cc = price;
    const c = chargesFromDetail(d);
    if (c !== null && c < price) {
      charges = c;
      loyer_hc = round(price - c);
    }
  }

  const prix_m2_cc = round(price / surface);
  const prix_m2_hc: number | null = transaction === "location"
    ? (loyer_hc !== null ? round(loyer_hc / surface) : null)
    : round(price / surface);

  return {
    ville: d?.city || geo.nom,
    quartier: d?.locality?.district || quartier || null,
    code_postal: (d?.zipCode ? String(d.zipCode) : null) || geo.codePostal,
    lat: geo.lat,
    lng: geo.lng,
    transaction,
    nb_pieces: rooms,
    typologie: typologie(rooms),
    surface,
    loyer_cc,
    charges,
    loyer_hc,
    prix_m2_cc,
    prix_m2_hc,
    dpe: dpeLetter(d?.energyBalance),
    nature: d?.propertyNature || d?.nature || null,
    url: d?.permalink || d?.url || null,
    source: "seloger",
    titre: title || null,
    scraped_at: scrapedAt,
  };
}

export type CleanRow = NonNullable<ReturnType<typeof cleanDetail>>;

// --- Synthese : prix/m2 pondere par surface, par typologie + global ---------
export function synthesize(rows: CleanRow[], transaction: Transaction) {
  const calc = (arr: CleanRow[]) => {
    const n = arr.length;
    if (!n) return null;
    // Sommes separees pour CC et HC : le HC peut manquer (charges absentes),
    // on ne ponderise alors que sur les surfaces des annonces qui l'ont.
    let sumSurf = 0;
    let sumCC = 0, sumSurfCC = 0;
    let sumHC = 0, sumSurfHC = 0;
    let sumPm2CC = 0, nPm2CC = 0;
    let sumPm2HC = 0, nPm2HC = 0;
    for (const r of arr) {
      sumSurf += r.surface;
      // valeur CC : loyer CC (location) ou prix de vente (= prix_m2 * surface)
      const ccVal = transaction === "location" ? r.loyer_cc : r.prix_m2_cc * r.surface;
      if (ccVal != null) {
        sumCC += ccVal;
        sumSurfCC += r.surface;
      }
      // valeur HC : loyer HC (location, si dispo) ou prix de vente
      const hcVal = transaction === "location" ? r.loyer_hc : r.prix_m2_cc * r.surface;
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
      // prix/m2 PONDERE PAR SURFACE = somme(loyers ou prix) / somme(surfaces)
      prix_m2_cc_pondere: sumSurfCC > 0 ? round(sumCC / sumSurfCC) : null,
      prix_m2_hc_pondere: sumSurfHC > 0 ? round(sumHC / sumSurfHC) : null,
      // moyenne simple des prix/m2 (pour comparaison)
      prix_m2_cc_moyen: nPm2CC > 0 ? round(sumPm2CC / nPm2CC) : null,
      prix_m2_hc_moyen: nPm2HC > 0 ? round(sumPm2HC / nPm2HC) : null,
      // nb d'annonces avec loyer hors charges exploitable (charges connues)
      nb_avec_hc: nPm2HC,
    };
  };

  const groups: Record<string, CleanRow[]> = {};
  for (const r of rows) (groups[r.typologie || "?"] ||= []).push(r);

  const parTypologie: Record<string, ReturnType<typeof calc>> = {};
  for (const t of ["T1", "T2", "T3", "T4", "T5", "T6"]) {
    if (groups[t]) parTypologie[t] = calc(groups[t]);
  }
  if (groups["?"]) parTypologie["autre"] = calc(groups["?"]);

  return { parTypologie, global: calc(rows) };
}

// ============================================================================
// FILTRE POST-TRAITEMENT : typologie (sur le nb de pieces `rooms`).
// (Le filtre "neuf uniquement" est gere cote handler car il s'appuie sur
//  le champ isNew de l'actor LISTE.)
// ============================================================================

export interface Filters {
  typologie?: string | null; // "T1".."T6" ; vide/null = toutes
}

// true si l'item detail brut passe le filtre typologie.
// deno-lint-ignore no-explicit-any
export function passesFilters(d: any, f: Filters): boolean {
  if (f.typologie) {
    const t = typologie(num(d?.rooms));
    if (t !== f.typologie) return false;
  }
  return true;
}
