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
| `natures`    | `2`          | filtre SeLoger : `2`=neuf, `1,2`=neuf+ancien           |

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
