-- Colonnes DPE et GES (lettre A-G) sur les annonces location, remplies par le
-- scrape detail (phase loc-detail). charges / loyer_hc / prix_m2_hc existent deja.
alter table public.etudes_marche add column if not exists dpe text;
alter table public.etudes_marche add column if not exists ges text;
