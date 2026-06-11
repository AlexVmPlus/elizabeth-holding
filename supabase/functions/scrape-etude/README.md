# Edge Function `scrape-etude`

Scrape SeLoger via **Firecrawl** (passe le DataDome, gratuit ~1000 pages/mois,
pas de rate-limit), calcule des stats de marché pondérées par surface, et stocke
les annonces dans la table `etudes_marche` (`source='firecrawl'`).

## Architecture "1 page par appel" (anti `WORKER_RESOURCE_LIMIT`)

Scraper la liste **puis** N pages détail en série dans un seul worker faisait
planter la fonction (status 546). Le **batch async Firecrawl** est inutilisable
sur le free tier (job bloqué « scraping » plusieurs minutes). Donc : **chaque
appel de fonction fait au plus 1 scrape Firecrawl**, et c'est le **FRONT qui
orchestre la boucle**. 3 phases :

- **`start`** : cache → sinon résout l'INSEE, scrape **1 page liste** (`waitFor
  6000`), parse les annonces → `{ done:false, annonces:[partielles], total }`.
- **`detail`** : scrape **UNE page détail** (`waitFor 4000`) → extrait les charges
  → `{ charges, loyer_hc, prix_m2_cc, prix_m2_hc }`. Le front boucle dessus
  séquentiellement (1 annonce à la fois, ~15 s chacune).
- **`finalize`** : **0 scrape** → synthèse pondérée + insertion → `{ done:true }`.

Le front : `start` (pré-fiche immédiate) → boucle `detail` (barre « Charges k/n »,
bouton Arrêter) → `finalize` (synthèse). ~15 s/annonce ⇒ ~8 min pour 30.

### phase `start`
```
{ "phase":"start", "ville":"Bordeaux", "transaction":"location",
  "typologie":"T2", "neufOnly":false, "anneeMin":null,
  "maxItems":30, "forceRefresh":false }
```

| champ        | défaut       | description                                            |
|--------------|--------------|--------------------------------------------------------|
| `ville`      | (obligatoire)| commune → INSEE via `api-adresse.data.gouv.fr` (`type=municipality`) |
| `quartier`   | `null`       | libellé quartier (stocké tel quel)                     |
| `transaction`| `location`   | `location` ou `vente` (vente = `done:true` direct, sans charges) |
| `typologie`  | —            | `T1`..`T6` (Studio/T1=1 pièce … T6=6 pièces et +) — filtre post-récup |
| `neufOnly`   | `false`      | ne garde que les annonces dont le titre mentionne neuf/récent |
| `anneeMin`   | —            | filtre année **best-effort** sur le titre (neuf/récent ou année ≥ min) |
| `maxItems`   | `30`         | plafonne le nb d'annonces/détails (1–100) — **1 page liste ~25 annonces** |
| `forceRefresh`| `false`     | ignore le cache 7 jours et re-scrape |

### phase `detail`
```
{ "phase":"detail", "url":"https://www.seloger.com/annonces/.../123.htm",
  "loyer_cc":900, "surface":50 }
```
→ `{ phase:"detail", url, charges, loyer_hc, prix_m2_cc, prix_m2_hc }`.

### phase `finalize`
```
{ "phase":"finalize", "ville":"Bordeaux", "transaction":"location",
  "annonces":[ ...annonces complètes (charges fusionnées par le front)... ] }
```
→ `{ done:true, annonces, parTypologie, global, creditsEstimes }`.

### Cache 7 jours

Avant tout scraping, la fonction cherche dans `etudes_marche` une étude
`source='firecrawl'` de la même `ville`/`transaction` (et `quartier` si fourni)
datant de moins de 7 jours. Si le dernier scrape contient ≥ `maxItems` (ou ≥ 15)
annonces, elle renvoie ces lignes recalculées **sans appel Firecrawl** :
`{ fromCache: true, creditsEstimes: 0 }`. `forceRefresh:true` force un re-scrape.

### Coût Firecrawl

1 étude ≈ **1 (liste) + N (détails)** crédits, N = nb d'annonces retenues
(≤ maxItems, ≤ ~25). 1000 crédits gratuits/mois ≈ 30 études à `maxItems=30`. Le
cache rend gratuites les ré-études d'une même ville dans la semaine. Chaque phase
renvoie `creditsEstimes` (`start`/`finalize`).

### Détails techniques

1. **INSEE** : `api-adresse.data.gouv.fr` → `citycode` (ex Bordeaux `33063`).
   Code SeLoger = on insère un `0` après le département : `33063 → 330063`,
   `69123 → 690123` (confirmé). `selogerCode()` dans `lib.ts`.
2. **Liste** (`start`) : `POST /v2/scrape`, `formats:["markdown","links"]`,
   **`waitFor:6000` OBLIGATOIRE** (annonces chargées en JS), `timeout:45000`.
3. **Détail** (`detail`) : `POST /v2/scrape` `formats:["markdown"]`,
   `waitFor:4000` — **1 seule page par appel** (jamais de série ni de batch).
   Charges via `parseCharges` (motif principal « Charges forfaitaires X € »).
4. `loyer_hc = loyer_cc − charges` (sinon `null`). Synthèse pondérée CC **et** HC.

Si une page détail échoue, `detail` renvoie `charges:null` (loyer CC conservé) :
l'annonce reste dans les stats CC, exclue des stats HC.

### Filtre année de construction (`anneeMin`)

`list.htm` **ignore** le filtre année. Seul **classified-search** l'applique
(`yearOfConstructionMin`), mais il exige un **code lieu `AD..FR..`** (≠ INSEE).
Quand `anneeMin` est fourni, `start` :

1. résout le code lieu via l'autocomplete SeLoger **côté serveur** (DataDome
   contourné par Firecrawl), met en cache dans la table **`seloger_places`**
   (`supabase/migrations/..._seloger_places.sql`) ;
2. si résolu → scrape `classified-search` (vrai filtre année), pas de post-filtre ;
3. si **non résolu** → fallback `list.htm` + **post-filtre best-effort** sur le
   titre (`neuf`/`récent`/année ≥ min) avec warning.

⚠️ **Endpoint autocomplete à confirmer** : la liste `CLASSIFIED_AUTOCOMPLETE`
(dans `index.ts`) contient des URLs candidates ; recopier l'URL exacte vue dans
l'onglet Network d'une vraie recherche classified-search. Tant qu'aucune ne
renvoie de code `AD..FR..`, le fallback best-effort s'applique (jamais de casse).

Table cache (à créer une fois) :
```sql
create table if not exists public.seloger_places (
  ville text primary key, insee text,
  code_classified text not null, updated_at timestamptz not null default now()
);
alter table public.seloger_places enable row level security;
```

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
depuis le navigateur). ⚠️ Chaque appel consomme du crédit Firecrawl — limité ici
à **4 pages/étude** et **pas de scrape détail par défaut**.
