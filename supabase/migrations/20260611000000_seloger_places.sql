-- Cache des codes lieu classified-search SeLoger (format AD..FR..) par ville,
-- pour eviter de re-interroger l'autocomplete a chaque etude avec filtre annee.
-- La fonction scrape-etude lit/ecrit via la service_role (bypass RLS).
create table if not exists public.seloger_places (
  ville text primary key,             -- nom de ville en minuscules (cle)
  insee text,                         -- code INSEE (info)
  code_classified text not null,      -- code lieu classified-search (AD..FR..)
  updated_at timestamptz not null default now()
);

alter table public.seloger_places enable row level security;
-- Pas de policy publique : seule la service_role (Edge Function) y accede.
