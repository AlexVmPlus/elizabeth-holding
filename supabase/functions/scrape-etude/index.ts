// ============================================================================
// Edge Function : scrape-etude  (Elizabeth Holding) — source : FIRECRAWL
// Architecture "1 page scrapee par appel" (le FRONT orchestre la boucle) pour
// rester loin des limites Supabase (WORKER_RESOURCE_LIMIT). 4 phases :
//   - "start"    : resolution code lieu (cache seloger_places, sinon 1 scrape
//                  page SEO) + 1 scrape (page 1) -> annonces partielles.
//   - "page"     : 1 scrape (page N de classified-search) -> annonces brutes.
//   - "detail"   : 1 scrape (UNE page detail) -> charges (bloque DataDome,
//                  conserve pour memoire, non appele par le front).
//   - "finalize" : 0 scrape -> synthese ponderee + insertion en base.
// Source des annonces : classified-search (code lieu AD..FR.. resolu via la
// page SEO de la ville) -> vrai filtre annee (yearOfConstructionMin) + vraie
// pagination (&page=N). Fallback list.htm (1 page, filtre annee best-effort)
// si le code lieu est introuvable. PAS de cache de resultats : chaque etude
// relance un vrai scraping (donnees toujours fraiches).
//
// SECRETS : FIRECRAWL_API_KEY (a definir) ; SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY
// (injectes automatiquement).
// ============================================================================

import {
  annonceToRow,
  arrCodePostal,
  arrInsee,
  arrLabel,
  type Arrondissement,
  arrSlug,
  parseArrondissement,
  buildClassifiedUrl,
  buildCommuneRef,
  buildListUrl,
  cutProximity,
  matchesCommune,
  detailResult,
  extractCityCode,
  isColocation,
  isPlausible,
  isPlausibleNeuf,
  matchesAnnee,
  matchesTypologies,
  parseTypologies,
  neufListUrl,
  neufProgramLinks,
  num,
  parseAnnonces,
  parseNeufMeta,
  parseNeufUnits,
  synthesizeMeuble,
  type Row,
  selogerCode,
  seoLocationUrl,
  synthesize,
  type Transaction,
  typologie,
  villeSlug,
} from "./lib.ts";

const ALLOWED_ORIGIN = "https://alexvmplus.github.io";
const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin",
};

const FC_SCRAPE = "https://api.firecrawl.dev/v2/scrape";
// ~30 annonces par page classified-search ; 4 pages max. Plafond INTERNE fixe
// (plus de champ "Nombre max" cote front).
const MAX_PAGES = 4;
const PER_PAGE = 30;
const MAX_ITEMS = 100;
// Vente Neuf (selogerneuf.com) : plafond de programmes scrapes en detail
// (1 credit par programme) et de pages liste.
const NEUF_MAX_PROGS = 35;
const NEUF_LIST_PAGES = 4;
// Les pages programme bougent peu : on reutilise les lots deja en base
// (programmes_neufs) de moins de NEUF_CACHE_DAYS jours -> 0 credit pour eux.
const NEUF_CACHE_DAYS = 7;

interface ReqBody {
  phase?: "start" | "page" | "neuf-liste" | "neuf-detail" | "detail" | "finalize";
  ville?: string;
  quartier?: string;
  transaction?: Transaction | "vente_neuf";
  typologies?: string[]; // tableau envoye par le front (["T2"]) ; [] = toutes
  typologie?: string; // compat retro (CSV) — parseTypologies accepte les deux
  anneeMin?: number | string;
  // phase "page"
  code?: string;
  page?: number;
  codePostal?: string;
  // phase "detail"
  url?: string;
  loyer_cc?: number;
  surface?: number;
  nb_pieces?: number;
  // phase "finalize"
  // deno-lint-ignore no-explicit-any
  annonces?: any[];
  credits?: number; // credits reellement consommes, comptes par le front
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

// Ville saisie -> { nom, citycode, codePostal, arr } : arrondissement detecte
// localement ("Paris 8" -> INSEE 75108), sinon api-adresse.
async function resolveCityOrArr(ville: string) {
  const arr = parseArrondissement(ville);
  if (arr) {
    console.log(`[ville] arrondissement detecte : ${arrLabel(arr)} (INSEE ${arrInsee(arr)})`);
    return { nom: arrLabel(arr), citycode: arrInsee(arr), codePostal: arrCodePostal(arr), arr };
  }
  const city = await resolveCity(ville);
  return city ? { ...city, arr: null as Arrondissement | null } : null;
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
// maxAge:0 OBLIGATOIRE : l'API v2 a un cache de scrape active par defaut
// (~2 jours) -> sans lui, relancer une etude renvoyait la MEME page figee.
async function fcScrape(url: string, key: string, formats: string[], waitFor: number): Promise<Record<string, unknown>> {
  const r = await fetch(FC_SCRAPE, {
    method: "POST",
    headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ url, formats, waitFor, timeout: 45000, maxAge: 0 }),
  });
  if (!r.ok) throw new Error(`Firecrawl HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const j = await r.json();
  if (!j?.success) throw new Error(`Firecrawl success=false: ${JSON.stringify(j?.error || j).slice(0, 200)}`);
  return (j.data || {}) as Record<string, unknown>;
}

// ----------------------------------------------------------------------------
// RESOLUTION DU CODE LIEU classified-search (AD..FR..) — cote serveur.
// Teste le 12/06/2026 : l'autocomplete moderne est inaccessible (403 DataDome
// en direct, 404 via Firecrawl), MAIS la page SEO de la ville
// (immobilier/locations/immo-<slug>-<dept>/) se charge via Firecrawl et
// embarque le code AD08FR.. de la ville ~100 fois dans ses liens d'annonces
// -> on prend le code AD08FR le plus frequent. 1 credit, une seule fois par
// ville : le code est ensuite mis en cache dans la table seloger_places.
// ----------------------------------------------------------------------------
async function placeCacheGet(env: Env, ville: string): Promise<string | null> {
  try {
    const q = `${env.supaUrl}/rest/v1/seloger_places?ville=eq.${encodeURIComponent(ville.toLowerCase())}&select=code_classified&limit=1`;
    const r = await fetch(q, { headers: { "apikey": env.serviceKey, "Authorization": `Bearer ${env.serviceKey}` } });
    if (!r.ok) return null;
    const rows = await r.json();
    return (Array.isArray(rows) && rows[0]?.code_classified) ? String(rows[0].code_classified) : null;
  } catch {
    return null; // table absente / erreur -> on resoudra a nouveau
  }
}

async function placeCachePut(env: Env, ville: string, insee: string | null, code: string): Promise<void> {
  try {
    await fetch(`${env.supaUrl}/rest/v1/seloger_places`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": env.serviceKey,
        "Authorization": `Bearer ${env.serviceKey}`,
        "Prefer": "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify({ ville: ville.toLowerCase(), insee, code_classified: code, updated_at: new Date().toISOString() }),
    });
  } catch { /* cache best-effort */ }
}

// Resout le code lieu d'une ville : cache seloger_places d'abord (0 credit),
// sinon scrape de la page SEO (1 credit) + mise en cache. La table se remplit
// au fil de l'usage avec les villes reellement etudiees (pas de pre-sourcing).
// Renvoie { code, credits } — credits = 1 si un scrape a eu lieu.
async function resolveClassifiedCode(env: Env, ville: string, insee: string | null, arr: Arrondissement | null = null): Promise<{ code: string | null; credits: number }> {
  const cached = await placeCacheGet(env, ville);
  if (cached) {
    console.log(`[lieu] code (cache) ${ville} -> ${cached}`);
    return { code: cached, credits: 0 };
  }
  const dept = insee ? insee.slice(0, 2) : null;
  if (!dept) return { code: null, credits: 0 };
  try {
    const url = seoLocationUrl(arr ? arr.ville : ville, dept, arr);
    console.log(`[lieu] resolution via page SEO : ${url}`);
    const d = await fcScrape(url, env.fcKey, ["rawHtml"], 5000);
    const html = typeof d.rawHtml === "string" ? d.rawHtml : "";
    const code = extractCityCode(html);
    if (code) {
      console.log(`[lieu] code resolu ${ville} -> ${code}`);
      await placeCachePut(env, ville, insee, code);
      return { code, credits: 1 };
    }
    console.warn(`[lieu] aucun code AD08FR dans la page SEO (${html.length} octets)`);
    return { code: null, credits: 1 };
  } catch (e) {
    console.warn(`[lieu] resolution echec :`, e instanceof Error ? e.message : e);
    return { code: null, credits: 1 };
  }
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
    meuble: r.meuble ?? null,
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
    meuble: a.meuble ?? null,
    scraped_at: scrapedAt,
  };
}

// Filtres post-recuperation communs aux phases "start" et "page" :
// exclusions systematiques (colocations, surfaces/prix aberrants) puis filtres
// utilisateur. applyAnnee = false quand l'annee est deja filtree cote serveur.
function makeFilters(typoFilter: string[] | null, anneeMin: number | null, transaction: Transaction) {
  // deno-lint-ignore no-explicit-any
  return (arr: any[], applyAnnee = true) => {
    let out = arr.filter((r) => !isColocation(r.titre, r.url) && isPlausible(r.surface, r.prix_m2_cc, transaction));
    if (typoFilter) out = out.filter((r) => matchesTypologies(r.nb_pieces, typoFilter));
    if (anneeMin && applyAnnee) {
      const f = out.filter((r) => matchesAnnee(r.titre, anneeMin));
      out = f.length ? f : out; // best-effort : ne vide jamais tout
    }
    return out;
  };
}

// ============================================================================
// PHASE "start" : resolution code lieu + 1 scrape (page 1).
// Si d'autres pages sont necessaires (moins de MAX_ITEMS recoltees), renvoie
// done:false + le code lieu : le front enchaine phase "page" (2..4) puis
// "finalize". Sinon : insertion + synthese directes (done:true).
// PAS de cache de resultats : chaque etude relance un vrai scraping.
// ============================================================================
async function handleStart(body: ReqBody, env: Env): Promise<Response> {
  const ville = (body.ville || "").trim();
  const quartier = (body.quartier || "").trim();
  const transaction: Transaction = body.transaction === "vente" ? "vente" : "location";
  const typoFilter = parseTypologies(body.typologies ?? body.typologie);
  const anneeMin = num(body.anneeMin);
  if (!ville) return json({ error: "Champ 'ville' obligatoire" }, 400);

  const applyFilters = makeFilters(typoFilter, anneeMin, transaction);
  const filtres = { typologie: typoFilter, anneeMin };

  const city = await resolveCityOrArr(ville);
  if (!city || !city.citycode) return json({ error: "ville introuvable" }, 404);
  console.log(`[start] ${city.nom} (INSEE ${city.citycode})`);
  // Filtre commune STRICT (anti-debordement "et alentours" de SeLoger).
  const communeRef = buildCommuneRef(city.nom, city.codePostal);

  // Code lieu classified-search : cache seloger_places, sinon 1 scrape SEO.
  // Arrondissement : la page SEO immo-paris-8eme-75 donne le code AD09FR..
  const resolved = await resolveClassifiedCode(env, city.nom, city.citycode, city.arr);
  let credits = resolved.credits;
  const code = resolved.code;

  let searchUrl: string;
  let anneeServerSide = false;
  let note: string | null = null;
  if (code) {
    searchUrl = buildClassifiedUrl(code, transaction, anneeMin, 1);
    anneeServerSide = !!anneeMin;
  } else {
    // Fallback list.htm : 1 page max (sa pagination renvoie ~80% de doublons,
    // teste le 12/06/2026) + filtre annee best-effort sur les titres.
    const seloCode = selogerCode(city.citycode);
    if (!seloCode) return json({ error: "ville introuvable (code SeLoger non resolu)" }, 404);
    searchUrl = buildListUrl(seloCode, transaction, 1);
    note = anneeMin
      ? "Code lieu SeLoger non résolu pour cette ville : filtre année approximatif (mots-clés) et 25 annonces max."
      : "Code lieu SeLoger non résolu pour cette ville : 25 annonces max (pagination indisponible).";
    console.warn(`[start] fallback list.htm (code lieu non resolu)`);
  }

  console.log(`[start] Firecrawl : ${searchUrl}`);
  const data = await fcScrape(searchUrl, env.fcKey, ["markdown", "links"], 6000);
  credits += 1;
  // cacheState "miss" attendu (maxAge:0) : trace pour verifier la fraicheur.
  const fcCache = (data.metadata as Record<string, unknown> | undefined)?.cacheState ?? null;
  console.log(`[start] cacheState=${fcCache}`);
  const md = cutProximity(typeof data.markdown === "string" ? data.markdown : "");
  const raw = parseAnnonces(md, data.links);
  console.log(`[start] ${raw.length} annonces brutes`);

  const scrapedAt = new Date().toISOString();
  const ctx = { ville: city.nom, quartier: quartier || null, code_postal: city.codePostal, transaction, scrapedAt };
  let rows: Row[] = raw.map((a) => annonceToRow(a, ctx)).filter((r): r is Row => r !== null && !!r.url);
  // Filtre commune AVANT les autres filtres : on compte le debordement ecarte.
  const recoltees = rows.length;
  rows = rows.filter((r) => matchesCommune(r.titre, r.url, communeRef));
  const horsCommune = recoltees - rows.length;
  if (horsCommune) console.log(`[start] filtre commune : ${rows.length}/${recoltees} retenues (${horsCommune} hors ${city.nom})`);
  rows = applyFilters(rows, !anneeServerSide).slice(0, MAX_ITEMS);
  const partielles = rows.map(toAnnonce);
  console.log(`[start] ${partielles.length} annonces retenues (page 1)`);

  // D'autres pages sont-elles utiles ? (classified uniquement, et seulement si
  // la page 1 est pleine — sinon il n'y a plus rien a chercher.)
  const pagesPrevues = code ? MAX_PAGES : 1;
  const needMore = code !== null && partielles.length < MAX_ITEMS && raw.length >= PER_PAGE - 10;
  if (needMore) {
    return json({
      done: false, creditsEstimes: credits, scrapedAt, fcCache,
      ville: city.nom, quartier: quartier || null, codePostal: city.codePostal,
      transaction, code, searchUrl, filtres, pagesPrevues,
      annonces: partielles, note, recoltees, horsCommune,
    });
  }

  // Termine en 1 page : insertion + synthese ponderee (loyers CC ; charges
  // ESTIMEES cote front — le detail des charges reste bloque par DataDome).
  if (partielles.length === 0) {
    return json({
      done: true, creditsEstimes: credits, scrapedAt, fcCache,
      ville: city.nom, quartier: quartier || null, transaction, searchUrl, filtres,
      annoncesRetenues: 0, annonces: [], parTypologie: {}, global: null, note,
      recoltees, horsCommune,
      message: horsCommune > 0
        ? `Aucune annonce dans ${city.nom} : les ${horsCommune} annonces récupérées concernaient des communes/arrondissements voisins (écartés).`
        : "Aucune annonce exploitable (autre ville/transaction, retirez des filtres).",
    });
  }
  await insertRows(env, partielles.map((a) => toInsertRow(a, transaction, scrapedAt))).catch((e) => console.error("[start] insert:", e));
  const s = synthesize(partielles, transaction);
  return json({
    done: true, creditsEstimes: credits, scrapedAt, fcCache,
    ville: city.nom, quartier: quartier || null, transaction, searchUrl, filtres,
    annoncesRetenues: partielles.length, annonces: partielles, note,
    recoltees, horsCommune,
    parTypologie: s.parTypologie, global: s.global,
    loyersMeuble: transaction === "location" ? synthesizeMeuble(partielles) : null,
  });
}

// ============================================================================
// PHASE "page" : 1 scrape (page N de classified-search) -> annonces brutes.
// Pas d'insertion ici : le front dedoublonne et appelle "finalize".
// ============================================================================
async function handlePage(body: ReqBody, env: Env): Promise<Response> {
  const code = String(body.code || "");
  const page = Math.min(Math.max(Math.round(num(body.page) ?? 2), 2), MAX_PAGES);
  const ville = (body.ville || "").trim();
  const quartier = (body.quartier || "").trim();
  const transaction: Transaction = body.transaction === "vente" ? "vente" : "location";
  const typoFilter = parseTypologies(body.typologies ?? body.typologie);
  const anneeMin = num(body.anneeMin);
  if (!code || !ville) return json({ error: "code lieu et ville obligatoires" }, 400);

  const searchUrl = buildClassifiedUrl(code, transaction, anneeMin, page);
  console.log(`[page ${page}] Firecrawl : ${searchUrl}`);
  const data = await fcScrape(searchUrl, env.fcKey, ["markdown", "links"], 6000);
  const md = cutProximity(typeof data.markdown === "string" ? data.markdown : "");
  const raw = parseAnnonces(md, data.links);

  const scrapedAt = new Date().toISOString();
  const ctx = { ville, quartier: quartier || null, code_postal: body.codePostal || null, transaction, scrapedAt };
  let rows: Row[] = raw.map((a) => annonceToRow(a, ctx)).filter((r): r is Row => r !== null && !!r.url);
  // Filtre commune STRICT (meme regle qu'en phase "start"), avant les autres.
  const communeRef = buildCommuneRef(ville, body.codePostal || null);
  const recoltees = rows.length;
  rows = rows.filter((r) => matchesCommune(r.titre, r.url, communeRef));
  const horsCommune = recoltees - rows.length;
  // annee deja filtree cote serveur (classified) -> applyAnnee=false
  rows = makeFilters(typoFilter, anneeMin, transaction)(rows, false);
  if (horsCommune) console.log(`[page ${page}] filtre commune : ${horsCommune} hors ${ville} ecartees`);
  console.log(`[page ${page}] ${rows.length} annonces retenues`);
  return json({ phase: "page", page, creditsEstimes: 1, annonces: rows.map(toAnnonce), recoltees, horsCommune });
}

// ============================================================================
// VENTE NEUF (selogerneuf.com) : programmes neufs promoteurs.
// Meme architecture "1 scrape par appel" : "start" (liste page 1) ->
// "neuf-liste" (pages 2..4 si besoin) -> "neuf-detail" (1 programme par appel,
// sequentiel cote front, plafond NEUF_MAX_PROGS) -> "finalize".
// ============================================================================

// deno-lint-ignore no-explicit-any
function neufUnitToRow(u: any, meta: any, ctx: { ville: string; quartier: string | null; codePostal: string | null; url: string; scrapedAt: string }) {
  return {
    ville: ctx.ville,
    quartier: ctx.quartier,
    code_postal: ctx.codePostal,
    transaction: "vente_neuf",
    nom_programme: meta.nom ?? null,
    promoteur: meta.promoteur ?? null,
    adresse: meta.adresse ?? null,
    date_livraison: meta.livraison ?? null,
    nb_pieces: u.pieces ?? null,
    typologie: typologie(u.pieces),
    surface: u.surface ?? null,
    prix_total: u.prix,
    prix_m2: u.prix_m2,
    tva: meta.tva ?? null,
    url: ctx.url,
    source: "selogerneuf",
    scraped_at: ctx.scrapedAt,
  };
}

// PHASE "start" (transaction=vente_neuf) : 1 scrape (liste page 1) -> liens
// programmes (ville exacte d'abord, voisins en secours). Le front enchaine.
async function handleStartNeuf(body: ReqBody, env: Env): Promise<Response> {
  const ville = (body.ville || "").trim();
  const quartier = (body.quartier || "").trim();
  const typoFilter = parseTypologies(body.typologies ?? body.typologie);
  if (!ville) return json({ error: "Champ 'ville' obligatoire" }, 400);
  const city = await resolveCityOrArr(ville);
  if (!city || !city.citycode) return json({ error: "ville introuvable" }, 404);
  const dept = city.citycode.slice(0, 2);

  const url = neufListUrl(city.arr ? city.arr.ville : city.nom, dept, 1, city.arr);
  console.log(`[neuf] liste : ${url}`);
  const data = await fcScrape(url, env.fcKey, ["markdown", "links"], 6000);
  const md = typeof data.markdown === "string" ? data.markdown : "";
  // Arrondissement : filtre STRICT sur le slug (la liste Paris 8e est completee
  // par des programmes voisins type Clichy qu'il ne faut pas prendre).
  const slug = city.arr ? arrSlug(city.arr) : villeSlug(city.nom);
  // Filtre commune STRICT : le slug de l'URL programme porte la commune
  // (.../programme/boulogne-billancourt-92/... , .../paris-8eme-75008/...) ->
  // on ecarte les programmes des communes/arrondissements voisins.
  const communeRef = buildCommuneRef(city.nom, city.codePostal);
  const programmesRaw = neufProgramLinks(data.links, slug, !!city.arr);
  const programmes = programmesRaw.filter((u) => matchesCommune(null, u, communeRef));
  const totalProgrammes = num(md.match(/(\d[\d  ]*)\s*programmes/i)?.[1]?.replace(/\s/g, "")) ?? null;
  if (programmesRaw.length !== programmes.length) {
    console.log(`[neuf] filtre commune : ${programmes.length}/${programmesRaw.length} programmes (${programmesRaw.length - programmes.length} hors ${city.nom})`);
  }
  console.log(`[neuf] ${programmes.length} programmes (total annonce : ${totalProgrammes})`);

  const scrapedAt = new Date().toISOString();
  if (!programmes.length) {
    return json({
      done: true, transaction: "vente_neuf", creditsEstimes: 1, scrapedAt,
      ville: city.nom, quartier: quartier || null,
      annoncesRetenues: 0, annonces: [], parTypologie: {}, global: null,
      message: city.arr
        ? "Aucun programme neuf dans cet arrondissement sur SeLoger Neuf."
        : "Aucun programme neuf trouvé pour cette ville sur SeLoger Neuf.",
    });
  }

  // Cache programmes_neufs : les lots deja scrapes < NEUF_CACHE_DAYS jours
  // sont reutilises (0 credit) ; seuls les programmes inconnus sont scrapes.
  const target = programmes.slice(0, NEUF_MAX_PROGS);
  // deno-lint-ignore no-explicit-any
  const byUrl = new Map<string, any[]>();
  try {
    const since = new Date(Date.now() - NEUF_CACHE_DAYS * 86400 * 1000).toISOString();
    const q = `${env.supaUrl}/rest/v1/programmes_neufs?ville=eq.${encodeURIComponent(city.nom)}` +
      `&scraped_at=gt.${encodeURIComponent(since)}&select=*&order=scraped_at.desc&limit=1000`;
    const r = await fetch(q, { headers: { "apikey": env.serviceKey, "Authorization": `Bearer ${env.serviceKey}` } });
    if (r.ok) {
      for (const row of await r.json()) {
        if (!row.url) continue;
        const g = byUrl.get(row.url);
        if (!g) byUrl.set(row.url, [row]);
        else if (g[0].scraped_at === row.scraped_at) g.push(row); // batch le plus recent uniquement
      }
    }
  } catch { /* cache best-effort */ }
  const cachedUrls = target.filter((u) => byUrl.has(u));
  const toScrape = target.filter((u) => !byUrl.has(u));
  const cachedAnnonces = cachedUrls
    .flatMap((u) => byUrl.get(u)!)
    .filter((r) => matchesTypologies(r.nb_pieces, typoFilter))
    .filter((r) => matchesCommune(r.nom_programme, r.url, communeRef, r.adresse))
    // deno-lint-ignore no-explicit-any
    .map((r: any) => ({
      ville: r.ville, quartier: r.quartier, code_postal: r.code_postal, transaction: "vente_neuf",
      nom_programme: r.nom_programme, promoteur: r.promoteur, adresse: r.adresse,
      date_livraison: r.date_livraison, nb_pieces: r.nb_pieces, typologie: r.typologie,
      surface: r.surface, prix_total: r.prix_total, prix_m2: r.prix_m2, tva: r.tva ?? null,
      url: r.url, source: r.source, cached: true,
    }));
  console.log(`[neuf] ${target.length} cibles : ${cachedUrls.length} en cache, ${toScrape.length} a scraper`);

  return json({
    done: false, mode: "neuf", transaction: "vente_neuf", creditsEstimes: 1, scrapedAt,
    ville: city.nom, quartier: quartier || null, codePostal: city.codePostal,
    programmes: toScrape, cachedAnnonces, cachedProgrammes: cachedUrls.length,
    totalProgrammes, listPages: city.arr ? 1 : NEUF_LIST_PAGES,
    maxProgrammes: Math.max(0, NEUF_MAX_PROGS - cachedUrls.length),
  });
}

// PHASE "neuf-liste" : 1 scrape (liste page N) -> liens programmes en plus.
async function handleNeufListe(body: ReqBody, env: Env): Promise<Response> {
  const ville = (body.ville || "").trim();
  const page = Math.min(Math.max(Math.round(num(body.page) ?? 2), 2), NEUF_LIST_PAGES);
  if (!ville) return json({ error: "ville obligatoire" }, 400);
  const city = await resolveCityOrArr(ville);
  if (!city || !city.citycode) return json({ error: "ville introuvable" }, 404);
  const url = neufListUrl(city.arr ? city.arr.ville : city.nom, city.citycode.slice(0, 2), page, city.arr);
  console.log(`[neuf-liste ${page}] ${url}`);
  const data = await fcScrape(url, env.fcKey, ["markdown", "links"], 6000);
  const programmes = neufProgramLinks(data.links, city.arr ? arrSlug(city.arr) : villeSlug(city.nom), !!city.arr);
  return json({ phase: "neuf-liste", page, creditsEstimes: 1, programmes });
}

// PHASE "neuf-detail" : 1 scrape (page programme) -> meta + lots plausibles.
// En cas d'echec : 200 avec annonces=[] (le front continue avec les autres).
async function handleNeufDetail(body: ReqBody, env: Env): Promise<Response> {
  const url = String(body.url || "");
  const ville = (body.ville || "").trim();
  const quartier = (body.quartier || "").trim();
  if (!url || !ville) return json({ error: "url et ville obligatoires" }, 400);
  const typoFilter = parseTypologies(body.typologies ?? body.typologie);
  try {
    const data = await fcScrape(url, env.fcKey, ["markdown"], 6000);
    const md = typeof data.markdown === "string" ? data.markdown : "";
    const meta = parseNeufMeta(md);
    const units = parseNeufUnits(md)
      .filter((u) => isPlausibleNeuf(u.prix_m2))
      .filter((u) => matchesTypologies(u.pieces, typoFilter));
    const scrapedAt = new Date().toISOString();
    const ctx = { ville, quartier: quartier || null, codePostal: body.codePostal || null, url, scrapedAt };
    const rows = units.map((u) => neufUnitToRow(u, meta, ctx));
    console.log(`[neuf-detail] ${meta.nom} (${meta.promoteur}) : ${rows.length} lots`);
    return json({ phase: "neuf-detail", url, creditsEstimes: 1, programme: { ...meta, url }, annonces: rows });
  } catch (e) {
    console.error("[neuf-detail] echec :", e instanceof Error ? e.message : e);
    return json({ phase: "neuf-detail", url, creditsEstimes: 1, programme: { url }, annonces: [] });
  }
}

// PHASE "finalize" (vente_neuf) : 0 scrape -> insertion programmes_neufs +
// synthese ponderee par surface (prix_m2 des lots).
async function handleFinalizeNeuf(body: ReqBody, env: Env): Promise<Response> {
  const ville = (body.ville || "").trim();
  const quartier = (body.quartier || "").trim();
  let annonces = Array.isArray(body.annonces) ? body.annonces : [];
  if (!annonces.length) return json({ error: "annonces manquantes" }, 400);

  // Filtre commune STRICT (anti-debordement geographique) : ne garder que les
  // lots du lieu demande, via adresse ("92100 Boulogne-Billancourt"), slug
  // d'URL ou code postal. Recalcule la fiche UNIQUEMENT sur ces lots.
  const communeRef = buildCommuneRef(ville, null);
  const recoltees = annonces.length;
  annonces = annonces.filter((a) => matchesCommune(a.nom_programme, a.url, communeRef, a.adresse));
  const horsCommune = recoltees - annonces.length;
  let note: string | null = horsCommune > 0
    ? `${horsCommune} lot(s) hors ${ville} (communes/arrondissements voisins) écartés.`
    : null;
  if (!annonces.length) {
    return json({
      done: true, transaction: "vente_neuf", scrapedAt: new Date().toISOString(),
      ville: ville || null, quartier: quartier || null, recoltees, horsCommune,
      annoncesRetenues: 0, annonces: [], parTypologie: {}, global: null,
      creditsEstimes: num(body.credits) ?? 0,
      message: `Aucun programme neuf dans ${ville} : les ${recoltees} lot(s) récupéré(s) concernaient des communes/arrondissements voisins (écartés).`,
    });
  }

  // Quartier (hors arrondissement) : SeLoger Neuf ne cible pas les quartiers ->
  // filtre best-effort sur l'adresse / le nom du programme. Si rien ne matche,
  // on garde tout avec une note explicite.
  if (quartier) {
    const q = villeSlug(quartier);
    const match = annonces.filter((a) =>
      villeSlug(String(a.adresse || "")).includes(q) || villeSlug(String(a.nom_programme || "")).includes(q)
    );
    if (match.length) {
      note = `Filtre quartier « ${quartier} » appliqué sur les adresses : ${match.length}/${annonces.length} lots retenus.`;
      annonces = match;
    } else {
      note = `Quartier « ${quartier} » introuvable dans les adresses des programmes : étude sur toute la ville.`;
    }
  }

  const scrapedAt = new Date().toISOString();
  // N'insere que les lots fraichement scrapes (les lots `cached` sont DEJA en base).
  const fresh = annonces.filter((a) => !a.cached);
  try {
    if (fresh.length) {
      const ins = await fetch(`${env.supaUrl}/rest/v1/programmes_neufs`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "apikey": env.serviceKey,
          "Authorization": `Bearer ${env.serviceKey}`,
          "Prefer": "return=minimal",
        },
        body: JSON.stringify(fresh.map((a) => {
          const { cached: _c, ...row } = a;
          return { ...row, scraped_at: scrapedAt };
        })),
      });
      if (!ins.ok) console.error(`[neuf-finalize] insert HTTP ${ins.status}: ${(await ins.text()).slice(0, 200)}`);
    }
  } catch (e) {
    console.error("[neuf-finalize] insert echec :", e instanceof Error ? e.message : e);
  }

  // Synthese : lots -> StatRow (prix_m2 -> prix_m2_cc), ponderation "vente".
  // Lots sans surface : surface estimee prix/prix_m2 (coherente par construction).
  const stat = annonces.map((a) => {
    const surface = a.surface ?? (a.prix_total && a.prix_m2 ? Math.round((a.prix_total / a.prix_m2) * 10) / 10 : 0);
    return { surface, typologie: a.typologie ?? null, loyer_cc: null, loyer_hc: null, prix_m2_cc: a.prix_m2 ?? null, prix_m2_hc: a.prix_m2 ?? null };
  }).filter((s) => s.surface > 0);
  const s = synthesize(stat, "vente");
  return json({
    done: true, transaction: "vente_neuf", scrapedAt, note,
    ville: ville || null, quartier: quartier || null, recoltees, horsCommune,
    annoncesRetenues: annonces.length, annonces,
    parTypologie: s.parTypologie, global: s.global,
    creditsEstimes: num(body.credits) ?? 0,
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
    done: true, scrapedAt,
    ville: ville || null, quartier: quartier || null, transaction,
    annoncesRetenues: annonces.length, annonces: annonces.map(toAnnonce),
    parTypologie: s.parTypologie, global: s.global,
    loyersMeuble: transaction === "location" ? synthesizeMeuble(annonces) : null,
    creditsEstimes: num(body.credits) ?? 0, // comptes par le front (1/page + resolution)
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
    if (body.phase === "page") return await handlePage(body, env);
    if (body.phase === "neuf-liste") return await handleNeufListe(body, env);
    if (body.phase === "neuf-detail") return await handleNeufDetail(body, env);
    if (body.phase === "detail") return await handleDetail(body, env);
    if (body.phase === "finalize") {
      return body.transaction === "vente_neuf" ? await handleFinalizeNeuf(body, env) : await handleFinalize(body, env);
    }
    if (body.transaction === "vente_neuf") return await handleStartNeuf(body, env);
    return await handleStart(body, env);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    return json({ error: "Echec scrape-etude", detail }, 502);
  }
});
