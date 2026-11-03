// Schema auth e storage simulados no PGlite, para os testes do schema rh (R01, R01b, R03).
// O storage aqui é só o pedaço do banco que o Supabase usa (storage.buckets e storage.objects com
// RLS ligada e os grants que o Supabase dá a anon/authenticated/service_role). O serviço de Storage
// em si (limite de tamanho, tipo MIME, link assinado, upsert e delete pela API) NÃO está aqui:
// nos testes de tela ele é imitado em JavaScript (t_rh_anexos.js).
// policyLarga: cria uma policy "legado_tudo" que libera tudo no storage.objects, para provar que as
// policies restritivas do R03 seguram o bucket rh-anexos mesmo se existir uma regra larga demais.

const AUTH_SIMULADO = `
  create schema auth;
  create function auth.uid() returns uuid language sql stable as $$
    select (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid $$;
  create function auth.jwt() returns jsonb language sql stable as $$
    select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb) $$;
  create role authenticated;
  create role anon;
  create role service_role bypassrls;
  grant usage on schema auth to anon, authenticated, service_role;
  grant execute on all functions in schema auth to anon, authenticated, service_role;
`;

function storageSimulado({ policyLarga = false } = {}) {
  return `
  create schema storage;
  create table storage.buckets (
    id text primary key, name text not null unique, owner uuid, public boolean default false,
    file_size_limit bigint, allowed_mime_types text[],
    created_at timestamptz default now(), updated_at timestamptz default now());
  create table storage.objects (
    id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets (id),
    name text, owner uuid, owner_id text, metadata jsonb, user_metadata jsonb, version text,
    created_at timestamptz default now(), updated_at timestamptz default now(),
    last_accessed_at timestamptz default now());
  create unique index bucketid_objname on storage.objects (bucket_id, name);
  alter table storage.buckets enable row level security;
  alter table storage.objects enable row level security;
  grant usage on schema storage to anon, authenticated, service_role;
  grant all on storage.buckets, storage.objects to anon, authenticated, service_role;

  -- Um bucket que já existia, com policies próprias (o R03 não pode mexer nelas)
  insert into storage.buckets (id, name, public, file_size_limit) values ('comprovantes', 'comprovantes', false, 5242880);
  create policy comprovantes_envia on storage.objects for insert to authenticated
    with check (bucket_id = 'comprovantes' and owner_id = auth.uid()::text);
  create policy comprovantes_le on storage.objects for select to authenticated
    using (bucket_id = 'comprovantes' and owner_id = auth.uid()::text);
  ${policyLarga ? `create policy legado_tudo on storage.objects for all to anon, authenticated using (true) with check (true);` : ''}
`;
}

module.exports = { AUTH_SIMULADO, storageSimulado };
