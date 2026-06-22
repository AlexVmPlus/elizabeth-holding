-- Identifiant de lot : meme valeur sur toutes les lignes d'un meme lancement
-- d'etude. Permet de regrouper l'historique par etude (1 etude = 1 ligne)
-- au lieu d'une ligne par annonce. Lignes anciennes sans etude_id : fallback
-- sur ville + transaction + horodatage a la minute cote front.
alter table public.etudes_marche add column if not exists etude_id text;
alter table public.programmes_neufs add column if not exists etude_id text;
