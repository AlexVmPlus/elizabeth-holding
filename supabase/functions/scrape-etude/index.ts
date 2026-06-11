// ============================================================================
// Edge Function : scrape-etude  (Elizabeth Holding)
// ----------------------------------------------------------------------------
// POST { ville, quartier?, transaction? ("location"|"vente"), maxItems?, natures? }
//
// 1. Geocode la ville (geo.api.gouv.fr) -> code INSEE + centre + code postal.
// 2. Construit une URL de recherche SeLoger filtree NEUF (natures=2) pour la
//    ville et la transaction (location par defaut).
// 3. Lance l'actor Apify LISTE (par search-url) -> URLs d'annonces.
// 4. Lance l'actor Apify DETAIL (par items-urls) -> champs detailles.
// 5. Nettoie chaque annonce (surface > 0, hors colocation / chambre de service),
//    calcule loyer_hc, prix_m2_cc, prix_m2_hc, deduit la typologie T1..T6.
// 6. Insere les annonces dans la table `etudes_marche` (service_role).
// 7. Renvoie une synthese : par typologie T1..T6 (prix/m2 PONDERE PAR SURFACE,
//    en charges comprises ET hors charges, nb annonces, surface moyenne) + global.
//
// SECRETS (jamais en dur) :
//   - APIFY_TOKEN                  -> a definir via `supabase secrets set`
//   - SUPABASE_URL                 -> injecte automatiquement par la plateforme
//   - SUPABASE_SERVICE_ROLE_KEY    -> injecte automatiquement par la plateforme
// ============================================================================

import {
  buildSearchUrl,
  cleanDetail,
  constructionYear,
  type GeoInfo,
  normalizeDpe,
  num,
  passesFilters,
  synthesize,
  type Transaction,
} from "./lib.ts";

// --- CORS : autorise uniquement le front GitHub Pages -----------------------
const ALLOWED_ORIGIN = "https://alexvmplus.github.io";
const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin",
};

// --- Actors Apify -----------------------------------------------------------
const APIFY_LIST_ACTOR = "dqFjeUv7Nrv7lRatk"; // azzouzana/seloger-mass-products-scraper-by-search-url
const APIFY_DETAIL_ACTOR = "sY13vKfwmbpTAtyG2"; // azzouzana/seloger-mass-products-scraper-by-items-urls

interface ReqBody {
  ville?: string;
  quartier?: string;
  transaction?: Transaction;
  maxItems?: number;
  natures?: string; // filtre SeLoger : "1,2" (defaut, neuf+ancien) ou "2" (neuf seul, rare)
  // Filtres optionnels
  anneeMin?: number | string; // annee de construction (post-traitement, si dispo)
  anneeMax?: number | string;
  prixMin?: number | string; // loyer (location) ou prix (vente) -> URL price=min/max
  prixMax?: number | string;
  surfaceMin?: number | string; // m2 -> URL surface=min/max
  surfaceMax?: number | string;
  dpe?: string[] | string; // liste de classes A..G (post-traitement sur energyBalance)
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" },
  });
}

// --- Geocode ville -> INSEE + centre (API gratuite geo.api.gouv.fr) ---------
async function geocodeCity(ville: string): Promise<GeoInfo | null> {
  const u = `https://geo.api.gouv.fr/communes?nom=${encodeURIComponent(ville)}` +
    `&fields=code,centre,codesPostaux,nom&boost=population&limit=1`;
  const r = await fetch(u);
  if (!r.ok) return null;
  const arr = await r.json();
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const c = arr[0];
  const coords = c?.centre?.coordinates ?? null; // [lng, lat]
  return {
    insee: String(c.code),
    nom: String(c.nom),
    lng: coords ? coords[0] : null,
    lat: coords ? coords[1] : null,
    codePostal: Array.isArray(c.codesPostaux) && c.codesPostaux.length ? String(c.codesPostaux[0]) : null,
  };
}

// --- Resout la ville -> code place SeLoger (ci) via l'autocomplete SeLoger ---
// Renvoie le code "ci" (ex Bordeaux 330063) attendu dans le parametre places.
// Fallback : derive le ci depuis l'INSEE (dept + commune sur 4 chiffres).
async function selogerCi(ville: string, fallbackInsee: string): Promise<string> {
  try {
    const u = `https://autocomplete.svc.groupe-seloger.com/auto/complete/0/Ville/6?text=${encodeURIComponent(ville)}`;
    const r = await fetch(u, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (r.ok) {
      const arr = await r.json();
      if (Array.isArray(arr)) {
        const hit = arr.find((x) => x?.Type === "Ville" && x?.Params?.ci);
        if (hit) return String(hit.Params.ci);
      }
    }
  } catch (_) { /* fallback ci-dessous */ }
  // Fallback metropole : INSEE 5 chiffres "DDCCC" -> ci "DD" + "CCC".padStart(4,"0")
  const m = fallbackInsee.match(/^(\d{2})(\d{3})$/);
  return m ? m[1] + m[2].padStart(4, "0") : fallbackInsee;
}

// --- Apify : run-sync + recuperation directe du dataset ---------------------
async function apifyRunSync(
  actorId: string,
  input: unknown,
  token: string,
): Promise<Array<Record<string, unknown>>> {
  const u = `https://api.apify.com/v2/acts/${actorId}/run-sync-get-dataset-items?token=${token}`;
  const r = await fetch(u, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`Apify ${actorId} HTTP ${r.status}: ${t.slice(0, 300)}`);
  }
  const data = await r.json();
  return Array.isArray(data) ? data : [];
}

// ============================================================================
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Methode non autorisee, utilisez POST" }, 405);

  let body: ReqBody;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Body JSON invalide" }, 400);
  }

  const ville = (body.ville || "").trim();
  const quartier = (body.quartier || "").trim();
  const transaction: Transaction = body.transaction === "vente" ? "vente" : "location";
  const maxItems = Math.min(Math.max(Math.round(num(body.maxItems) ?? 30), 1), 60);
  const natures = (body.natures || "1,2").trim(); // neuf + ancien (neuf seul trop rare)

  // Filtres optionnels (prix/surface -> URL ; dpe/annee -> post-traitement)
  const prixMin = num(body.prixMin), prixMax = num(body.prixMax);
  const surfaceMin = num(body.surfaceMin), surfaceMax = num(body.surfaceMax);
  const anneeMin = num(body.anneeMin), anneeMax = num(body.anneeMax);
  const dpe = normalizeDpe(body.dpe);
  const filters = { prixMin, prixMax, surfaceMin, surfaceMax, anneeMin, anneeMax, dpe };

  if (!ville) return json({ error: "Champ 'ville' obligatoire" }, 400);

  const APIFY_TOKEN = Deno.env.get("APIFY_TOKEN");
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!APIFY_TOKEN) return json({ error: "Secret APIFY_TOKEN manquant (supabase secrets set)" }, 500);
  if (!SUPABASE_URL || !SERVICE_KEY) return json({ error: "Env Supabase (URL / SERVICE_ROLE) absent" }, 500);

  try {
    // 1. Geocode ville -> INSEE + centre
    const geo = await geocodeCity(ville);
    if (!geo) return json({ error: `Ville introuvable : ${ville}` }, 404);

    // 2. Code place SeLoger (ci) + URL de recherche
    const ci = await selogerCi(ville, geo.insee);
    const searchUrl = buildSearchUrl(ci, transaction, natures, { prixMin, prixMax, surfaceMin, surfaceMax });

    // 3. Actor LISTE -> URLs d'annonces
    const listItems = await apifyRunSync(APIFY_LIST_ACTOR, { startUrl: searchUrl, maxItems }, APIFY_TOKEN);
    const urls: string[] = [];
    for (const it of listItems) {
      const u = it?.permalink || it?.url;
      if (typeof u === "string" && u) urls.push(u);
    }
    const uniqueUrls = [...new Set(urls)].slice(0, maxItems);

    if (uniqueUrls.length === 0) {
      return json({
        ville: geo.nom, quartier: quartier || null, transaction, searchUrl, insee: geo.insee, ci,
        filtres: { anneeMin, anneeMax, prixMin, prixMax, surfaceMin, surfaceMax, dpe, maxItems },
        annoncesTrouvees: 0, annoncesRetenues: 0, anneeDisponible: 0, inserted: 0,
        message: "Aucune annonce trouvee pour ces criteres (essayez une autre ville/transaction ou augmentez maxItems).",
        annonces: [], parTypologie: {}, global: null,
      });
    }

    // 4. Actor DETAIL -> champs detailles
    const detailItems = await apifyRunSync(APIFY_DETAIL_ACTOR, { startUrls: uniqueUrls }, APIFY_TOKEN);

    // 5. Filtres post-traitement (DPE/annee + securite prix/surface) + nettoyage
    const scrapedAt = new Date().toISOString();
    const rows: NonNullable<ReturnType<typeof cleanDetail>>[] = [];
    let anneeDisponible = 0; // diagnostic : nb d'annonces ou une annee a ete trouvee
    for (const d of detailItems) {
      if (!passesFilters(d, filters)) continue;
      const r = cleanDetail(d, transaction, quartier, geo, scrapedAt);
      if (!r) continue;
      rows.push(r);
      if (constructionYear(d) != null) anneeDisponible++;
    }

    // 6. Insertion dans etudes_marche (service_role : bypass RLS)
    let inserted = 0;
    if (rows.length) {
      const ins = await fetch(`${SUPABASE_URL}/rest/v1/etudes_marche`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "apikey": SERVICE_KEY,
          "Authorization": `Bearer ${SERVICE_KEY}`,
          "Prefer": "return=minimal",
        },
        body: JSON.stringify(rows),
      });
      if (!ins.ok) {
        const t = await ins.text();
        return json({
          error: "Insertion Supabase echouee", detail: t.slice(0, 400),
          searchUrl, annoncesRetenues: rows.length,
        }, 500);
      }
      inserted = rows.length;
    }

    // 7. Synthese + liste detaillee des annonces retenues (pour la pre-fiche)
    const synth = synthesize(rows, transaction);
    const annonces = rows.map((r) => ({
      titre: r.titre,
      typologie: r.typologie,
      nb_pieces: r.nb_pieces,
      surface: r.surface,
      loyer_cc: r.loyer_cc,
      charges: r.charges,
      loyer_hc: r.loyer_hc,
      prix_m2_cc: r.prix_m2_cc,
      prix_m2_hc: r.prix_m2_hc,
      dpe: r.dpe,
      nature: r.nature,
      quartier: r.quartier,
      ville: r.ville,
      code_postal: r.code_postal,
      url: r.url,
    }));

    return json({
      ville: geo.nom,
      quartier: quartier || null,
      transaction,
      insee: geo.insee,
      ci,
      searchUrl,
      scrapedAt,
      filtres: { anneeMin, anneeMax, prixMin, prixMax, surfaceMin, surfaceMax, dpe, maxItems },
      annoncesTrouvees: uniqueUrls.length,
      annoncesRetenues: rows.length,
      anneeDisponible,
      inserted,
      annonces,
      parTypologie: synth.parTypologie,
      global: synth.global,
    });
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    return json({ error: "Echec scraping", detail }, 502);
  }
});
