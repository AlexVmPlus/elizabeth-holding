-- ============================================================================
-- Nettoyage des surfaces aberrantes dans public.etudes_marche.
-- Cause : parseSurface ne gerait pas les decimales FR ("160,2 m²" etait parse
--   comme 2 m² -> prix/m2 absurdes). Corrige dans lib.ts le 12/06/2026 ;
--   cette requete supprime les lignes deja corrompues (elles seront
--   re-scrapees proprement a la prochaine etude).
-- Seuil 9 m² : surface minimale legale de location en France -> toute ligne
--   en dessous est forcement un artefact de parsing.
-- A coller dans Supabase -> SQL Editor.
-- ============================================================================
delete from public.etudes_marche
where source = 'firecrawl' and surface < 9;

-- Verification (doit renvoyer 0) :
-- select count(*) from public.etudes_marche where source = 'firecrawl' and surface < 9;
