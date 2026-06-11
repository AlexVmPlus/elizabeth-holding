# Edge Function `scrape-etude`

Scrape SeLoger via **Firecrawl** (passe le DataDome, gratuit ~1000 pages/mois,
pas de rate-limit), calcule des stats de marché pondérées par surface, et stocke
les annonces dans la table `etudes_marche` (`source='firecrawl'`).

## Architecture 2 phases (anti `WORKER_RESOURCE_LIMIT`)

Scraper la liste **puis** N pages détail en série dans un seul worker faisait
planter la fonction (status 546). On utilise donc le **batch async Firecrawl** :

- **phase `start`** : vérifie le cache, résout l'INSEE, scrape **1 page liste**
  (rapide), parse les annonces, lance un **batch async** sur les URLs détail et
  renvoie immédiatement `{ done:false, jobId, annoncesPartielles, total }`.
- **phase `poll`** : interroge le batch ; tant que `status≠"completed"` →
  `{ done:false, progress:"k/n" }` ; une fois fini → extrait les charges,
  calcule la synthèse, insère en base et renvoie `{ done:true, annonces, ... }`.

Le front appelle `start`, affiche la pré-fiche, puis **poll toutes les ~3,5 s**.

### phase `start`
```
POST .../scrape-etude
{ "phase":"start", "ville":"Bordeaux", "transaction":"location",
  "typologie":"T2", "neufOnly":false, "anneeMin":null,
  "maxItems":30, "forceRefresh":false }
```

| champ        | défaut       | description                                            |
|--------------|--------------|--------------------------------------------------------|
| `ville`      | (obligatoire)| commune → INSEE via `api-adresse.data.gouv.fr` (`type=municipality`) |
| `quartier`   | `null`       | libellé quartier (stocké tel quel)                     |
| `transaction`| `location`   | `location` ou `vente` (vente = 1 phase, sans charges)  |
| `typologie`  | —            | `T1`..`T6` (Studio/T1=1 pièce … T6=6 pièces et +) — filtre post-récup |
| `neufOnly`   | `false`      | ne garde que les annonces dont le titre mentionne neuf/récent |
| `anneeMin`   | —            | filtre année **best-effort** sur le titre (neuf/récent ou année ≥ min) |
| `maxItems`   | `30`         | plafonne le nb de détails (1–100) — **1 page liste ~25 annonces** |
| `forceRefresh`| `false`     | ignore le cache 7 jours et re-scrape |

### phase `poll`
```
POST .../scrape-etude
{ "phase":"poll", "jobId":"<id>", "ville":"Bordeaux", "transaction":"location",
  "annoncesPartielles":[ ...renvoyées par start... ] }
```

### Cache 7 jours

Avant tout scraping, la fonction cherche dans `etudes_marche` une étude
`source='firecrawl'` de la même `ville`/`transaction` (et `quartier` si fourni)
datant de moins de 7 jours. Si le dernier scrape contient ≥ `maxItems` (ou ≥ 15)
annonces, elle renvoie ces lignes recalculées **sans appel Firecrawl** :
`{ fromCache: true, creditsEstimes: 0 }`. `forceRefresh:true` force un re-scrape.

### Coût Firecrawl

1 étude ≈ **1 (liste) + N (détails batch)** crédits, N = nb d'annonces retenues
(≤ maxItems, ≤ ~25). 1000 crédits gratuits/mois ≈ 30 études à `maxItems=30`. Le
cache rend gratuites les ré-études d'une même ville dans la semaine. La sortie
renvoie `creditsEstimes`. Sortie commune : `{ done, fromCache, creditsEstimes,
annonces, parTypologie, global }` (+ `jobId`/`annoncesPartielles`/`progress`
selon la phase).

### Détails techniques

1. **INSEE** : `api-adresse.data.gouv.fr` → `citycode` (ex Bordeaux `33063`).
   Code SeLoger = on insère un `0` après le département : `33063 → 330063`,
   `69123 → 690123` (confirmé). `selogerCode()` dans `lib.ts`.
2. **Liste** : `POST /v2/scrape`, `formats:["markdown","links"]`,
   **`waitFor:6000` OBLIGATOIRE** (annonces chargées en JS), `timeout:45000`.
3. **Détails** : `POST /v2/batch/scrape` `{ urls, formats:["markdown"],
   waitFor:4000 }` → `id` ; puis `GET /v2/batch/scrape/{id}` jusqu'à `completed`.
   Charges via `parseCharges` (motif principal « Charges forfaitaires X € »).
4. `loyer_hc = loyer_cc − charges` (sinon `null`). Synthèse pondérée CC **et** HC.

Si le batch échoue, `start` renvoie quand même les loyers **CC** (`done:true`).
Une annonce sans charges → incluse dans les stats CC, exclue des stats HC.

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
