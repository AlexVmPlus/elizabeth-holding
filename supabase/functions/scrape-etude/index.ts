// ============================================================================
// Edge Function : scrape-etude  (Elizabeth Holding) — source : FIRECRAWL
// Architecture 2 PHASES (le front pilote) pour eviter WORKER_RESOURCE_LIMIT :
//   - phase "start" : scrape la page LISTE (1 appel) + lance un BATCH async sur
//                     les pages detail -> renvoie immediatement { jobId, ... }.
//   - phase "poll"  : interroge le batch ; quand "completed", extrait les charges,
//                     calcule la synthese, insere en base et renvoie { done:true }.
// On ne scrape JAMAIS les details en serie dans la fonction (c'est ce qui plantait).
//
// SECRETS : FIRECRAWL_API_KEY (a definir) ; SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY
// (injectes automatiquement).
//
// COUT FIRECRAWL : 1 etude ~= 1 (liste) + maxItems (details). Cache 7 jours -> 0.
// ============================================================================

import {
  annonceToRow,
  buildListUrl,
  matchesAnnee,
  matchesNeuf,
  matchesTypologie,
  mergeCharges,
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
const FC_BATCH = "https://api.firecrawl.dev/v2/batch/scrape";
const CACHE_DAYS = 7;
// NB : la phase "start" ne scrape QU'UNE page liste (~25 annonces) pour rester
// rapide. maxItems plafonne surtout le nb de details (donc de credits).

interface ReqBody {
  phase?: "start" | "poll";
  ville?: string;
  quartier?: string;
  transaction?: Transaction;
  typologie?: string;
  neufOnly?: boolean;
  anneeMin?: number | string;
  maxItems?: number;
  forceRefresh?: boolean;
  // phase "poll"
  jobId?: string;
  // deno-lint-ignore no-explicit-any
  annoncesPartielles?: any[];
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

// --- api-adresse : ville -> INSEE + code postal + centre ---------------------
async function resolveCity(ville: string) {
  const u = `https://api-adresse.data.gouv.fr/search/?q=${encodeURIComponent(ville)}&type=municipality&limit=1`;
  const r = await fetch(u);
  if (!r.ok) return null;
  const j = await r.json();
  const f = j?.features?.[0];
  if (!f) return null;
  const p = f.properties || {};
  const coords = f.geometry?.coordinates ?? null;
  return {
    nom: String(p.city || p.name || ville),
    citycode: p.citycode ? String(p.citycode) : null,
    codePostal: p.postcode ? String(p.postcode) : null,
    lat: coords ? coords[1] : null,
    lng: coords ? coords[0] : null,
  };
}

// --- Firecrawl : scrape unique (page liste, JS rendu via waitFor) ------------
async function fcScrape(url: string, key: string): Promise<Record<string, unknown>> {
  const r = await fetch(FC_SCRAPE, {
    method: "POST",
    headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ url, formats: ["markdown", "links"], waitFor: 6000, timeout: 45000 }),
  });
  if (!r.ok) throw new Error(`Firecrawl HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const j = await r.json();
  if (!j?.success) throw new Error(`Firecrawl success=false: ${JSON.stringify(j?.error || j).slice(0, 200)}`);
  return (j.data || {}) as Record<string, unknown>;
}

// --- Firecrawl : BATCH async (lance un job sur N urls) -----------------------
async function fcBatchStart(urls: string[], key: string): Promise<string> {
  const r = await fetch(FC_BATCH, {
    method: "POST",
    headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ urls, formats: ["markdown"], waitFor: 4000 }),
  });
  if (!r.ok) throw new Error(`Firecrawl batch HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const j = await r.json();
  if (!j?.success || !j?.id) throw new Error(`Firecrawl batch start KO: ${JSON.stringify(j).slice(0, 200)}`);
  return String(j.id);
}

// --- Firecrawl : etat du batch (polling) ------------------------------------
async function fcBatchPoll(jobId: string, key: string): Promise<Record<string, unknown>> {
  const r = await fetch(`${FC_BATCH}/${jobId}`, { headers: { "Authorization": `Bearer ${key}` } });
  if (!r.ok) throw new Error(`Firecrawl batch poll HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return await r.json() as Record<string, unknown>;
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

// Ligne (DB / fraiche / fusionnee) -> objet annonce pour la pre-fiche.
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

// Annonce (objet) -> ligne d'insertion etudes_marche.
// deno-lint-ignore no-explicit-any
function toInsertRow(a: any, transaction: Transaction, scrapedAt: string) {
  return {
    ville: a.ville,
    quartier: a.quartier,
    code_postal: a.code_postal,
    transaction,
    nb_pieces: a.nb_pieces,
    typologie: a.typologie,
    surface: a.surface,
    loyer_cc: a.loyer_cc,
    charges: a.charges,
    loyer_hc: a.loyer_hc,
    prix_m2_cc: a.prix_m2_cc,
    prix_m2_hc: a.prix_m2_hc,
    url: a.url,
    source: "firecrawl",
    titre: a.titre,
    scraped_at: scrapedAt,
  };
}

// ============================================================================
// PHASE "start"
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

  // 1. Resolution INSEE -> code SeLoger
  const city = await resolveCity(ville);
  if (!city || !city.citycode) return json({ error: "ville introuvable" }, 404);
  const seloCode = selogerCode(city.citycode);
  if (!seloCode) return json({ error: "ville introuvable (code SeLoger non resolu)" }, 404);
  console.log(`[start] INSEE ${city.citycode} -> SeLoger ${seloCode} (${city.nom})`);

  // 2. Cache 7 jours
  if (!forceRefresh) {
    const cached = await fetchCache(env, city.nom, quartier, transaction);
    if (cached.length) {
      const lastTs = String(cached[0].scraped_at);
      const lastBatch = applyFilters(cached.filter((r) => String(r.scraped_at) === lastTs));
      if (lastBatch.length >= maxItems || lastBatch.length >= 15) {
        console.log(`[start] CACHE HIT : ${lastBatch.length} annonces du ${lastTs} (0 credit)`);
        const synthC = synthesize(lastBatch, transaction);
        return json({
          done: true, fromCache: true, creditsEstimes: 0, scrapedAt: lastTs,
          ville: city.nom, quartier: quartier || null, transaction, seloCode, filtres,
          annoncesTrouvees: lastBatch.length, annoncesRetenues: lastBatch.length,
          annonces: lastBatch.map(toAnnonce), parTypologie: synthC.parTypologie, global: synthC.global,
        });
      }
    }
  }

  // 3. Scrape la page LISTE (1 seul appel Firecrawl, rapide)
  const searchUrl = buildListUrl(seloCode, transaction, 1);
  console.log(`[start] Firecrawl liste : ${searchUrl}`);
  const data = await fcScrape(searchUrl, env.fcKey);
  const md = typeof data.markdown === "string" ? data.markdown : "";
  const raw = parseAnnonces(md, data.links);
  console.log(`[start] ${raw.length} annonces brutes`);

  // 4. Mapping + filtres + cap maxItems (on garde seulement celles avec url)
  const scrapedAt = new Date().toISOString();
  const ctx = { ville: city.nom, quartier: quartier || null, code_postal: city.codePostal, transaction, scrapedAt };
  let rows: Row[] = raw.map((a) => annonceToRow(a, ctx)).filter((r): r is Row => r !== null && !!r.url);
  rows = applyFilters(rows);
  rows = rows.slice(0, maxItems);
  const partielles = rows.map(toAnnonce);
  console.log(`[start] ${partielles.length} annonces retenues (apres filtres + cap)`);

  // Aucune annonce -> termine tout de suite
  if (partielles.length === 0) {
    return json({
      done: true, fromCache: false, creditsEstimes: 1, scrapedAt,
      ville: city.nom, quartier: quartier || null, transaction, seloCode, searchUrl, filtres,
      annoncesTrouvees: 0, annoncesRetenues: 0,
      message: "Aucune annonce exploitable (autre ville/transaction, retirez des filtres, ou augmentez maxItems).",
      annonces: [], parTypologie: {}, global: null,
    });
  }

  // VENTE (pas de charges) : on finalise direct, sans batch detail.
  if (transaction === "vente") {
    await insertRows(env, partielles.map((a) => toInsertRow(a, transaction, scrapedAt))).catch((e) => console.error("[start] insert vente:", e));
    const s = synthesize(partielles, transaction);
    return json({
      done: true, fromCache: false, creditsEstimes: 1, scrapedAt,
      ville: city.nom, quartier: quartier || null, transaction, seloCode, searchUrl, filtres,
      annoncesTrouvees: partielles.length, annoncesRetenues: partielles.length,
      annonces: partielles, parTypologie: s.parTypologie, global: s.global,
    });
  }

  // LOCATION : lance le BATCH async sur les pages detail.
  const detailUrls = rows.map((r) => r.url as string);
  try {
    const jobId = await fcBatchStart(detailUrls, env.fcKey);
    console.log(`[start] batch lance : ${jobId} (${detailUrls.length} details)`);
    return json({
      done: false, fromCache: false, jobId, scrapedAt,
      ville: city.nom, quartier: quartier || null, transaction, seloCode, searchUrl, filtres,
      total: detailUrls.length,
      annoncesPartielles: partielles,
      creditsEstimes: 1 + detailUrls.length,
    });
  } catch (e) {
    // Batch KO -> on garde au moins les loyers CC (pre-fiche utile).
    console.error("[start] batch start echec :", e instanceof Error ? e.message : e);
    await insertRows(env, partielles.map((a) => toInsertRow(a, transaction, scrapedAt))).catch(() => {});
    const s = synthesize(partielles, transaction);
    return json({
      done: true, fromCache: false, creditsEstimes: 1, scrapedAt,
      ville: city.nom, quartier: quartier || null, transaction, seloCode, searchUrl, filtres,
      annoncesTrouvees: partielles.length, annoncesRetenues: partielles.length,
      message: "Charges indisponibles (batch detail indisponible) — loyers charges comprises seulement.",
      annonces: partielles, parTypologie: s.parTypologie, global: s.global,
    });
  }
}

// ============================================================================
// PHASE "poll"
// ============================================================================
async function handlePoll(body: ReqBody, env: Env): Promise<Response> {
  const jobId = String(body.jobId || "");
  const transaction: Transaction = body.transaction === "vente" ? "vente" : "location";
  const partielles = Array.isArray(body.annoncesPartielles) ? body.annoncesPartielles : [];
  if (!jobId) return json({ error: "jobId manquant" }, 400);

  const status = await fcBatchPoll(jobId, env.fcKey);
  const state = String(status.status || "");
  const completed = Number(status.completed ?? 0);
  const total = Number(status.total ?? partielles.length);

  if (state !== "completed") {
    return json({ done: false, progress: `${completed}/${total}` });
  }

  // Batch termine : extraire les charges des markdowns detail.
  // deno-lint-ignore no-explicit-any
  const dataArr = Array.isArray(status.data) ? (status.data as any[]) : [];
  const markdowns = dataArr.map((d) => (d && typeof d.markdown === "string" ? d.markdown : ""));
  const merged = mergeCharges(partielles, markdowns);

  // Insertion + synthese (sur le dernier scrape uniquement)
  const scrapedAt = new Date().toISOString();
  const rows = merged.map((a) => toInsertRow(a, transaction, scrapedAt));
  try {
    await insertRows(env, rows);
  } catch (e) {
    console.error("[poll] insert echec :", e instanceof Error ? e.message : e);
  }
  const s = synthesize(merged, transaction);
  return json({
    done: true, fromCache: false, scrapedAt,
    transaction,
    annoncesRetenues: merged.length,
    annonces: merged.map(toAnnonce),
    parTypologie: s.parTypologie, global: s.global,
    creditsEstimes: total + 1, // 1 (liste) + total (details)
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
    return body.phase === "poll" ? await handlePoll(body, env) : await handleStart(body, env);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    return json({ error: "Echec scrape-etude", detail }, 502);
  }
});
