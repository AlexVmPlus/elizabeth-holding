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

export interface GeoInfo {
  insee: string;
  nom: string;
  lat: number | null;
  lng: number | null;
  codePostal: string | null;
}

export type Transaction = "location" | "vente";

// --- Construit l'URL de recherche SeLoger filtree neuf ----------------------
export function buildSearchUrl(insee: string, transaction: Transaction, natures: string): string {
  const dist = transaction === "vente" ? "Buy" : "Rent";
  const projects = transaction === "vente" ? "2" : "1";
  const places = encodeURIComponent(JSON.stringify([{ inseeCodes: [insee] }]));
  // types=1,2 : appartement + maison ; natures=2 : neuf
  return `https://www.seloger.com/list.htm?projects=${projects}&types=1,2` +
    `&natures=${natures}&places=${places}&distributionTypes=${dist}` +
    `&enterprise=0&qsVersion=1.0&sort=d_dt_crea`;
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
  const charges = transaction === "location" ? (num(d?.flatRateCharges) ?? 0) : null;
  const loyer_cc = transaction === "location" ? price : null;
  const loyer_hc = transaction === "location" ? price - (charges ?? 0) : null;
  const prix_m2_cc = round(price / surface);
  const prix_m2_hc = transaction === "location"
    ? round((loyer_hc as number) / surface)
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
    dpe: d?.energyBalance || null,
    nature: d?.propertyNature || null,
    url: d?.permalink || null,
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
    let sumSurf = 0, sumCC = 0, sumHC = 0, sumPm2CC = 0, sumPm2HC = 0;
    for (const r of arr) {
      sumSurf += r.surface;
      if (transaction === "location") {
        sumCC += r.loyer_cc ?? 0;
        sumHC += r.loyer_hc ?? 0;
      } else {
        // vente : pondere le prix de vente (prix_m2 * surface = prix)
        sumCC += r.prix_m2_cc * r.surface;
        sumHC += r.prix_m2_hc * r.surface;
      }
      sumPm2CC += r.prix_m2_cc;
      sumPm2HC += r.prix_m2_hc ?? r.prix_m2_cc;
    }
    return {
      nb_annonces: n,
      surface_moyenne: round(sumSurf / n, 1),
      // prix/m2 PONDERE PAR SURFACE = somme(loyers ou prix) / somme(surfaces)
      prix_m2_cc_pondere: round(sumCC / sumSurf),
      prix_m2_hc_pondere: round(sumHC / sumSurf),
      // moyenne simple des prix/m2 (pour comparaison)
      prix_m2_cc_moyen: round(sumPm2CC / n),
      prix_m2_hc_moyen: round(sumPm2HC / n),
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
