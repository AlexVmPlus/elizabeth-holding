# Edge Function `scrape-etude`

Scrape SeLoger via **Firecrawl** (passe le DataDome), calcule des stats de
marché pondérées par surface, et stocke les annonces dans la table
`etudes_marche` (`source='firecrawl'`). **Pas de cache de résultats** : chaque
étude relance un vrai scraping (plan Firecrawl payant → données fraîches) ;
les insertions servent d'historique (carte), pas de cache.

## Source des annonces : classified-search (validé le 12/06/2026)

Deux formats de recherche SeLoger :

| format | filtre année | pagination via Firecrawl |
|---|---|---|
| `list.htm` (legacy) | ❌ ignoré | ❌ `LISTING-LISTpg=2` → ~80 % de doublons |
| `classified-search` | ✅ `yearOfConstructionMin` | ✅ `&page=N` → 0 doublon (testé p1..p4) |

→ La fonction utilise **classified-search** dès que le **code lieu `AD..FR..`**
de la ville est résolu, et `list.htm` (1 page max) en fallback.

**Résolution du code lieu** : l'autocomplete moderne est inaccessible (403
DataDome en direct, 404 via Firecrawl), mais la **page SEO de la ville**
(`/immobilier/locations/immo-<slug>-<dept>/`) se charge via Firecrawl et
contient le code `AD08FR..` de la ville ~100× dans ses liens (les codes
parents/voisins ~1-30×) → on prend le **plus fréquent** (`extractCityCode`).
1 crédit, **une seule fois par ville** : cache table **`seloger_places`**
(remplie au fil de l'usage, pas de pré-sourcing). Codes confirmés :
Bordeaux `AD08FR13100`, Lyon `AD08FR28808`.

Une page classified-search avec peu de résultats est complétée par une section
« Plus d'annonces à proximité » (autres villes !) → `cutProximity()` coupe le
markdown à ce marqueur avant parsing.

## Architecture "1 page par appel" (anti `WORKER_RESOURCE_LIMIT`)

Chaque appel de fonction fait **au plus 2 scrapes** (résolution + page 1), et
c'est le **FRONT qui orchestre la boucle**. 4 phases :

- **`start`** : résout l'INSEE (api-adresse) + le code lieu (cache
  `seloger_places`, sinon 1 scrape SEO), scrape la **page 1**, parse, filtre.
  S'il faut d'autres pages (récolte < 100 et page 1 pleine) →
  `{ done:false, code, pagesPrevues, annonces }` ; sinon insertion + synthèse
  → `{ done:true, ... }`.
- **`page`** : scrape la **page N** (2..4) de classified-search → annonces
  brutes (pas d'insertion). Le front dédoublonne par URL (sans query-string)
  et **stoppe si une page n'apporte aucune annonce nouvelle** (warning console).
- **`finalize`** : **0 scrape** → synthèse pondérée + insertion. Le front passe
  `credits` (compte réel : résolution + 1/page) qui est renvoyé tel quel.
- **`detail`** : 1 scrape d'une page détail (charges). **Non appelé par le
  front** : les pages détail sont bloquées par DataDome. Conservé pour mémoire.

### phase `start`
```
{ "phase":"start", "ville":"Bordeaux", "transaction":"location",
  "typologie":"T2", "neufOnly":false, "anneeMin":2025 }
```

| champ        | défaut       | description                                            |
|--------------|--------------|--------------------------------------------------------|
| `ville`      | (obligatoire)| commune → INSEE via `api-adresse.data.gouv.fr` (`type=municipality`) |
| `quartier`   | `null`       | libellé quartier (stocké tel quel)                     |
| `transaction`| `location`   | `location` ou `vente`                                  |
| `typologie`  | —            | `T1`..`T6` — filtre post-récupération                  |
| `neufOnly`   | `false`      | titre mentionne neuf/récent (post-filtre best-effort)  |
| `anneeMin`   | —            | **vrai filtre serveur** `yearOfConstructionMin` (toute année : 2020, 2025…) ; best-effort sur titres si code lieu non résolu |

Plafond **interne** : `MAX_ITEMS=100` / 4 pages max (plus de champ côté front).
**Exclusions systématiques** (pré-fiche ET stats) : colocations (titre/URL
`coloc`), surfaces < 9 m² (minimum légal -> parsing raté), et en location
prix/m² CC hors [5, 60] €/m² (`isColocation` / `isPlausible`).

### phase `page`
```
{ "phase":"page", "page":2, "code":"AD08FR13100", "ville":"Bordeaux",
  "codePostal":"33000", "transaction":"location", "anneeMin":2025,
  "typologie":"T2", "neufOnly":false }
```
→ `{ phase:"page", page, creditsEstimes:1, annonces:[...] }`

### phase `finalize`
```
{ "phase":"finalize", "ville":"Bordeaux", "transaction":"location",
  "annonces":[ ...dédoublonnées par le front... ], "credits":5 }
```
→ `{ done:true, annonces, parTypologie, global, creditsEstimes }`.

### Coût Firecrawl

1 étude = **(1 si ville jamais résolue) + 1 crédit par page liste** (1 à 4).
Ex. : 100 annonces sur une ville déjà connue = 4 crédits. Plus de cache : un
plan payant (5000 crédits) ≈ 1000+ études/mois.

### Détails techniques

1. **INSEE** : `api-adresse.data.gouv.fr` → `citycode` (ex Bordeaux `33063`).
   Code SeLoger `list.htm` = `0` inséré après le département : `33063 → 330063`
   (`selogerCode()`, fallback uniquement).
2. **Scrapes** : `POST /v2/scrape`, `formats:["markdown","links"]`
   (`["rawHtml"]` pour la résolution SEO), **`waitFor:6000` OBLIGATOIRE**
   (annonces chargées en JS), `timeout:45000`, **`maxAge:0` OBLIGATOIRE**
   (l'API v2 a un cache de scrape par défaut ~2 jours : sans `maxAge:0`,
   relancer une étude renvoyait la même page figée). Le champ `fcCache`
   (`metadata.cacheState`) est renvoyé par `start` pour vérifier ("miss").
3. **Parsing** : `parseAnnonces()` découpe sur les liens `/annonces/` ; les
   titres classified contiennent prix/pièces/surface (« Duplex … 2 322 € -
   5 pièces, 160,2 m² ») — surfaces **décimales FR** gérées (`160,2` → 160.2 ;
   avant correction, le regex prenait le `2` après la virgule → surfaces
   aberrantes de 2-5 m²).
4. Charges réelles indisponibles (détail DataDome) → **estimées côté front**
   (ratio €/m² paramétrable) ; synthèse pondérée sur les loyers CC.

### Validation du 12/06/2026 (Firecrawl)

- Bordeaux `AD08FR13100` : sans filtre 1 819 annonces ; `>=2020` → 64 ;
  `>=2025` → 28. Lyon `AD08FR28808` : `>=2020` → 83 ; `>=2025` → 28.
- Pagination : p1..p4 = 111 annonces uniques, 0 doublon inter-pages.
- `list.htm` `LISTING-LISTpg=2` : 19 doublons / 25 → abandonné pour la
  pagination (fallback 1 page seulement).

## Vente Neuf (`transaction:"vente_neuf"`) — SeLoger Neuf

Programmes neufs promoteurs via **selogerneuf.com** (validé le 12/06/2026) :
liste `/immobilier/neuf/immo-<slug>-<dept>/bien-programme/` (pagination `/2/`),
détail programme = nom, « Proposé par <promoteur> », adresse, livraison, lots
avec prix, « Soit X €/m² » et surface. Phases (toujours 1 scrape/appel) :

- **`start`** (`transaction:"vente_neuf"`) : liste page 1 → liens programmes
  (`neufProgramLinks`, ville exacte d'abord, voisins en secours) →
  `{ done:false, mode:"neuf", programmes:[urls], maxProgrammes:15 }`.
- **`neuf-liste`** : page N de la liste si la page 1 n'a pas assez de
  programmes (petites villes).
- **`neuf-detail`** : 1 programme par appel (séquentiel côté front) →
  `parseNeufMeta` + `parseNeufUnits`, garde-fou `isPlausibleNeuf`
  (2 500–15 000 €/m²), filtre typologie → lignes `programmes_neufs`.
- **`finalize`** (`transaction:"vente_neuf"`) : insertion table
  **`programmes_neufs`** (migration `20260612000000`) + synthèse pondérée par
  surface des prix/m² promoteurs.

Coût : 1 (liste) + 1/programme (≤ 15) ≈ **16 crédits par étude Vente Neuf**.
E2E Bordeaux : 15 programmes trouvés (93 annoncés), prix/m² pondéré global
~5 550 €/m², T1..T5 entre 4 850 et 6 700 €/m².

## Secret

`SUPABASE_URL` et `SUPABASE_SERVICE_ROLE_KEY` sont **injectés automatiquement**.
Seul **`FIRECRAWL_API_KEY`** est à définir :

```bash
supabase secrets set FIRECRAWL_API_KEY=fc-xxxxxxxxxxxxxxxxxxxxx \
  --project-ref wywndgujgtyyzzhviagu
```

## Déploiement

```bash
supabase login                                                  # une fois (TTY)
supabase functions deploy scrape-etude --project-ref wywndgujgtyyzzhviagu
```

`verify_jwt = false` (voir `supabase/config.toml`) : endpoint public (appelé
depuis le navigateur). ⚠️ Chaque appel consomme du crédit Firecrawl — limité à
**4 pages/étude**, pas de scrape détail.

## Tests

```bash
cd supabase/functions/scrape-etude && deno test --allow-read
```
