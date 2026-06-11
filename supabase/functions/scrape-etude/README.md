# Edge Function `scrape-etude`

Scrape SeLoger via **Firecrawl** (passe le DataDome, gratuit ~1000 pages/mois,
pas de rate-limit), calcule des stats de marché pondérées par surface, et stocke
les annonces dans la table `etudes_marche` (`source='firecrawl'`).

## Appel

```
POST https://wywndgujgtyyzzhviagu.supabase.co/functions/v1/scrape-etude
Content-Type: application/json

{ "ville": "Bordeaux", "quartier": "Saint Jean-Belcier", "transaction": "location" }
```

Paramètres du body :

| champ        | défaut       | description                                            |
|--------------|--------------|--------------------------------------------------------|
| `ville`      | (obligatoire)| commune → INSEE via `api-adresse.data.gouv.fr` (`type=municipality`) |
| `quartier`   | `null`       | libellé quartier (stocké tel quel)                     |
| `transaction`| `location`   | `location` ou `vente`                                  |
| `typologie`  | —            | `T1`..`T6` (Studio/T1=1 pièce … T6=6 pièces et +) — filtre post-récup |
| `neufOnly`   | `false`      | ne garde que les annonces dont le titre mentionne neuf/récent |
| `anneeMin`   | —            | filtre année **best-effort** sur le titre (neuf/récent ou année ≥ min) |
| `maxItems`   | `30`         | nb max d'annonces (1–100 ; 25 par page, **4 pages max**) |
| `withDetails`| `true`       | scrape la page détail de **chaque** annonce pour les charges réelles (1 crédit/annonce) |
| `forceRefresh`| `false`     | ignore le cache 7 jours et re-scrape |

### Cache 7 jours

Avant tout scraping, la fonction cherche dans `etudes_marche` une étude
`source='firecrawl'` de la même `ville`/`transaction` (et `quartier` si fourni)
datant de moins de 7 jours. Si le dernier scrape contient ≥ `maxItems` (ou ≥ 15)
annonces, elle renvoie ces lignes recalculées **sans appel Firecrawl** :
`{ fromCache: true, creditsEstimes: 0 }`. `forceRefresh:true` force un re-scrape.

### Coût Firecrawl

1 étude ≈ **1 (liste) + maxItems (détails)** crédits. 1000 crédits gratuits/mois
≈ 30 études à `maxItems=30`. Le cache rend gratuites les ré-études d'une même
ville dans la semaine. La sortie renvoie `creditsEstimes` (nb d'appels réels).

### Fonctionnement

1. **INSEE** : `api-adresse.data.gouv.fr` → `citycode` (ex Bordeaux `33063`).
   Code SeLoger = on insère un `0` après le département : `33063 → 330063`,
   `69123 → 690123` (confirmé par tests). `selogerCode()` dans `lib.ts`.
2. **Firecrawl** : `POST https://api.firecrawl.dev/v2/scrape` avec
   `formats:["markdown","links"]`, **`waitFor:6000` OBLIGATOIRE** (annonces
   chargées en JS, sinon 0 résultat), `timeout:45000`.
3. **Parsing markdown** → annonces (loyer CC, surface, pièces, url, titre).
4. Filtres typologie / neuf / année, calcul prix/m², insertion, synthèse.

Le loyer en liste est **charges comprises (CC)**. Les charges ne sont récupérées
que si `withDetails:true` (scrape détail) → sinon `charges`/`loyer_hc` restent `null`.

La réponse contient `annonces` (liste détaillée pour la pré-fiche) **et**
`parTypologie` + `global` (synthèse pondérée). Contrat d'entrée/sortie identique
à l'ancienne version Apify (le front n'a pas besoin de changer).

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
