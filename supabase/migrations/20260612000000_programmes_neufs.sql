-- Table des lots de programmes neufs (selogerneuf.com), transaction vente_neuf
create table if not exists public.programmes_neufs (
  id bigint generated always as identity primary key,
  ville text not null,
  quartier text,
  code_postal text,
  transaction text not null default 'vente_neuf',
  nom_programme text,
  promoteur text,
  adresse text,
  date_livraison text,
  nb_pieces numeric,
  typologie text,
  surface numeric,
  prix_total numeric,
  prix_m2 numeric,
  url text,
  source text not null default 'selogerneuf',
  scraped_at timestamptz not null default now()
);

alter table public.programmes_neufs enable row level security;

drop policy if exists "lecture publique programmes_neufs" on public.programmes_neufs;
create policy "lecture publique programmes_neufs" on public.programmes_neufs
  for select using (true);
