-- Colonne meuble (true = annonce meublee) sur les annonces location
alter table public.etudes_marche add column if not exists meuble boolean;
