-- Etudes manuelles : adresse + geolocalisation + insertion front (source=manuel)
alter table public.etudes_marche add column if not exists adresse text;
alter table public.etudes_marche add column if not exists lat double precision;
alter table public.etudes_marche add column if not exists lng double precision;
drop policy if exists "insert etudes manuelles" on public.etudes_marche;
create policy "insert etudes manuelles" on public.etudes_marche for insert with check (source = 'manuel');
drop policy if exists "ecriture ouverte em" on public.etudes_marche;
