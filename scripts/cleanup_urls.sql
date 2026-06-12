-- ============================================================================
-- Nettoyage des URLs d'annonces "sales" dans public.etudes_marche.
-- Cause : le parsing du markdown SeLoger capturait le titre du lien
--   `[texte](url "Seloger")` -> l'URL stockee finissait par ` "Seloger"`
--   (espace + guillemets) => le lien "Voir" pointait vers une URL cassee.
-- Une vraie URL ne contient jamais d'espace brut : on coupe au 1er espace.
-- (Corrige en amont dans lib.ts ; cette requete repare les lignes existantes.)
-- A coller dans Supabase -> SQL Editor.
-- ============================================================================
update public.etudes_marche
set url = rtrim(split_part(url, ' ', 1), '"''')
where url like '% %';

-- Verification (doit renvoyer 0) :
-- select count(*) from public.etudes_marche where url like '% %';
