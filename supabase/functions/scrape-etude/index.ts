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
  type GeoInfo,
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
  natures?: string; // override du filtre SeLoger (2 = neuf, "1,2" = neuf+ancien)
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
  const maxItems = Math.min(Math.max(Math.round(body.maxItems ?? 30), 1), 60);
  const natures = (body.natures || "2").trim(); // 2 = neuf

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

    // 2. URL de recherche SeLoger
    const searchUrl = buildSearchUrl(geo.insee, transaction, natures);

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
        ville: geo.nom, quartier: quartier || null, transaction, searchUrl, insee: geo.insee,
        annoncesTrouvees: 0, annoncesRetenues: 0, inserted: 0,
        message: "Aucune annonce trouvee pour ces criteres (essayez natures='1,2' ou une autre transaction).",
        parTypologie: {}, global: null,
      });
    }

    // 4. Actor DETAIL -> champs detailles
    const detailItems = await apifyRunSync(APIFY_DETAIL_ACTOR, { startUrls: uniqueUrls }, APIFY_TOKEN);

    // 5. Nettoyage + calculs
    const scrapedAt = new Date().toISOString();
    const rows = detailItems
      .map((d) => cleanDetail(d, transaction, quartier, geo, scrapedAt))
      .filter((r): r is NonNullable<typeof r> => r !== null);

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

    // 7. Synthese
    const synth = synthesize(rows, transaction);

    return json({
      ville: geo.nom,
      quartier: quartier || null,
      transaction,
      insee: geo.insee,
      searchUrl,
      scrapedAt,
      annoncesTrouvees: uniqueUrls.length,
      annoncesRetenues: rows.length,
      inserted,
      parTypologie: synth.parTypologie,
      global: synth.global,
    });
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    return json({ error: "Echec scraping", detail }, 502);
  }
});
