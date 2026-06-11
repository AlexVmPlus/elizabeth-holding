#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Génère le SQL UPDATE pour enrichir public.insee_communes (Supabase) avec les
indicateurs socio-économiques INSEE, filtrés sur NOS 157 communes.

Pourquoi ce script : les fichiers INSEE communaux (FiLoSoFi, recensement
Logement, séries population) n'ont pas pu être téléchargés automatiquement
(URLs/IDs instables, pas d'API sans clé). Télécharge-les une fois (voir plus
bas), puis lance ce script -> il sort un fichier .sql à coller dans Supabase.

USAGE :
    python3 scripts/insee_to_sql.py \
        --filosofi  base-cc-filosofi-2021.csv \
        --logement  base-cc-logement-2021.csv \
        --population base-cc-serie-historique-2021.csv \
        > scripts/insee_update.sql

Chaque fichier est OPTIONNEL : ne passe que ceux que tu as, les colonnes
manquantes resteront NULL (-> "n.c." côté site). Séparateur CSV = ";".

FICHIERS INSEE À TÉLÉCHARGER (gratuits, sans clé) :
  1. FiLoSoFi 2021 (revenu/niveau de vie médian par commune)
     insee.fr -> "Revenus et pauvreté des ménages en 2021 (Filosofi)" ->
     base communale -> CODGEO + médiane du niveau de vie (col. MED21).
  2. Recensement 2021 - Logement (base communale)
     insee.fr -> "Logement en 2021" base communale -> CODGEO +
     P21_RP (total RP), P21_RP_PROP (propriétaires), P21_RP_LOC (locataires),
     P21_RP_ACH19 (logements achevés depuis 2019 -> "récents").
  3. Séries population (base historique communale)
     insee.fr -> populations légales / séries -> CODGEO + P21_POP + P15_POP.

Si tes colonnes diffèrent (millésime/version), ajuste le dict COLS ci-dessous
(ou envoie-moi l'en-tête des CSV et je l'adapte).
"""
import argparse, csv, os, sys

# --- Noms de colonnes attendus (ajuste si ton millésime differe) ------------
COLS = {
    "codgeo": "CODGEO",
    "revenu_median": "MED21",          # FiLoSoFi : mediane du niveau de vie 2021
    "rp_total": "P21_RP",              # recensement : total residences principales
    "rp_prop": "P21_RP_PROP",          # RP occupees par proprietaire
    "rp_loc": "P21_RP_LOC",            # RP occupees par locataire
    "rp_recents": "P21_RP_ACH19",      # logements acheves depuis 2019
    "pop21": "P21_POP",
    "pop15": "P15_POP",
}

HERE = os.path.dirname(os.path.abspath(__file__))


def load_codes():
    with open(os.path.join(HERE, "insee_codes.txt"), encoding="utf-8") as f:
        return {l.strip() for l in f if l.strip()}


def read_csv(path):
    if not path:
        return {}
    # detecte le separateur (; le plus courant chez l'INSEE, parfois ,)
    with open(path, encoding="utf-8-sig", newline="") as f:
        sample = f.read(4096)
        f.seek(0)
        delim = ";" if sample.count(";") >= sample.count(",") else ","
        return {r.get(COLS["codgeo"], "").strip(): r for r in csv.DictReader(f, delimiter=delim)}


def num(r, key):
    try:
        v = (r.get(COLS[key], "") or "").replace(",", ".").replace(" ", "").replace(" ", "")
        return float(v) if v not in ("", "nd", "N/A", "s") else None
    except Exception:
        return None


def pct(part, total):
    return round(part / total * 100, 1) if (part is not None and total) else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--filosofi")
    ap.add_argument("--logement")
    ap.add_argument("--population")
    a = ap.parse_args()

    codes = load_codes()
    filo = read_csv(a.filosofi)
    logt = read_csv(a.logement)
    popu = read_csv(a.population)

    out = []
    for c in sorted(codes):
        sets, fl, lg, pp = [], filo.get(c), logt.get(c), popu.get(c)
        if fl:
            rev = num(fl, "revenu_median")
            if rev is not None:
                sets.append(f"revenu_median={int(rev)}")
        if lg:
            tot = num(lg, "rp_total")
            prop, loc, rec = num(lg, "rp_prop"), num(lg, "rp_loc"), num(lg, "rp_recents")
            if pct(prop, tot) is not None:
                sets.append(f"pct_proprietaires={pct(prop, tot)}")
            if pct(loc, tot) is not None:
                sets.append(f"pct_locataires={pct(loc, tot)}")
            if pct(rec, tot) is not None:
                sets.append(f"pct_logements_recents={pct(rec, tot)}")
        if pp:
            p21, p15 = num(pp, "pop21"), num(pp, "pop15")
            if p21 and p15 and p15 > 0:
                evo = round(((p21 / p15) ** (1 / 6) - 1) * 100, 2)  # taux annuel moyen 2015->2021
                sets.append(f"evolution_pop={evo}")
        if sets:
            out.append(f"update public.insee_communes set {', '.join(sets)} where insee='{c}';")

    print(f"-- {len(out)} communes enrichies / {len(codes)} (colonnes manquantes -> restent NULL = n.c.)")
    print("\n".join(out))


if __name__ == "__main__":
    main()
