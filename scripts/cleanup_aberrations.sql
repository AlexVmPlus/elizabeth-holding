-- Purge colocations + aberrations (surface < 9 m2, location hors 5-60 EUR/m2) deja en base
delete from public.etudes_marche where source = 'firecrawl' and (titre ilike '%coloc%' or surface < 9 or (transaction = 'location' and (prix_m2_cc < 5 or prix_m2_cc > 60)));
