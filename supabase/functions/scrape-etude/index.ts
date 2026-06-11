// ============================================================================
// Edge Function : scrape-etude  (Elizabeth Holding) — source : FIRECRAWL
// Architecture "1 page scrapee par appel" (le FRONT orchestre la boucle) pour
// rester loin des limites Supabase (WORKER_RESOURCE_LIMIT). 3 phases :
//   - "start"    : 1 scrape (page liste) -> annonces partielles (loyer CC...).
//   - "detail"   : 1 scrape (UNE page detail) -> charges / loyer_hc.
//   - "finalize" : 0 scrape -> synthese ponderee + insertion en base.
// On n'utilise PLUS le batch async (inutilisable sur le free tier) ni de boucle
// de scrapes en serie dans la fonction.
//
// SECRETS : FIRECRAWL_API_KEY (a definir) ; SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY
// (injectes automatiquement).
// ============================================================================

import {
  annonceToRow,
  buildListUrl,
  detailResult,
  matchesAnnee,
  matchesNeuf,
  matchesTypologie,
  num,
  parseAnnonces,
  type Row,
  selogerCode,
  synthesize,
  type Transaction,
} from "./lib.ts";

const ALLOWED_ORIGIN = "https://alexvmplus.github.io";
const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin",
};

const FC_SCRAPE = "https://api.firecrawl.dev/v2/scrape";
const CACHE_DAYS = 7;
// La phase "start" ne scrape QU'UNE page liste (~25 annonces). maxItems plafonne
// le nb d'annonces (donc d'appels "detail" cote front).

interface ReqBody {
  phase?: "start" | "detail" | "finalize";
  ville?: string;
  quartier?: string;
  transaction?: Transaction;
  typologie?: string;
  neufOnly?: boolean;
  anneeMin?: number | string;
  maxItems?: number;
  forceRefresh?: boolean;
  // phase "detail"
  url?: string;
  loyer_cc?: number;
  surface?: number;
  nb_pieces?: number;
  // phase "finalize"
  // deno-lint-ignore no-explicit-any
  annonces?: any[];
}

interface Env {
  fcKey: string;
  supaUrl: string;
  serviceKey: string;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" },
  });
}

// --- api-adresse : ville -> INSEE + code postal ------------------------------
async function resolveCity(ville: string) {
  const u = `https://api-adresse.data.gouv.fr/search/?q=${encodeURIComponent(ville)}&type=municipality&limit=1`;
  const r = await fetch(u);
  if (!r.ok) return null;
  const j = await r.json();
  const f = j?.features?.[0];
  if (!f) return null;
  const p = f.properties || {};
  return {
    nom: String(p.city || p.name || ville),
    citycode: p.citycode ? String(p.citycode) : null,
    codePostal: p.postcode ? String(p.postcode) : null,
  };
}

// --- Firecrawl : 1 scrape simple (jamais de batch) ---------------------------
async function fcScrape(url: string, key: string, formats: string[], waitFor: number): Promise<Record<string, unknown>> {
  const r = await fetch(FC_SCRAPE, {
    method: "POST",
    headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ url, formats, waitFor, timeout: 45000 }),
  });
  if (!r.ok) throw new Error(`Firecrawl HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const j = await r.json();
  if (!j?.success) throw new Error(`Firecrawl success=false: ${JSON.stringify(j?.error || j).slice(0, 200)}`);
  return (j.data || {}) as Record<string, unknown>;
}

// --- Cache Supabase (< CACHE_DAYS jours, meme demande) ----------------------
// deno-lint-ignore no-explicit-any
async function fetchCache(env: Env, ville: string, quartier: string, transaction: Transaction): Promise<any[]> {
  const since = new Date(Date.now() - CACHE_DAYS * 86400 * 1000).toISOString();
  let q = `${env.supaUrl}/rest/v1/etudes_marche?source=eq.firecrawl` +
    `&transaction=eq.${encodeURIComponent(transaction)}` +
    `&ville=eq.${encodeURIComponent(ville)}` +
    `&scraped_at=gt.${encodeURIComponent(since)}` +
    `&select=*&order=scraped_at.desc`;
  if (quartier) q += `&quartier=eq.${encodeURIComponent(quartier)}`;
  const r = await fetch(q, { headers: { "apikey": env.serviceKey, "Authorization": `Bearer ${env.serviceKey}` } });
  if (!r.ok) return [];
  const rows = await r.json();
  return Array.isArray(rows) ? rows : [];
}

// deno-lint-ignore no-explicit-any
async function insertRows(env: Env, rows: any[]): Promise<void> {
  if (!rows.length) return;
  const ins = await fetch(`${env.supaUrl}/rest/v1/etudes_marche`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "apikey": env.serviceKey,
      "Authorization": `Bearer ${env.serviceKey}`,
      "Prefer": "return=minimal",
    },
    body: JSON.stringify(rows),
  });
  if (!ins.ok) throw new Error(`Insert Supabase HTTP ${ins.status}: ${(await ins.text()).slice(0, 300)}`);
}

// deno-lint-ignore no-explicit-any
function toAnnonce(r: any) {
  return {
    titre: r.titre,
    typologie: r.typologie,
    nb_pieces: r.nb_pieces,
    surface: r.surface,
    loyer_cc: r.loyer_cc,
    charges: r.charges ?? null,
    loyer_hc: r.loyer_hc ?? null,
    prix_m2_cc: r.prix_m2_cc,
    prix_m2_hc: r.prix_m2_hc ?? null,
    dpe: r.dpe ?? null,
    nature: r.nature ?? null,
    quartier: r.quartier,
    ville: r.ville,
    code_postal: r.code_postal,
    url: r.url,
  };
}

// deno-lint-ignore no-explicit-any
function toInsertRow(a: any, transaction: Transaction, scrapedAt: string) {
  return {
    ville: a.ville,
    quartier: a.quartier ?? null,
    code_postal: a.code_postal ?? null,
    transaction,
    nb_pieces: a.nb_pieces ?? null,
    typologie: a.typologie ?? null,
    surface: a.surface ?? null,
    loyer_cc: a.loyer_cc ?? null,
    charges: a.charges ?? null,
    loyer_hc: a.loyer_hc ?? null,
    prix_m2_cc: a.prix_m2_cc ?? null,
    prix_m2_hc: a.prix_m2_hc ?? null,
    url: a.url ?? null,
    source: "firecrawl",
    titre: a.titre ?? null,
    scraped_at: scrapedAt,
  };
}

// ============================================================================
// PHASE "start" : 1 scrape (page liste) -> annonces partielles
// ============================================================================
async function handleStart(body: ReqBody, env: Env): Promise<Response> {
  const ville = (body.ville || "").trim();
  const quartier = (body.quartier || "").trim();
  const transaction: Transaction = body.transaction === "vente" ? "vente" : "location";
  const maxItems = Math.min(Math.max(Math.round(num(body.maxItems) ?? 30), 1), 100);
  const typoFilter = /^T[1-6]$/.test(String(body.typologie || "")) ? String(body.typologie) : null;
  const neufOnly = body.neufOnly === true;
  const anneeMin = num(body.anneeMin);
  const forceRefresh = body.forceRefresh === true;
  if (!ville) return json({ error: "Champ 'ville' obligatoire" }, 400);

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
  const filtres = { typologie: typoFilter, neufOnly, anneeMin, maxItems };

  const city = await resolveCity(ville);
  if (!city || !city.citycode) return json({ error: "ville introuvable" }, 404);
  const seloCode = selogerCode(city.citycode);
  if (!seloCode) return json({ error: "ville introuvable (code SeLoger non resolu)" }, 404);
  console.log(`[start] INSEE ${city.citycode} -> SeLoger ${seloCode} (${city.nom})`);

  // Cache 7 jours
  if (!forceRefresh) {
    const cached = await fetchCache(env, city.nom, quartier, transaction);
    if (cached.length) {
      const lastTs = String(cached[0].scraped_at);
      const lastBatch = applyFilters(cached.filter((r) => String(r.scraped_at) === lastTs));
      if (lastBatch.length >= maxItems || lastBatch.length >= 15) {
        console.log(`[start] CACHE HIT : ${lastBatch.length} annonces du ${lastTs}`);
        const s = synthesize(lastBatch, transaction);
        return json({
          done: true, fromCache: true, creditsEstimes: 0, scrapedAt: lastTs,
          ville: city.nom, quartier: quartier || null, transaction, seloCode, filtres,
          annoncesRetenues: lastBatch.length, annonces: lastBatch.map(toAnnonce),
          parTypologie: s.parTypologie, global: s.global,
        });
      }
    }
  }

  // 1 scrape : page liste
  const searchUrl = buildListUrl(seloCode, transaction, 1);
  console.log(`[start] Firecrawl liste : ${searchUrl}`);
  const data = await fcScrape(searchUrl, env.fcKey, ["markdown", "links"], 6000);
  const md = typeof data.markdown === "string" ? data.markdown : "";
  const raw = parseAnnonces(md, data.links);
  console.log(`[start] ${raw.length} annonces brutes`);

  const scrapedAt = new Date().toISOString();
  const ctx = { ville: city.nom, quartier: quartier || null, code_postal: city.codePostal, transaction, scrapedAt };
  let rows: Row[] = raw.map((a) => annonceToRow(a, ctx)).filter((r): r is Row => r !== null && !!r.url);
  rows = applyFilters(rows).slice(0, maxItems);
  const partielles = rows.map(toAnnonce);
  console.log(`[start] ${partielles.length} annonces retenues`);

  // Aucune annonce -> termine
  if (partielles.length === 0) {
    return json({
      done: true, fromCache: false, creditsEstimes: 1, scrapedAt,
      ville: city.nom, quartier: quartier || null, transaction, seloCode, searchUrl, filtres,
      annoncesRetenues: 0, annonces: [], parTypologie: {}, global: null,
      message: "Aucune annonce exploitable (autre ville/transaction, retirez des filtres).",
    });
  }

  // VENTE : pas de charges -> on finalise tout de suite (insert + synthese).
  if (transaction === "vente") {
    await insertRows(env, partielles.map((a) => toInsertRow(a, transaction, scrapedAt))).catch((e) => console.error("[start] insert vente:", e));
    const s = synthesize(partielles, transaction);
    return json({
      done: true, fromCache: false, creditsEstimes: 1, scrapedAt,
      ville: city.nom, quartier: quartier || null, transaction, seloCode, searchUrl, filtres,
      annoncesRetenues: partielles.length, annonces: partielles,
      parTypologie: s.parTypologie, global: s.global,
    });
  }

  // LOCATION : on renvoie les annonces partielles ; le FRONT bouclera "detail".
  return json({
    phase: "start", done: false, fromCache: false, scrapedAt,
    ville: city.nom, quartier: quartier || null, transaction, seloCode, searchUrl, filtres,
    total: partielles.length, annonces: partielles, creditsEstimes: 1 + partielles.length,
  });
}

// ============================================================================
// PHASE "detail" : 1 scrape (UNE page detail) -> charges / loyer_hc
// ============================================================================
async function handleDetail(body: ReqBody, env: Env): Promise<Response> {
  const url = String(body.url || "");
  if (!url) return json({ error: "url manquante" }, 400);
  const loyerCc = num(body.loyer_cc);
  const surface = num(body.surface);
  try {
    const data = await fcScrape(url, env.fcKey, ["markdown"], 4000);
    const md = typeof data.markdown === "string" ? data.markdown : "";
    const d = detailResult(loyerCc, surface, md);
    return json({ phase: "detail", url, ...d });
  } catch (e) {
    // Echec d'UNE annonce : on renvoie charges=null, le front continue.
    console.error("[detail] echec :", e instanceof Error ? e.message : e);
    const prix_m2_cc = (loyerCc != null && surface != null && surface > 0) ? Math.round((loyerCc / surface) * 100) / 100 : null;
    return json({ phase: "detail", url, charges: null, loyer_hc: null, prix_m2_cc, prix_m2_hc: null });
  }
}

// ============================================================================
// PHASE "finalize" : 0 scrape -> synthese + insertion
// ============================================================================
async function handleFinalize(body: ReqBody, env: Env): Promise<Response> {
  const ville = (body.ville || "").trim();
  const quartier = (body.quartier || "").trim();
  const transaction: Transaction = body.transaction === "vente" ? "vente" : "location";
  const annonces = Array.isArray(body.annonces) ? body.annonces : [];
  if (!annonces.length) return json({ error: "annonces manquantes" }, 400);

  const scrapedAt = new Date().toISOString();
  const rows = annonces.map((a) => toInsertRow(a, transaction, scrapedAt));
  try {
    await insertRows(env, rows);
  } catch (e) {
    console.error("[finalize] insert echec :", e instanceof Error ? e.message : e);
  }
  const s = synthesize(annonces, transaction);
  return json({
    done: true, fromCache: false, scrapedAt,
    ville: ville || null, quartier: quartier || null, transaction,
    annoncesRetenues: annonces.length, annonces: annonces.map(toAnnonce),
    parTypologie: s.parTypologie, global: s.global,
    creditsEstimes: 1 + annonces.length,
  });
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

  const fcKey = Deno.env.get("FIRECRAWL_API_KEY");
  const supaUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!fcKey) return json({ error: "Secret FIRECRAWL_API_KEY manquant (supabase secrets set)" }, 500);
  if (!supaUrl || !serviceKey) return json({ error: "Env Supabase (URL / SERVICE_ROLE) absent" }, 500);
  const env: Env = { fcKey, supaUrl, serviceKey };

  try {
    if (body.phase === "detail") return await handleDetail(body, env);
    if (body.phase === "finalize") return await handleFinalize(body, env);
    return await handleStart(body, env);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    return json({ error: "Echec scrape-etude", detail }, 502);
  }
});
