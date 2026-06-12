#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Genere scripts/insee_update.sql pour enrichir public.insee_communes a partir de
DEUX fichiers INSEE officiels (gratuits, sans cle), filtres sur nos 157 communes :

  1. base_cc_comparateur.csv      (Base du comparateur de territoires, INSEE 2521169)
     -> P22_POP, P16_POP (evolution), MED_SL23 (revenu median niveau de vie 2023).
  2. base-cc-logement-2022.CSV    (Logement en 2022, INSEE 8581474)
     -> P22_RP, P22_RP_PROP, P22_RP_LOC (proprietaires/locataires),
        P22_RP_ACHTOT, P22_RP_ACH2019 (RP achevees 2006-2019 = "recents").

Indicateurs produits (colonnes insee_communes) :
  - evolution_pop          : taux annuel moyen 2016->2022 (%/an, 1 decimale)
  - revenu_median          : MED_SL23 (€, entier)
  - pct_proprietaires      : P22_RP_PROP / P22_RP * 100 (1 decimale)
  - pct_locataires         : P22_RP_LOC  / P22_RP * 100 (1 decimale)
  - pct_logements_recents  : P22_RP_ACH2019 / P22_RP_ACHTOT * 100 (1 decimale)

Secret statistique (petite commune, valeur vide/non numerique) -> colonne omise
(reste NULL -> "n.c." cote site). On ne touche PAS population (deja remplie).

USAGE : python3 scripts/gen_insee_sql.py > scripts/insee_update.sql
"""
import csv, os

HERE = os.path.dirname(os.path.abspath(__file__))
INSEE_DIR = "/tmp/insee"
COMP = os.path.join(INSEE_DIR, "base_cc_comparateur.csv")
LOGT = os.path.join(INSEE_DIR, "base-cc-logement-2022.CSV")
CODES = os.path.join(HERE, "insee_codes.txt")

# Communes a AJOUTER si absentes de insee_communes (insee -> ville). Bordeaux est
# la ville-exemple de tout le site ("ex. Bordeaux") mais manquait de la table.
# On les insere (population du recensement 2022) puis on les enrichit comme les autres.
EXTRAS = {"33063": "Bordeaux"}


def num(s):
    if s is None:
        return None
    s = s.strip().replace(",", ".")
    if s == "":
        return None
    try:
        v = float(s)
    except ValueError:
        return None
    return v if v == v else None  # ecarte NaN


def load(path):
    with open(path, encoding="utf-8", newline="") as f:
        return {r["CODGEO"]: r for r in csv.DictReader(f, delimiter=";")}


def main():
    codes = [l.split()[0].strip() for l in open(CODES, encoding="utf-8") if l.strip()]
    for extra in EXTRAS:
        if extra not in codes:
            codes.append(extra)
    comp = load(COMP)
    logt = load(LOGT)

    # INSERT des communes "extras" absentes du seed (avec population recensement).
    inserts = []
    for code, ville in EXTRAS.items():
        pop = num(comp.get(code, {}).get("P22_POP"))
        popsql = int(round(pop)) if pop else "null"
        v = ville.replace("'", "''")
        inserts.append(
            "insert into public.insee_communes (insee, ville, population) values "
            "('{}','{}',{}) on conflict (insee) do nothing;".format(code, v, popsql)
        )

    rows = []  # (pop_pour_tri, code, {col: val})
    for code in codes:
        c = comp.get(code, {})
        g = logt.get(code, {})
        vals = {}

        # --- evolution annuelle moyenne 2016 -> 2022 (6 ans) ---
        p22, p16 = num(c.get("P22_POP")), num(c.get("P16_POP"))
        if p22 and p16 and p16 > 0:
            evo = ((p22 / p16) ** (1 / 6) - 1) * 100
            vals["evolution_pop"] = round(evo, 1)

        # --- revenu median (niveau de vie) ---
        med = num(c.get("MED_SL23"))
        if med:
            vals["revenu_median"] = int(round(med))

        # --- proprietaires / locataires (recensement logement) ---
        rp = num(g.get("P22_RP"))
        if rp and rp > 0:
            prop = num(g.get("P22_RP_PROP"))
            loc = num(g.get("P22_RP_LOC"))
            if prop is not None:
                vals["pct_proprietaires"] = round(prop / rp * 100, 1)
            if loc is not None:
                vals["pct_locataires"] = round(loc / rp * 100, 1)

        # --- logements recents (RP achevees 2006-2019) ---
        achtot = num(g.get("P22_RP_ACHTOT"))
        ach19 = num(g.get("P22_RP_ACH2019"))
        if achtot and achtot > 0 and ach19 is not None:
            vals["pct_logements_recents"] = round(ach19 / achtot * 100, 1)

        if vals:
            rows.append((p22 or 0, code, vals))

    # grandes villes d'abord (tri population descendante)
    rows.sort(key=lambda x: -x[0])

    cols_all = ["pct_proprietaires", "pct_locataires", "revenu_median",
                "pct_logements_recents", "evolution_pop"]
    filled = {col: 0 for col in cols_all}

    print("-- ============================================================================")
    print("-- Enrichissement INSEE de public.insee_communes (genere automatiquement).")
    print("-- Sources : Base comparateur de territoires (INSEE 2521169) + Logement 2022")
    print("--           (INSEE 8581474). Filtre sur nos 157 communes. Grandes villes d'abord.")
    print("-- A coller dans Supabase -> SQL Editor. N'ecrase PAS la colonne population.")
    print("-- ============================================================================")
    if inserts:
        print("-- Communes ajoutees (absentes du seed initial) :")
        for ins in inserts:
            print(ins)
        print()
    for _, code, vals in rows:
        for col in vals:
            filled[col] += 1
        sets = ", ".join("{}={}".format(k, vals[k]) for k in cols_all if k in vals)
        # echappe l'apostrophe eventuelle du code (aucune ici, mais par securite)
        safe = code.replace("'", "''")
        print("update public.insee_communes set {} where insee='{}';".format(sets, safe))

    total = len(rows)
    print("\n-- Recapitulatif (communes renseignees / {}) :".format(total))
    for col in cols_all:
        print("--   {:<24} : {} / {}".format(col, filled[col], total))
    print("-- Total communes touchees : {} (157 seed + {} ajoutee(s))".format(total, len(inserts)))


if __name__ == "__main__":
    main()
