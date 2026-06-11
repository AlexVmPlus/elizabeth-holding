# Edge Function `scrape-etude`

Scrape SeLoger (neuf) via Apify, calcule des stats de marché pondérées par
surface, et stocke les annonces dans la table `etudes_marche`.

## Appel

```
POST https://wywndgujgtyyzzhviagu.supabase.co/functions/v1/scrape-etude
Content-Type: application/json
apikey: <cle publishable>

{ "ville": "Bordeaux", "quartier": "Saint Jean-Belcier", "transaction": "location" }
```

Paramètres du body :

| champ        | défaut       | description                                            |
|--------------|--------------|--------------------------------------------------------|
| `ville`      | (obligatoire)| commune (résolue en code INSEE via geo.api.gouv.fr)    |
| `quartier`   | `null`       | libellé quartier (stocké ; filtrage SeLoger limité)    |
| `transaction`| `location`   | `location` (Rent) ou `vente` (Buy)                     |
| `maxItems`   | `30`         | nb max d'annonces (1–60)                               |
| `natures`    | `1,2`        | filtre SeLoger : `1,2`=neuf+ancien (neuf seul `2` est trop rare) |
| `prixMin`/`prixMax`       | —  | loyer (location) ou prix (vente) → URL `price=min/max` |
| `surfaceMin`/`surfaceMax` | —  | m² → URL `surface=min/max`                             |
| `dpe`        | —            | liste de classes `["A".."G"]` → **post-traitement** sur `energyBalance` |
| `anneeMin`/`anneeMax`     | —  | année de construction → **post-traitement** (voir note) |

Filtres : `prix`/`surface` passent par l'URL `list.htm` (params confirmés
`price=min/max`, `surface=min/max`, `NaN` = borne ouverte). `dpe` et `année`
n'ont **pas** de param `list.htm` documenté → appliqués en **post-traitement**
sur les annonces récupérées. ⚠️ Le champ « année de construction » de l'actor
n'est pas confirmé : la réponse renvoie `anneeDisponible` (nb d'annonces où une
année a été trouvée) pour valider en prod ; tant qu'il vaut 0, le filtre année
est inactif (les annonces sans année sont conservées).

La réponse contient `annonces` (liste détaillée pour la pré-fiche) **et**
`parTypologie` + `global` (synthèse pondérée).

La ville est résolue en code place SeLoger (`ci`, ex Bordeaux `330063`) via
l'autocomplete SeLoger. L'actor liste renvoie l'URL dans `permalink` ; les charges
viennent de `alur.flatRateCharges` (forfait ou provisions) → loyer HC.

## Secrets

`SUPABASE_URL` et `SUPABASE_SERVICE_ROLE_KEY` sont **injectés automatiquement**
par la plateforme : ne pas les définir (le préfixe `SUPABASE_` est d'ailleurs
réservé et refusé par `secrets set`).

Seul `APIFY_TOKEN` est à définir :

```bash
supabase secrets set APIFY_TOKEN=apify_api_xxxxxxxxxxxxxxxxxxxxx \
  --project-ref wywndgujgtyyzzhviagu
```

## Déploiement

```bash
# 1. Authentification (ouvre le navigateur) — à lancer une fois
supabase login

# 2. Déployer la fonction (pas de Docker requis)
supabase functions deploy scrape-etude --project-ref wywndgujgtyyzzhviagu
```

`verify_jwt = false` (voir `supabase/config.toml`) : l'endpoint est public pour
être appelé depuis le navigateur. ⚠️ Chaque appel consomme du crédit Apify —
pour limiter les abus, on peut réactiver `verify_jwt`, ajouter un contrôle de
mot de passe dans la fonction, ou un rate-limit.

## Réponse (synthèse)

```json
{
  "ville": "Bordeaux",
  "transaction": "location",
  "searchUrl": "https://www.seloger.com/list.htm?...",
  "annoncesTrouvees": 30,
  "annoncesRetenues": 24,
  "inserted": 24,
  "parTypologie": {
    "T1": { "nb_annonces": 6, "surface_moyenne": 28.4,
            "prix_m2_cc_pondere": 24.1, "prix_m2_hc_pondere": 21.8, ... },
    "T2": { ... }
  },
  "global": { "nb_annonces": 24, "prix_m2_cc_pondere": 19.7, ... }
}
```

`prix_m2_*_pondere` = somme(loyers ou prix) / somme(surfaces) (pondéré surface).
