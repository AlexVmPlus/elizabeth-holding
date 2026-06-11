// ============================================================================
// Edge Function : scrape-etude  (Elizabeth Holding) — source : FIRECRAWL
// ----------------------------------------------------------------------------
// POST { ville, quartier?, transaction?, typologie?, neufOnly?, anneeMin?,
//        maxItems?, withDetails? }
//
// 1. Resout le code INSEE de la ville (api-adresse.data.gouv.fr) -> code SeLoger.
// 2. Scrape les pages liste SeLoger (list.htm) via Firecrawl (waitFor 6000 ms
//    OBLIGATOIRE : les annonces sont chargees en JS). Max 4 pages (25/page).
// 3. Parse le markdown -> annonces (loyer CC, surface, pieces, url, titre).
//    Fallback regex si l'extraction json de Firecrawl est vide.
// 4. Filtre typologie / neuf / annee (best-effort), calcule prix/m2.
// 5. (Optionnel withDetails) scrape la page detail pour les charges -> loyer_hc.
// 6. Insere dans `etudes_marche` (source='firecrawl') + synthese ponderee.
//
// SECRETS (jamais en dur) :
//   - FIRECRAWL_API_KEY            -> a definir via `supabase secrets set`
//   - SUPABASE_URL                 -> injecte automatiquement par la plateforme
//   - SUPABASE_SERVICE_ROLE_KEY    -> injecte automatiquement par la plateforme
// ============================================================================

import {
  annonceToRow,
  buildListUrl,
  matchesAnnee,
  matchesNeuf,
  matchesTypologie,
  num,
  parseAnnonces,
  parseCharges,
  type RawAnnonce,
  type Row,
  round,
  selogerCode,
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

const FIRECRAWL_URL = "https://api.firecrawl.dev/v2/scrape";
const MAX_PAGES = 4; // economise les credits Firecrawl (4 x 25 = 100 annonces)
const CACHE_DAYS = 7; // duree de validite du cache Supabase

// COUT FIRECRAWL : 1 etude ~= 1 (page liste) + maxItems (details).
// 1000 credits gratuits/mois ~= 30 etudes a maxItems=30. Le cache 7 jours rend
// gratuites les re-etudes d'une meme ville dans la semaine.

interface ReqBody {
  ville?: string;
  quartier?: string;
  transaction?: Transaction;
  typologie?: string; // "T1".."T6" ; vide = toutes
  neufOnly?: boolean;
  anneeMin?: number | string; // filtre annee (best-effort post-recuperation)
  maxItems?: number;
  withDetails?: boolean; // scrape detail pour les charges reelles — TRUE par defaut
  forceRefresh?: boolean; // ignore le cache 7 jours et re-scrape
}

interface FcOpts {
  formats?: unknown[];
  waitFor?: number;
  timeout?: number;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" },
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- Resout la ville -> code INSEE + code postal + centre (api-adresse) ------
async function resolveCity(ville: string) {
  const u = `https://api-adresse.data.gouv.fr/search/?q=${encodeURIComponent(ville)}&type=municipality&limit=1`;
  const r = await fetch(u);
  if (!r.ok) return null;
  const j = await r.json();
  const f = j?.features?.[0];
  if (!f) return null;
  const p = f.properties || {};
  const coords = f.geometry?.coordinates ?? null; // [lng, lat]
  return {
    nom: String(p.city || p.name || ville),
    citycode: p.citycode ? String(p.citycode) : null,
    codePostal: p.postcode ? String(p.postcode) : null,
    lat: coords ? coords[1] : null,
    lng: coords ? coords[0] : null,
  };
}

// --- Firecrawl : scrape une URL (JS rendu via waitFor OBLIGATOIRE) -----------
async function firecrawl(url: string, apiKey: string, opts: FcOpts = {}): Promise<Record<string, unknown>> {
  const formats = opts.formats ?? ["markdown", "links"];
  const waitFor = opts.waitFor ?? 6000;
  const timeout = opts.timeout ?? 45000;
  const r = await fetch(FIRECRAWL_URL, {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ url, formats, waitFor, timeout }),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`Firecrawl HTTP ${r.status}: ${t.slice(0, 300)}`);
  }
  const j = await r.json();
  if (!j?.success) throw new Error(`Firecrawl success=false: ${JSON.stringify(j?.error || j).slice(0, 200)}`);
  return (j.data || {}) as Record<string, unknown>;
}

// --- Cache : lignes etudes_marche de la meme demande, < CACHE_DAYS jours ------
// deno-lint-ignore no-explicit-any
async function fetchCache(supaUrl: string, key: string, ville: string, quartier: string, transaction: Transaction): Promise<any[]> {
  const since = new Date(Date.now() - CACHE_DAYS * 86400 * 1000).toISOString();
  let q = `${supaUrl}/rest/v1/etudes_marche?source=eq.firecrawl` +
    `&transaction=eq.${encodeURIComponent(transaction)}` +
    `&ville=eq.${encodeURIComponent(ville)}` +
    `&scraped_at=gt.${encodeURIComponent(since)}` +
    `&select=*&order=scraped_at.desc`;
  if (quartier) q += `&quartier=eq.${encodeURIComponent(quartier)}`;
  const r = await fetch(q, { headers: { "apikey": key, "Authorization": `Bearer ${key}` } });
  if (!r.ok) return [];
  const rows = await r.json();
  return Array.isArray(rows) ? rows : [];
}

// Ligne (DB ou fraiche) -> objet annonce pour la pre-fiche.
// deno-lint-ignore no-explicit-any
function toAnnonce(r: any) {
  return {
    titre: r.titre,
    typologie: r.typologie,
    nb_pieces: r.nb_pieces,
    surface: r.surface,
    loyer_cc: r.loyer_cc,
    charges: r.charges,
    loyer_hc: r.loyer_hc,
    prix_m2_cc: r.prix_m2_cc,
    prix_m2_hc: r.prix_m2_hc,
    dpe: r.dpe ?? null,
    nature: r.nature ?? null,
    quartier: r.quartier,
    ville: r.ville,
    code_postal: r.code_postal,
    url: r.url,
  };
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
  const maxItems = Math.min(Math.max(Math.round(num(body.maxItems) ?? 25), 1), 100);
  const typoFilter = /^T[1-6]$/.test(String(body.typologie || "")) ? String(body.typologie) : null;
  const neufOnly = body.neufOnly === true;
  const anneeMin = num(body.anneeMin);
  const withDetails = body.withDetails !== false; // TRUE par defaut (charges reelles)
  const forceRefresh = body.forceRefresh === true;

  if (!ville) return json({ error: "Champ 'ville' obligatoire" }, 400);

  const FIRECRAWL_API_KEY = Deno.env.get("FIRECRAWL_API_KEY");
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!FIRECRAWL_API_KEY) return json({ error: "Secret FIRECRAWL_API_KEY manquant (supabase secrets set)" }, 500);
  if (!SUPABASE_URL || !SERVICE_KEY) return json({ error: "Env Supabase (URL / SERVICE_ROLE) absent" }, 500);

  try {
    // 1. Resolution INSEE -> code SeLoger
    const city = await resolveCity(ville);
    if (!city || !city.citycode) return json({ error: "ville introuvable" }, 404);
    const seloCode = selogerCode(city.citycode);
    if (!seloCode) return json({ error: "ville introuvable (code SeLoger non resolu)" }, 404);
    console.log(`[scrape-etude] INSEE ${city.citycode} -> SeLoger ${seloCode} (${city.nom})`);

    // Filtres post-recuperation, appliques aux annonces FRAICHES ou en CACHE.
    // deno-lint-ignore no-explicit-any
    const applyFilters = (arr: any[]) => {
      let out = arr;
      if (typoFilter) out = out.filter((r) => matchesTypologie(r.nb_pieces, typoFilter));
      if (neufOnly) out = out.filter((r) => matchesNeuf(r.titre));
      if (anneeMin) {
        const f = out.filter((r) => matchesAnnee(r.titre, anneeMin));
        out = f.length ? f : out; // best-effort : ne vide jamais tout
      }
      return out;
    };

    // 1bis. CACHE 7 jours : sert une etude recente de la meme demande (0 credit).
    if (!forceRefresh) {
      const cached = await fetchCache(SUPABASE_URL, SERVICE_KEY, city.nom, quartier, transaction);
      if (cached.length) {
        // ne garder que le DERNIER scrape (meme scraped_at) -> pas de doublons
        const lastTs = String(cached[0].scraped_at);
        const lastBatch = applyFilters(cached.filter((r) => String(r.scraped_at) === lastTs));
        if (lastBatch.length >= maxItems || lastBatch.length >= 15) {
          console.log(`[scrape-etude] CACHE HIT : ${lastBatch.length} annonces du ${lastTs} (0 credit)`);
          const synthC = synthesize(lastBatch as Row[], transaction);
          return json({
            ville: city.nom, quartier: quartier || null, transaction, insee: city.citycode, seloCode,
            scrapedAt: lastTs, fromCache: true, creditsEstimes: 0,
            filtres: { typologie: typoFilter, neufOnly, anneeMin, maxItems },
            annoncesTrouvees: lastBatch.length, annoncesRetenues: lastBatch.length, inserted: 0,
            annonces: lastBatch.map(toAnnonce),
            parTypologie: synthC.parTypologie, global: synthC.global,
          });
        }
      }
    }

    let credits = 0; // nb d'appels Firecrawl effectues (= credits consommes)

    // 2. Scrape des pages liste via Firecrawl
    const pages = Math.min(Math.ceil(maxItems / 25), MAX_PAGES);
    const raw: RawAnnonce[] = [];
    let lastUrl = "";
    for (let p = 1; p <= pages; p++) {
      const url = buildListUrl(seloCode, transaction, p);
      lastUrl = url;
      console.log(`[scrape-etude] Firecrawl page ${p}/${pages} : ${url}`);
      let data: Record<string, unknown>;
      try {
        credits++;
        data = await firecrawl(url, FIRECRAWL_API_KEY);
      } catch (e) {
        console.error(`[scrape-etude] page ${p} echec :`, e instanceof Error ? e.message : e);
        break;
      }
      const md = typeof data.markdown === "string" ? data.markdown : "";
      const pageAnnonces = parseAnnonces(md, data.links);
      console.log(`[scrape-etude] page ${p} : ${pageAnnonces.length} annonces brutes`);
      raw.push(...pageAnnonces);
      if (raw.length >= maxItems) break;
      if (p < pages) await sleep(400); // petit delai entre les pages
    }

    // Dedoublonnage global par url + cap maxItems
    const seen = new Set<string>();
    const rawUnique = raw
      .filter((a) => {
        if (!a.url) return true;
        if (seen.has(a.url)) return false;
        seen.add(a.url);
        return true;
      })
      .slice(0, maxItems);
    console.log(`[scrape-etude] total brut (dedoublonne) : ${rawUnique.length}`);

    // 3. Mapping -> lignes (calcul prix/m2)
    const scrapedAt = new Date().toISOString();
    const ctx = {
      ville: city.nom,
      quartier: quartier || null,
      code_postal: city.codePostal,
      transaction,
      scrapedAt,
    };
    let rows: Row[] = rawUnique
      .map((a) => annonceToRow(a, ctx))
      .filter((r): r is Row => r !== null);

    // 4. Filtres post-recuperation (typologie / neuf / annee best-effort)
    rows = applyFilters(rows);
    console.log(`[scrape-etude] apres filtres : ${rows.length} annonces`);

    // 5. Charges reelles : scrape la page detail de chaque annonce (1 credit/annonce).
    //    `rows` est deja <= maxItems -> on ne depasse JAMAIS maxItems appels detail.
    if (withDetails && transaction === "location" && rows.length) {
      console.log(`[scrape-etude] Scraping details de ${rows.length} annonces (${rows.length} credits)`);
      for (const r of rows) {
        if (!r.url || r.loyer_cc == null) continue;
        try {
          credits++;
          const d = await firecrawl(r.url, FIRECRAWL_API_KEY, { formats: ["markdown"], waitFor: 4000, timeout: 35000 });
          const md = typeof d.markdown === "string" ? d.markdown : "";
          const charges = parseCharges(md);
          if (charges != null && charges < r.loyer_cc) {
            r.charges = charges;
            r.loyer_hc = round(r.loyer_cc - charges);
            r.prix_m2_hc = round(r.loyer_hc / r.surface);
          }
        } catch (_) { /* on continue sans les charges pour cette annonce */ }
        await sleep(350);
      }
    }

    if (rows.length === 0) {
      return json({
        ville: city.nom, quartier: quartier || null, transaction, insee: city.citycode, seloCode, searchUrl: lastUrl,
        scrapedAt, fromCache: false, creditsEstimes: credits,
        filtres: { typologie: typoFilter, neufOnly, anneeMin, maxItems },
        annoncesTrouvees: rawUnique.length, annoncesRetenues: 0, inserted: 0,
        message: "Aucune annonce exploitable (essayez une autre ville/transaction, retirez des filtres ou augmentez maxItems).",
        annonces: [], parTypologie: {}, global: null,
      });
    }

    // 6. Insertion dans etudes_marche (service_role : bypass RLS)
    let inserted = 0;
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
      return json({ error: "Insertion Supabase echouee", detail: t.slice(0, 400), annoncesRetenues: rows.length }, 500);
    }
    inserted = rows.length;

    // 7. Synthese + liste detaillee (pour la pre-fiche)
    const synth = synthesize(rows, transaction);

    return json({
      ville: city.nom,
      quartier: quartier || null,
      transaction,
      insee: city.citycode,
      seloCode,
      searchUrl: lastUrl,
      scrapedAt,
      fromCache: false,
      creditsEstimes: credits,
      filtres: { typologie: typoFilter, neufOnly, anneeMin, maxItems },
      annoncesTrouvees: rawUnique.length,
      annoncesRetenues: rows.length,
      inserted,
      annonces: rows.map(toAnnonce),
      parTypologie: synth.parTypologie,
      global: synth.global,
    });
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    return json({ error: "Echec scraping", detail }, 502);
  }
});
