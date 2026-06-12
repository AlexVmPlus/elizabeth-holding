-- Colonne TVA (5,5% zones ANRU/QPV, sinon 20%) sur les lots neufs
alter table public.programmes_neufs add column if not exists tva text;
