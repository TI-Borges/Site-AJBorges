-- =============================================================================
-- R03 - Anexos de verdade no Dashboard RH               RASCUNHO - AINDA NÃO RODADO
--
-- Rode DEPOIS do R01 e do R01b.
--
-- Os documentos (ASO, rescisão, contrato) são sensíveis:
--   - bucket privado "rh-anexos" no Storage (public = false), até 10 MB por
--     arquivo, só PDF, JPG e PNG; para abrir, só link assinado (temporário);
--   - caminho no bucket sempre <processo_id>/<etapa_id>/<uuid>.<pdf|jpg|png>
--     (o nome digitado pelo usuário nunca vai para o caminho; ele fica só em
--     rh.anexos.nome_original);
--   - rh.anexos guarda os dados de cada arquivo; criado_em/criado_por/
--     criado_por_email, tamanho e tipo vêm do servidor;
--   - sem delete: "remover" = ativo false (o arquivo continua no bucket).
--
-- Acesso (igual às outras tabelas do schema rh):
--   'rh' e 'admin'  leem e enviam (tabela e bucket); "removem" (ativo = false);
--   'rh_restrito'   só lê (tabela e bucket, ou seja, só "Abrir");
--   diretoria, motorista e anon: nada.
--   Ninguém atualiza nem apaga objetos do rh-anexos pela API: não existe policy
--   de update/delete para esse bucket, e há policies RESTRITIVAS que barram
--   update/delete/envio fora da regra mesmo que outra policy do storage.objects
--   seja larga demais. As policies restritivas valem para o storage.objects
--   inteiro, mas para os outros buckets elas dão sempre "true" (não mudam nada).
--   Atenção: a service_role (chave secreta, painel do Supabase) passa por cima
--   de RLS, então ainda consegue apagar pelo painel. Isso não dá para barrar
--   com policy.
--
-- Anexos antigos: rh.etapas.anexos (só nomes) fica como está, sem apagar nada.
--   A tela mostra esses nomes como "registro antigo, sem arquivo". O bloco
--   principal só avisa quantos existem (raise notice) e põe um comentário na
--   coluna.
--
-- Como rodar (no SQL Editor, uma parte de cada vez):
--   R.0  retrato do public, do storage (fora o rh-anexos) e dos anexos antigos
--        ANTES (anote o resultado);
--   1-8  bloco principal (begin ... commit); pode rodar de novo;
--   R.1-R.7 conferências, uma por vez: cada uma termina com
--        raise exception 'RESULTADO ...' + rollback (nada fica salvo);
--   R.8  retrato DEPOIS (tem que dar igual ao R.0).
--   Obs.: depois deste arquivo a conferência R.1 do R01b passa a contar
--   policies=30, com_admin=30 e com_restrito=12 (são as 3 policies novas de
--   rh.anexos); o resto fica igual.
--
-- O que NÃO foi testado fora do Supabase (confira lá, depois de rodar):
--   - as conferências R.2-R.7 gravam direto em storage.objects (como o serviço
--     de Storage faz, com o papel authenticated e o JWT). Se algum trigger
--     interno do Supabase no storage.objects recusar o insert, o RESULTADO vai
--     mostrar um erro diferente do esperado: me mande o texto;
--   - limite de 10 MB e tipos aceitos: quem aplica é o serviço de Storage (o
--     banco só guarda a configuração, conferida no R.1);
--   - link assinado (createSignedUrl), upsert e delete pela API, e o painel:
--     confira no navegador (passos no fim da resposta do commit).
-- =============================================================================


-- -----------------------------------------------------------------------------
-- R.0 Retrato ANTES (anote; o R.8 repete e tem que dar igual)
--     retrato_public: mesmo cálculo do R01/R01b; retrato_storage: buckets e
--     policies do storage que não são do rh-anexos; anexos_antigos: etapas com
--     nomes antigos em rh.etapas.anexos.
-- -----------------------------------------------------------------------------
with publico as (
  select 'rel ' || c.relname || ' ' || c.relkind::text || ' ' || coalesce(c.relacl::text, '') || ' ' || c.relrowsecurity as x
    from pg_class c where c.relnamespace = 'public'::regnamespace
  union all
  select 'col ' || c.relname || '.' || a.attname || ' ' || format_type(a.atttypid, a.atttypmod) || ' ' || coalesce(a.attacl::text, '')
    from pg_attribute a join pg_class c on c.oid = a.attrelid
   where c.relnamespace = 'public'::regnamespace and a.attnum > 0 and not a.attisdropped
  union all
  select 'fn ' || p.oid::regprocedure::text || ' ' || md5(p.prosrc) || ' ' || coalesce(p.proacl::text, '') || ' '
         || p.prosecdef || ' ' || coalesce(array_to_string(p.proconfig, ','), '')
    from pg_proc p where p.pronamespace = 'public'::regnamespace
  union all
  select 'pol ' || tablename || ' ' || policyname || ' ' || cmd || ' ' || array_to_string(roles, ',') || ' '
         || coalesce(qual, '') || ' ' || coalesce(with_check, '')
    from pg_policies where schemaname = 'public'
  union all
  select 'trg ' || c.relname || ' ' || t.tgname || ' ' || t.tgenabled::text
    from pg_trigger t join pg_class c on c.oid = t.tgrelid
   where c.relnamespace = 'public'::regnamespace and not t.tgisinternal
  union all
  select 'nsp ' || coalesce(n.nspacl::text, '') from pg_namespace n where n.nspname = 'public'
  union all
  select 'def ' || d.defaclnamespace::text || ' ' || d.defaclobjtype::text || ' ' || d.defaclacl::text
    from pg_default_acl d where d.defaclnamespace not in (select oid from pg_namespace where nspname in ('torre', 'rh'))
), armazenamento as (
  select 'pol ' || tablename || ' ' || policyname || ' ' || cmd || ' ' || permissive || ' ' || array_to_string(roles, ',') || ' '
         || coalesce(qual, '') || ' ' || coalesce(with_check, '') as x
    from pg_policies where schemaname = 'storage' and policyname not like 'rh\_anexos\_%'
  union all
  select 'bkt ' || b.id || ' ' || coalesce(b.public::text, '') || ' ' || coalesce(b.file_size_limit::text, '') || ' '
         || coalesce(array_to_string(b.allowed_mime_types, ','), '')
    from storage.buckets b where b.id <> 'rh-anexos'
)
select (select md5(string_agg(x, E'\n' order by x)) from publico) as retrato_public,
       (select count(*) from publico) as itens,
       (select coalesce(md5(string_agg(x, E'\n' order by x)), 'vazio') || ' (' || count(*) || ' itens)' from armazenamento) as retrato_storage,
       (select count(*) || ' etapas, ' || coalesce(sum(cardinality(e.anexos)), 0) || ' nomes, md5 '
               || coalesce(md5(string_agg(e.id::text || ':' || array_to_string(e.anexos, '|'), ',' order by e.id)), 'vazio')
          from rh.etapas e where cardinality(e.anexos) > 0) as anexos_antigos;


-- =============================================================================
-- BLOCO PRINCIPAL (1 a 8)
-- =============================================================================
begin;


-- -----------------------------------------------------------------------------
-- 1. Bucket privado (pode rodar de novo: reaplica privado, limite e tipos)
-- -----------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('rh-anexos', 'rh-anexos', false, 10485760, array['application/pdf', 'image/jpeg', 'image/png'])
on conflict (id) do update
  set public = false,
      file_size_limit = 10485760,
      allowed_mime_types = array['application/pdf', 'image/jpeg', 'image/png'];


-- -----------------------------------------------------------------------------
-- 2. Tabela rh.anexos
--    caminho: <processo_id>/<etapa_id>/<uuid>.<pdf|jpg|png> (só minúsculas,
--    como o uuid do Postgres e o crypto.randomUUID() do navegador).
-- -----------------------------------------------------------------------------
create table if not exists rh.anexos (
  id               uuid primary key default gen_random_uuid(),
  etapa_id         uuid not null references rh.etapas (id),
  caminho          text not null unique
                   check (caminho ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(pdf|jpg|png)$'),
  nome_original    text not null check (length(btrim(nome_original)) between 1 and 255),
  tipo             text not null check (tipo in ('application/pdf', 'image/jpeg', 'image/png')),
  tamanho          bigint not null check (tamanho between 1 and 10485760),
  ativo            boolean not null default true,
  criado_em        timestamptz not null default now(),
  criado_por       uuid,
  criado_por_email text,
  atualizado_em    timestamptz not null default now(),
  atualizado_por   uuid,
  check ((tipo = 'application/pdf' and caminho like '%.pdf')
      or (tipo = 'image/jpeg' and caminho like '%.jpg')
      or (tipo = 'image/png' and caminho like '%.png'))
);
create index if not exists anexos_etapa on rh.anexos (etapa_id, criado_em);


-- -----------------------------------------------------------------------------
-- 3. Funções
-- -----------------------------------------------------------------------------

-- Caminho no padrão e apontando para uma etapa ativa daquele processo (não
-- cancelado). Roda com o papel de quem chama (sem security definer): usa a
-- leitura que a RLS do schema rh já dá.
create or replace function rh.anexo_caminho_valido(p_caminho text)
returns boolean language plpgsql stable set search_path = '' as $$
begin
  if p_caminho is null or p_caminho !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(pdf|jpg|png)$' then
    return false;
  end if;
  return exists (
    select 1
      from rh.etapas e
      join rh.processos p on p.id = e.processo_id
     where e.id = split_part(p_caminho, '/', 2)::uuid
       and p.id = split_part(p_caminho, '/', 1)::uuid
       and e.ativo and not p.cancelado);
end $$;

-- rh.anexos: no insert, o caminho tem que ser da etapa informada e o arquivo
-- tem que já estar no bucket; tamanho e tipo vêm do Storage (metadata) e o
-- e-mail de quem enviou, do JWT. No update, só "ativo" muda.
create or replace function rh.anexos_regras()
returns trigger language plpgsql set search_path = '' as $$
declare
  v_caminho_ok boolean;
  v_meta jsonb;
begin
  if tg_op = 'INSERT' then
    -- Dois ifs: o cast para uuid só roda depois de o caminho passar no padrão
    v_caminho_ok := rh.anexo_caminho_valido(new.caminho);
    if v_caminho_ok then
      v_caminho_ok := split_part(new.caminho, '/', 2)::uuid = new.etapa_id;
    end if;
    if not coalesce(v_caminho_ok, false) then
      raise exception 'rh.anexos: caminho fora do padrão <processo_id>/<etapa_id>/<uuid>.<pdf|jpg|png> ou de outra etapa'
        using errcode = 'insufficient_privilege';
    end if;
    select o.metadata into v_meta
      from storage.objects o
     where o.bucket_id = 'rh-anexos' and o.name = new.caminho;
    if not found then
      raise exception 'rh.anexos: o arquivo não está no bucket rh-anexos' using errcode = 'insufficient_privilege';
    end if;
    new.tamanho := coalesce((v_meta ->> 'size')::bigint, new.tamanho);
    new.tipo := coalesce(nullif(v_meta ->> 'mimetype', ''), new.tipo);
    new.criado_por_email := nullif((select auth.jwt()) ->> 'email', '');
  elsif (new.etapa_id, new.caminho, new.nome_original, new.tipo, new.tamanho, new.criado_por_email)
        is distinct from
        (old.etapa_id, old.caminho, old.nome_original, old.tipo, old.tamanho, old.criado_por_email) then
    raise exception 'rh.anexos: só dá para marcar como removido (ativo); o resto não muda'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;


-- -----------------------------------------------------------------------------
-- 4. Triggers (mesmos nomes e ordem das outras tabelas do schema rh)
-- -----------------------------------------------------------------------------
drop trigger if exists rh_00_sem_delete on rh.anexos;
create trigger rh_00_sem_delete before delete on rh.anexos
  for each row execute function rh.bloquear_alteracao();
drop trigger if exists rh_00_sem_truncate on rh.anexos;
create trigger rh_00_sem_truncate before truncate on rh.anexos
  for each statement execute function rh.bloquear_alteracao();
drop trigger if exists rh_10_carimbar on rh.anexos;
create trigger rh_10_carimbar before insert or update on rh.anexos
  for each row execute function rh.carimbar();
drop trigger if exists rh_20_regras on rh.anexos;
create trigger rh_20_regras before insert or update on rh.anexos
  for each row execute function rh.anexos_regras();
drop trigger if exists rh_90_auditar on rh.anexos;
create trigger rh_90_auditar after update on rh.anexos
  for each row execute function rh.auditar();


-- -----------------------------------------------------------------------------
-- 5. RLS e policies de rh.anexos (igual às outras tabelas; sem delete)
-- -----------------------------------------------------------------------------
alter table rh.anexos enable row level security;

drop policy if exists rh_le on rh.anexos;
create policy rh_le on rh.anexos for select to authenticated
  using (rh.eh_rh() or rh.eh_admin() or rh.eh_rh_restrito());

drop policy if exists rh_insere on rh.anexos;
create policy rh_insere on rh.anexos for insert to authenticated
  with check (rh.eh_rh() or rh.eh_admin());

drop policy if exists rh_atualiza on rh.anexos;
create policy rh_atualiza on rh.anexos for update to authenticated
  using (rh.eh_rh() or rh.eh_admin()) with check (rh.eh_rh() or rh.eh_admin());


-- -----------------------------------------------------------------------------
-- 6. Permissões (anon, public e service_role: nada; delete nunca)
-- -----------------------------------------------------------------------------
revoke all on rh.anexos from public, anon, authenticated, service_role;
grant select, insert, update on rh.anexos to authenticated;

revoke all on function rh.anexo_caminho_valido(text) from public, anon, authenticated, service_role;
revoke all on function rh.anexos_regras() from public, anon, authenticated, service_role;
grant execute on function rh.anexo_caminho_valido(text) to authenticated;


-- -----------------------------------------------------------------------------
-- 7. Policies do storage.objects SÓ para o bucket rh-anexos
--    Permissivas (quem pode): ler = rh, admin e rh_restrito; enviar = rh e
--    admin, só no caminho do padrão. Nenhuma de update ou delete.
--    Restritivas (trava): para o rh-anexos exigem a mesma regra e proíbem
--    update e delete, mesmo que exista outra policy permissiva larga. Para os
--    outros buckets a condição começa com bucket_id <> 'rh-anexos' (true).
--    A trava do anon não chama função do schema rh (anon não tem acesso a ele).
-- -----------------------------------------------------------------------------
drop policy if exists rh_anexos_le on storage.objects;
create policy rh_anexos_le on storage.objects for select to authenticated
  using (bucket_id = 'rh-anexos' and (rh.eh_rh() or rh.eh_admin() or rh.eh_rh_restrito()));

drop policy if exists rh_anexos_envia on storage.objects;
create policy rh_anexos_envia on storage.objects for insert to authenticated
  with check (bucket_id = 'rh-anexos' and (rh.eh_rh() or rh.eh_admin()) and rh.anexo_caminho_valido(name));

drop policy if exists rh_anexos_trava_le on storage.objects;
create policy rh_anexos_trava_le on storage.objects as restrictive for select to authenticated
  using (bucket_id <> 'rh-anexos' or rh.eh_rh() or rh.eh_admin() or rh.eh_rh_restrito());

drop policy if exists rh_anexos_trava_envia on storage.objects;
create policy rh_anexos_trava_envia on storage.objects as restrictive for insert to authenticated
  with check (bucket_id <> 'rh-anexos' or ((rh.eh_rh() or rh.eh_admin()) and rh.anexo_caminho_valido(name)));

drop policy if exists rh_anexos_trava_altera on storage.objects;
create policy rh_anexos_trava_altera on storage.objects as restrictive for update to authenticated
  using (bucket_id <> 'rh-anexos') with check (bucket_id <> 'rh-anexos');

drop policy if exists rh_anexos_trava_apaga on storage.objects;
create policy rh_anexos_trava_apaga on storage.objects as restrictive for delete to authenticated
  using (bucket_id <> 'rh-anexos');

drop policy if exists rh_anexos_trava_anon on storage.objects;
create policy rh_anexos_trava_anon on storage.objects as restrictive for all to anon
  using (bucket_id <> 'rh-anexos') with check (bucket_id <> 'rh-anexos');


-- -----------------------------------------------------------------------------
-- 8. Anexos antigos (só nomes): a coluna fica como está; só comentário e aviso
-- -----------------------------------------------------------------------------
comment on column rh.etapas.anexos is
  'Antigo (antes do R03): só nomes de arquivo, sem o arquivo. Não apagar. Os anexos com arquivo ficam em rh.anexos e no bucket rh-anexos.';

do $$
declare
  v_etapas bigint;
  v_nomes bigint;
begin
  select count(*), coalesce(sum(cardinality(anexos)), 0) into v_etapas, v_nomes
    from rh.etapas where cardinality(anexos) > 0;
  raise notice 'AVISO: % etapa(s) com % anexo(s) antigo(s) (só o nome, sem arquivo). Ficam como estão e aparecem na tela como "registro antigo, sem arquivo".',
    v_etapas, v_nomes;
end $$;


commit;


-- =============================================================================
-- CONFERÊNCIAS (rode uma por vez; cada uma termina com RESULTADO + rollback)
-- Usuários de teste (só no JWT, nada é criado em auth.users):
--   rh ...a1 | rh_restrito ...b2 | admin ...c3 | diretoria ...d4 | motorista ...e5
-- O "envio" é um insert em storage.objects com o papel authenticated e o JWT,
-- que é o que o serviço de Storage faz por baixo.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- R.1 Estrutura (esperado: bucket=rh-anexos public:false limite:10485760 tipos:application/pdf,image/jpeg,image/png | anexos_rls=true | anexos_privilegios=INSERT,SELECT,UPDATE | anexos_para_anon=0 | anexos_para_service_role=0 | delete_ou_truncate=0 | triggers=rh_00_sem_delete,rh_00_sem_truncate,rh_10_carimbar,rh_20_regras,rh_90_auditar | policies_tabela=rh_atualiza:UPDATE,rh_insere:INSERT,rh_le:SELECT | policies_storage=rh_anexos_envia:INSERT:PERMISSIVE:authenticated, rh_anexos_le:SELECT:PERMISSIVE:authenticated, rh_anexos_trava_altera:UPDATE:RESTRICTIVE:authenticated, rh_anexos_trava_anon:ALL:RESTRICTIVE:anon, rh_anexos_trava_apaga:DELETE:RESTRICTIVE:authenticated, rh_anexos_trava_envia:INSERT:RESTRICTIVE:authenticated, rh_anexos_trava_le:SELECT:RESTRICTIVE:authenticated | storage_rls=true | funcoes_para_anon=0 | caminho_valido=definer:false search_path="" | coluna_antiga=text[])
-- -----------------------------------------------------------------------------
do $$
begin
  raise exception 'RESULTADO: bucket=% | anexos_rls=% | anexos_privilegios=% | anexos_para_anon=% | anexos_para_service_role=% | delete_ou_truncate=% | triggers=% | policies_tabela=% | policies_storage=% | storage_rls=% | funcoes_para_anon=% | caminho_valido=% | coluna_antiga=%',
    (select coalesce(string_agg(b.id || ' public:' || b.public || ' limite:' || coalesce(b.file_size_limit::text, 'SEM')
                                || ' tipos:' || coalesce(array_to_string(b.allowed_mime_types, ','), 'TODOS'), ', '), 'NÃO EXISTE')
       from storage.buckets b where b.id = 'rh-anexos'),
    (select c.relrowsecurity::text from pg_class c where c.oid = 'rh.anexos'::regclass),
    (select string_agg(a.privilege_type, ',' order by a.privilege_type) from pg_class c, aclexplode(c.relacl) a
      where c.oid = 'rh.anexos'::regclass and a.grantee = 'authenticated'::regrole::oid),
    (select count(*) from pg_class c, aclexplode(c.relacl) a
      where c.oid = 'rh.anexos'::regclass and a.grantee in (0::oid, 'anon'::regrole::oid)),
    (select count(*) from pg_class c, aclexplode(c.relacl) a
      where c.oid = 'rh.anexos'::regclass and a.grantee = 'service_role'::regrole::oid),
    (select count(*) from pg_class c, aclexplode(c.relacl) a
      where c.relnamespace = 'rh'::regnamespace and a.privilege_type in ('DELETE', 'TRUNCATE')
        and a.grantee <> c.relowner),
    (select string_agg(t.tgname, ',' order by t.tgname) from pg_trigger t
      where t.tgrelid = 'rh.anexos'::regclass and not t.tgisinternal),
    (select string_agg(policyname || ':' || cmd, ',' order by policyname) from pg_policies
      where schemaname = 'rh' and tablename = 'anexos'),
    (select string_agg(policyname || ':' || cmd || ':' || permissive || ':' || array_to_string(roles, ','), ', ' order by policyname)
       from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname like 'rh\_anexos\_%'),
    (select c.relrowsecurity::text from pg_class c where c.oid = 'storage.objects'::regclass),
    (select count(*) from pg_proc p where p.pronamespace = 'rh'::regnamespace and has_function_privilege('anon', p.oid, 'execute')),
    (select 'definer:' || p.prosecdef || ' ' || coalesce(array_to_string(p.proconfig, ','), 'SEM search_path')
       from pg_proc p where p.oid = 'rh.anexo_caminho_valido(text)'::regprocedure),
    (select format_type(a.atttypid, a.atttypmod) from pg_attribute a
      where a.attrelid = 'rh.etapas'::regclass and a.attname = 'anexos' and not a.attisdropped);
end $$;


-- -----------------------------------------------------------------------------
-- R.2 Anon não lê nem envia (esperado: le_storage=nada | envia_storage=bloqueado | le_tabela=bloqueado | arquivo_existe=true)
--     Antes, o 'rh' envia 1 arquivo, para provar que existe o que ler.
-- -----------------------------------------------------------------------------
begin;
do $$
declare
  v_colab uuid;
  v_proc uuid;
  v_etapa uuid;
begin
  insert into rh.colaboradores (nome, vinculo) values ('Teste R03', 'CLT') returning id into v_colab;
  insert into rh.processos (colaborador_id, modelo_id, modelo_nome)
  select v_colab, m.id, m.nome from rh.modelos m where m.chave = 'rescisao_clt' returning id into v_proc;
  insert into rh.etapas (processo_id, ordem, nome) values (v_proc, 1, 'Assinaturas') returning id into v_etapa;
  perform set_config('r03.pasta', v_proc || '/' || v_etapa || '/', true);
  perform set_config('r03.etapa', v_etapa::text, true);
  perform set_config('r03.caminho', v_proc || '/' || v_etapa || '/' || gen_random_uuid() || '.pdf', true);
end $$;
select set_config('request.jwt.claims',
         json_build_object('sub', '00000000-0000-0000-0000-0000000000a1', 'role', 'authenticated',
                           'email', 'rh@teste.local',
                           'app_metadata', json_build_object('role', 'rh'))::text, true);
set local role authenticated;
do $$
begin
  insert into storage.objects (bucket_id, name, metadata)
  values ('rh-anexos', current_setting('r03.caminho'), '{"size": 2048, "mimetype": "application/pdf"}');
  insert into rh.anexos (etapa_id, caminho, nome_original, tipo, tamanho)
  values (current_setting('r03.etapa')::uuid, current_setting('r03.caminho'), 'ASO.pdf', 'application/pdf', 2048);
  perform set_config('r03.existe', exists (select 1 from storage.objects
    where bucket_id = 'rh-anexos' and name = current_setting('r03.caminho'))::text, true);
end $$;
reset role;
select set_config('request.jwt.claims', '', true);
set local role anon;
do $$
declare
  v_n bigint := 0;
  v_le text;
  v_envia text := 'LIBERADO';
  v_tabela text := 'LIBERADO';
begin
  begin
    select count(*) into v_n from storage.objects where bucket_id = 'rh-anexos';
  exception when insufficient_privilege then
    v_n := 0;
  end;
  v_le := case when v_n = 0 then 'nada' else v_n || ' linhas' end;
  begin
    insert into storage.objects (bucket_id, name, metadata)
    values ('rh-anexos', current_setting('r03.pasta') || gen_random_uuid() || '.pdf', '{"size": 10, "mimetype": "application/pdf"}');
  exception when insufficient_privilege then
    v_envia := 'bloqueado';
  end;
  begin
    perform count(*) from rh.anexos;
  exception when insufficient_privilege then
    v_tabela := 'bloqueado';
  end;
  raise exception 'RESULTADO (nada foi salvo): le_storage=% | envia_storage=% | le_tabela=% | arquivo_existe=%',
    v_le, v_envia, v_tabela, current_setting('r03.existe');
end $$;
reset role;
rollback;


-- -----------------------------------------------------------------------------
-- R.3 Motorista e diretoria não leem nem enviam (esperado: motorista=le_storage:nada link:nada envia_storage:bloqueado le_tabela:0 grava_tabela:bloqueado | diretoria=le_storage:nada link:nada envia_storage:bloqueado le_tabela:0 grava_tabela:bloqueado | arquivo_existe=true)
--     "link" = achar o arquivo pelo caminho, que é o que o createSignedUrl faz.
-- -----------------------------------------------------------------------------
begin;
do $$
declare
  v_colab uuid;
  v_proc uuid;
  v_etapa uuid;
begin
  insert into rh.colaboradores (nome, vinculo) values ('Teste R03', 'CLT') returning id into v_colab;
  insert into rh.processos (colaborador_id, modelo_id, modelo_nome)
  select v_colab, m.id, m.nome from rh.modelos m where m.chave = 'rescisao_clt' returning id into v_proc;
  insert into rh.etapas (processo_id, ordem, nome) values (v_proc, 1, 'Assinaturas') returning id into v_etapa;
  perform set_config('r03.pasta', v_proc || '/' || v_etapa || '/', true);
  perform set_config('r03.etapa', v_etapa::text, true);
  perform set_config('r03.caminho', v_proc || '/' || v_etapa || '/' || gen_random_uuid() || '.pdf', true);
  perform set_config('r03.caminho2', v_proc || '/' || v_etapa || '/' || gen_random_uuid() || '.pdf', true);
end $$;
select set_config('request.jwt.claims',
         json_build_object('sub', '00000000-0000-0000-0000-0000000000a1', 'role', 'authenticated',
                           'email', 'rh@teste.local',
                           'app_metadata', json_build_object('role', 'rh'))::text, true);
set local role authenticated;
do $$
declare
  v_papel text;
  v_n bigint;
  v_envia text;
  v_grava text;
  v_res text := '';
begin
  -- O 'rh' envia 2 arquivos e registra o 1º (o 2º fica para a tentativa de registro)
  insert into storage.objects (bucket_id, name, metadata)
  values ('rh-anexos', current_setting('r03.caminho'), '{"size": 2048, "mimetype": "application/pdf"}'),
         ('rh-anexos', current_setting('r03.caminho2'), '{"size": 1024, "mimetype": "application/pdf"}');
  insert into rh.anexos (etapa_id, caminho, nome_original, tipo, tamanho)
  values (current_setting('r03.etapa')::uuid, current_setting('r03.caminho'), 'ASO.pdf', 'application/pdf', 2048);

  foreach v_papel in array array['motorista', 'diretoria'] loop
    perform set_config('request.jwt.claims',
      json_build_object('sub', case v_papel when 'motorista' then '00000000-0000-0000-0000-0000000000e5'
                                            else '00000000-0000-0000-0000-0000000000d4' end,
                        'role', 'authenticated',
                        'app_metadata', json_build_object('role', v_papel))::text, true);
    v_res := v_res || v_papel || '=';
    select count(*) into v_n from storage.objects where bucket_id = 'rh-anexos';
    v_res := v_res || 'le_storage:' || case when v_n = 0 then 'nada' else v_n || '_linhas' end;
    select count(*) into v_n from storage.objects where bucket_id = 'rh-anexos' and name = current_setting('r03.caminho');
    v_res := v_res || ' link:' || case when v_n = 0 then 'nada' else 'ACHOU' end;
    begin
      insert into storage.objects (bucket_id, name, metadata)
      values ('rh-anexos', current_setting('r03.pasta') || gen_random_uuid() || '.pdf', '{"size": 10, "mimetype": "application/pdf"}');
      v_envia := 'LIBERADO';
    exception when insufficient_privilege then
      v_envia := 'bloqueado';
    end;
    select count(*) into v_n from rh.anexos;
    begin
      insert into rh.anexos (etapa_id, caminho, nome_original, tipo, tamanho)
      values (current_setting('r03.etapa')::uuid, current_setting('r03.caminho2'), 'Invasor.pdf', 'application/pdf', 1024);
      v_grava := 'LIBERADO';
    exception when insufficient_privilege then
      v_grava := 'bloqueado';
    end;
    v_res := v_res || ' envia_storage:' || v_envia || ' le_tabela:' || v_n || ' grava_tabela:' || v_grava || ' | ';
  end loop;

  perform set_config('request.jwt.claims',
    json_build_object('sub', '00000000-0000-0000-0000-0000000000a1', 'role', 'authenticated',
                      'app_metadata', json_build_object('role', 'rh'))::text, true);
  raise exception 'RESULTADO (nada foi salvo): %arquivo_existe=%', v_res,
    exists (select 1 from storage.objects where bucket_id = 'rh-anexos' and name = current_setting('r03.caminho'))::text;
end $$;
reset role;
rollback;


-- -----------------------------------------------------------------------------
-- R.4 'rh' e 'admin' enviam e leem (esperado: rh=envia:ok le_arquivo:1 le_tabela:1 carimbos_do_servidor:true tamanho_tipo_do_storage:true remover:1 linha auditoria:1 arquivo_continua:true | admin=envia:ok le_arquivo:1 le_tabela:1 carimbos_do_servidor:true tamanho_tipo_do_storage:true remover:1 linha auditoria:1 arquivo_continua:true | ativos=0 de 2)
--     O navegador manda tamanho 1, tipo errado e e-mail/autor falsos: vale o
--     que o Storage e o JWT dizem.
-- -----------------------------------------------------------------------------
begin;
do $$
declare
  v_colab uuid;
  v_proc uuid;
  v_etapa uuid;
begin
  insert into rh.colaboradores (nome, vinculo) values ('Teste R03', 'CLT') returning id into v_colab;
  insert into rh.processos (colaborador_id, modelo_id, modelo_nome)
  select v_colab, m.id, m.nome from rh.modelos m where m.chave = 'rescisao_clt' returning id into v_proc;
  insert into rh.etapas (processo_id, ordem, nome) values (v_proc, 1, 'Assinaturas') returning id into v_etapa;
  perform set_config('r03.pasta', v_proc || '/' || v_etapa || '/', true);
  perform set_config('r03.etapa', v_etapa::text, true);
end $$;
set local role authenticated;
do $$
declare
  v_papel text;
  v_sub uuid;
  v_cam text;
  v_anexo rh.anexos;
  v_n bigint;
  v_res text := '';
begin
  foreach v_papel in array array['rh', 'admin'] loop
    v_sub := case v_papel when 'rh' then '00000000-0000-0000-0000-0000000000a1'
                          else '00000000-0000-0000-0000-0000000000c3' end;
    perform set_config('request.jwt.claims',
      json_build_object('sub', v_sub, 'role', 'authenticated', 'email', v_papel || '@teste.local',
                        'app_metadata', json_build_object('role', v_papel))::text, true);
    v_cam := current_setting('r03.pasta') || gen_random_uuid() || '.jpg';

    insert into storage.objects (bucket_id, name, metadata)
    values ('rh-anexos', v_cam, '{"size": 345678, "mimetype": "image/jpeg"}');
    insert into rh.anexos (etapa_id, caminho, nome_original, tipo, tamanho, criado_por, criado_por_email, criado_em)
    values (current_setting('r03.etapa')::uuid, v_cam, 'Contrato assinado.jpg', 'image/png', 1,
            gen_random_uuid(), 'falso@invasor', timestamptz '2000-01-01')
    returning * into v_anexo;
    v_res := v_res || v_papel || '=envia:ok';

    select count(*) into v_n from storage.objects where bucket_id = 'rh-anexos' and name = v_cam;
    v_res := v_res || ' le_arquivo:' || v_n;
    select count(*) into v_n from rh.anexos where id = v_anexo.id;
    v_res := v_res || ' le_tabela:' || v_n;
    v_res := v_res || ' carimbos_do_servidor:'
             || (v_anexo.criado_por = v_sub and v_anexo.criado_por_email = v_papel || '@teste.local'
                 and v_anexo.criado_em = now())::text;
    v_res := v_res || ' tamanho_tipo_do_storage:' || (v_anexo.tamanho = 345678 and v_anexo.tipo = 'image/jpeg')::text;

    update rh.anexos set ativo = false where id = v_anexo.id;
    get diagnostics v_n = row_count;
    v_res := v_res || ' remover:' || v_n || ' linha';
    select count(*) into v_n from rh.auditoria where tabela = 'anexos' and registro_id = v_anexo.id
       and antes ->> 'ativo' = 'true' and depois ->> 'ativo' = 'false';
    v_res := v_res || ' auditoria:' || v_n;
    v_res := v_res || ' arquivo_continua:'
             || exists (select 1 from storage.objects where bucket_id = 'rh-anexos' and name = v_cam)::text || ' | ';
  end loop;
  raise exception 'RESULTADO (nada foi salvo): %ativos=% de %', v_res,
    (select count(*) from rh.anexos where ativo), (select count(*) from rh.anexos);
end $$;
reset role;
rollback;


-- -----------------------------------------------------------------------------
-- R.5 'rh_restrito' só lê (esperado: le_arquivo=1 | link=achou | le_tabela=1 | envia_storage=bloqueado | grava_tabela=bloqueado | remover=0 linhas | le_auditoria=0 linhas)
-- -----------------------------------------------------------------------------
begin;
do $$
declare
  v_colab uuid;
  v_proc uuid;
  v_etapa uuid;
begin
  insert into rh.colaboradores (nome, vinculo) values ('Teste R03', 'CLT') returning id into v_colab;
  insert into rh.processos (colaborador_id, modelo_id, modelo_nome)
  select v_colab, m.id, m.nome from rh.modelos m where m.chave = 'rescisao_clt' returning id into v_proc;
  insert into rh.etapas (processo_id, ordem, nome) values (v_proc, 1, 'Assinaturas') returning id into v_etapa;
  perform set_config('r03.pasta', v_proc || '/' || v_etapa || '/', true);
  perform set_config('r03.etapa', v_etapa::text, true);
  perform set_config('r03.caminho', v_proc || '/' || v_etapa || '/' || gen_random_uuid() || '.pdf', true);
  perform set_config('r03.caminho2', v_proc || '/' || v_etapa || '/' || gen_random_uuid() || '.pdf', true);
end $$;
select set_config('request.jwt.claims',
         json_build_object('sub', '00000000-0000-0000-0000-0000000000a1', 'role', 'authenticated',
                           'email', 'rh@teste.local',
                           'app_metadata', json_build_object('role', 'rh'))::text, true);
set local role authenticated;
do $$
declare
  v_anexo uuid;
begin
  insert into storage.objects (bucket_id, name, metadata)
  values ('rh-anexos', current_setting('r03.caminho'), '{"size": 2048, "mimetype": "application/pdf"}'),
         ('rh-anexos', current_setting('r03.caminho2'), '{"size": 1024, "mimetype": "application/pdf"}');
  insert into rh.anexos (etapa_id, caminho, nome_original, tipo, tamanho)
  values (current_setting('r03.etapa')::uuid, current_setting('r03.caminho'), 'ASO.pdf', 'application/pdf', 2048)
  returning id into v_anexo;
  update rh.colaboradores set cargo = 'Analista' where nome = 'Teste R03';
  perform set_config('r03.anexo', v_anexo::text, true);
end $$;
select set_config('request.jwt.claims',
         json_build_object('sub', '00000000-0000-0000-0000-0000000000b2', 'role', 'authenticated',
                           'email', 'rh.restrito@teste.local',
                           'app_metadata', json_build_object('role', 'rh_restrito'))::text, true);
do $$
declare
  v_n bigint;
  v_envia text := 'LIBERADO';
  v_grava text := 'LIBERADO';
  v_remover bigint;
begin
  begin
    insert into storage.objects (bucket_id, name, metadata)
    values ('rh-anexos', current_setting('r03.pasta') || gen_random_uuid() || '.pdf', '{"size": 10, "mimetype": "application/pdf"}');
  exception when insufficient_privilege then
    v_envia := 'bloqueado';
  end;
  begin
    insert into rh.anexos (etapa_id, caminho, nome_original, tipo, tamanho)
    values (current_setting('r03.etapa')::uuid, current_setting('r03.caminho2'), 'Do restrito.pdf', 'application/pdf', 1024);
  exception when insufficient_privilege then
    v_grava := 'bloqueado';
  end;
  update rh.anexos set ativo = false where id = current_setting('r03.anexo')::uuid;
  get diagnostics v_remover = row_count;
  select count(*) into v_n from storage.objects where bucket_id = 'rh-anexos';
  raise exception 'RESULTADO (nada foi salvo): le_arquivo=% | link=% | le_tabela=% | envia_storage=% | grava_tabela=% | remover=% linhas | le_auditoria=% linhas',
    (select count(*) from storage.objects where bucket_id = 'rh-anexos' and name = current_setting('r03.caminho')),
    case when exists (select 1 from storage.objects where bucket_id = 'rh-anexos' and name = current_setting('r03.caminho'))
         then 'achou' else 'NADA' end,
    (select count(*) from rh.anexos where ativo),
    v_envia, v_grava, v_remover,
    (select count(*) from rh.auditoria);
end $$;
reset role;
rollback;


-- -----------------------------------------------------------------------------
-- R.6 Ninguém apaga nem sobrescreve (esperado: rh=apagar:bloqueado alterar:bloqueado renomear:bloqueado sobrescrever:bloqueado upsert:bloqueado apagar_registro:bloqueado alterar_registro:bloqueado | admin=apagar:bloqueado alterar:bloqueado renomear:bloqueado sobrescrever:bloqueado upsert:bloqueado apagar_registro:bloqueado alterar_registro:bloqueado | rh_restrito=apagar:bloqueado alterar:bloqueado renomear:bloqueado sobrescrever:bloqueado upsert:bloqueado apagar_registro:bloqueado alterar_registro:bloqueado | arquivo_intacto=true | dono_apaga_registro=bloqueado | dono_trunca=bloqueado | registro_intacto=true)
-- -----------------------------------------------------------------------------
begin;
do $$
declare
  v_colab uuid;
  v_proc uuid;
  v_etapa uuid;
begin
  insert into rh.colaboradores (nome, vinculo) values ('Teste R03', 'CLT') returning id into v_colab;
  insert into rh.processos (colaborador_id, modelo_id, modelo_nome)
  select v_colab, m.id, m.nome from rh.modelos m where m.chave = 'rescisao_clt' returning id into v_proc;
  insert into rh.etapas (processo_id, ordem, nome) values (v_proc, 1, 'Assinaturas') returning id into v_etapa;
  perform set_config('r03.pasta', v_proc || '/' || v_etapa || '/', true);
  perform set_config('r03.etapa', v_etapa::text, true);
  perform set_config('r03.caminho', v_proc || '/' || v_etapa || '/' || gen_random_uuid() || '.pdf', true);
end $$;
select set_config('request.jwt.claims',
         json_build_object('sub', '00000000-0000-0000-0000-0000000000a1', 'role', 'authenticated',
                           'email', 'rh@teste.local',
                           'app_metadata', json_build_object('role', 'rh'))::text, true);
set local role authenticated;
do $$
declare
  v_cam text := current_setting('r03.caminho');
  v_anexo uuid;
  v_papel text;
  v_n bigint;
  v_res text := '';
  v_r text;
begin
  insert into storage.objects (bucket_id, name, metadata)
  values ('rh-anexos', v_cam, '{"size": 2048, "mimetype": "application/pdf"}');
  insert into rh.anexos (etapa_id, caminho, nome_original, tipo, tamanho)
  values (current_setting('r03.etapa')::uuid, v_cam, 'Rescisão.pdf', 'application/pdf', 2048)
  returning id into v_anexo;
  perform set_config('r03.anexo', v_anexo::text, true);

  foreach v_papel in array array['rh', 'admin', 'rh_restrito'] loop
    perform set_config('request.jwt.claims',
      json_build_object('sub', case v_papel when 'rh' then '00000000-0000-0000-0000-0000000000a1'
                                            when 'admin' then '00000000-0000-0000-0000-0000000000c3'
                                            else '00000000-0000-0000-0000-0000000000b2' end,
                        'role', 'authenticated', 'email', v_papel || '@teste.local',
                        'app_metadata', json_build_object('role', v_papel))::text, true);
    v_res := v_res || v_papel || '=';

    -- Apagar o arquivo (delete pela API = delete em storage.objects)
    begin
      delete from storage.objects where bucket_id = 'rh-anexos' and name = v_cam;
      get diagnostics v_n = row_count;
      v_r := case when v_n = 0 then 'bloqueado' else 'LIBERADO' end;
    exception when others then
      v_r := 'bloqueado';
    end;
    v_res := v_res || 'apagar:' || v_r;

    -- Alterar o arquivo (troca de conteúdo = update em storage.objects)
    begin
      update storage.objects set metadata = '{"size": 1, "mimetype": "application/pdf"}', updated_at = now()
       where bucket_id = 'rh-anexos' and name = v_cam;
      get diagnostics v_n = row_count;
      v_r := case when v_n = 0 then 'bloqueado' else 'LIBERADO' end;
    exception when insufficient_privilege then
      v_r := 'bloqueado';
    end;
    v_res := v_res || ' alterar:' || v_r;

    -- Renomear/mover (move pela API = update do name)
    begin
      update storage.objects set name = current_setting('r03.pasta') || gen_random_uuid() || '.pdf'
       where bucket_id = 'rh-anexos' and name = v_cam;
      get diagnostics v_n = row_count;
      v_r := case when v_n = 0 then 'bloqueado' else 'LIBERADO' end;
    exception when insufficient_privilege then
      v_r := 'bloqueado';
    end;
    v_res := v_res || ' renomear:' || v_r;

    -- Enviar de novo no mesmo caminho (sem upsert)
    begin
      insert into storage.objects (bucket_id, name, metadata)
      values ('rh-anexos', v_cam, '{"size": 1, "mimetype": "application/pdf"}');
      v_r := 'LIBERADO';
    exception when insufficient_privilege or unique_violation then
      v_r := 'bloqueado';
    end;
    v_res := v_res || ' sobrescrever:' || v_r;

    -- Enviar de novo no mesmo caminho com upsert (insert ... on conflict do update)
    begin
      insert into storage.objects (bucket_id, name, metadata)
      values ('rh-anexos', v_cam, '{"size": 1, "mimetype": "application/pdf"}')
      on conflict (bucket_id, name) do update set metadata = excluded.metadata;
      v_r := 'LIBERADO';
    exception when insufficient_privilege or unique_violation then
      v_r := 'bloqueado';
    end;
    v_res := v_res || ' upsert:' || v_r;

    -- Apagar o registro em rh.anexos
    begin
      delete from rh.anexos where id = v_anexo;
      get diagnostics v_n = row_count;
      v_r := case when v_n = 0 then 'bloqueado' else 'LIBERADO' end;
    exception when insufficient_privilege then
      v_r := 'bloqueado';
    end;
    v_res := v_res || ' apagar_registro:' || v_r;

    -- Trocar caminho/nome do registro (só "ativo" pode mudar)
    begin
      update rh.anexos set nome_original = 'Trocado.pdf', caminho = current_setting('r03.pasta') || gen_random_uuid() || '.pdf'
       where id = v_anexo;
      get diagnostics v_n = row_count;
      v_r := case when v_n = 0 then 'bloqueado' else 'LIBERADO' end;
    exception when insufficient_privilege then
      v_r := 'bloqueado';
    end;
    v_res := v_res || ' alterar_registro:' || v_r || ' | ';
  end loop;

  perform set_config('request.jwt.claims',
    json_build_object('sub', '00000000-0000-0000-0000-0000000000a1', 'role', 'authenticated',
                      'app_metadata', json_build_object('role', 'rh'))::text, true);
  perform set_config('r03.res', v_res, true);
  perform set_config('r03.arquivo', exists (select 1 from storage.objects where bucket_id = 'rh-anexos'
    and name = v_cam and metadata ->> 'size' = '2048')::text, true);
end $$;
reset role;
do $$
declare
  v_anexo uuid := current_setting('r03.anexo')::uuid;
  v_del text := 'LIBERADO';
  v_trunc text := 'LIBERADO';
begin
  -- Nem o dono das tabelas (postgres) apaga o registro
  begin
    delete from rh.anexos where id = v_anexo;
  exception when insufficient_privilege then
    v_del := 'bloqueado';
  end;
  begin
    truncate rh.anexos;
  exception when insufficient_privilege then
    v_trunc := 'bloqueado';
  end;
  raise exception 'RESULTADO (nada foi salvo): %arquivo_intacto=% | dono_apaga_registro=% | dono_trunca=% | registro_intacto=%',
    current_setting('r03.res'), current_setting('r03.arquivo'), v_del, v_trunc,
    exists (select 1 from rh.anexos where id = v_anexo and nome_original = 'Rescisão.pdf'
              and caminho = current_setting('r03.caminho') and ativo)::text;
end $$;
rollback;


-- -----------------------------------------------------------------------------
-- R.7 Caminho fora do padrão é recusado (esperado: recusados=10 de 10 | aceitos_indevidos=nenhum | caminho_certo=aceito | registro_etapa_trocada=bloqueado | registro_sem_arquivo=bloqueado)
--     Envios do 'rh' (que pode enviar) com caminhos errados: nome digitado,
--     etapa de outro processo, etapa inexistente, etapa removida, processo
--     cancelado, extensão errada ou maiúscula, pasta a mais, "..".
-- -----------------------------------------------------------------------------
begin;
do $$
declare
  v_colab uuid;
  v_modelo uuid;
  v_p1 uuid;
  v_p2 uuid;
  v_p3 uuid;
  v_e1 uuid;
  v_e2 uuid;
  v_e3 uuid;
  v_e4 uuid;
begin
  insert into rh.colaboradores (nome, vinculo) values ('Teste R03', 'CLT') returning id into v_colab;
  select id into v_modelo from rh.modelos where chave = 'rescisao_clt';
  insert into rh.processos (colaborador_id, modelo_id, modelo_nome) values (v_colab, v_modelo, 'Rescisão CLT') returning id into v_p1;
  insert into rh.processos (colaborador_id, modelo_id, modelo_nome) values (v_colab, v_modelo, 'Rescisão CLT') returning id into v_p2;
  insert into rh.processos (colaborador_id, modelo_id, modelo_nome, cancelado) values (v_colab, v_modelo, 'Rescisão CLT', true) returning id into v_p3;
  insert into rh.etapas (processo_id, ordem, nome) values (v_p1, 1, 'Assinaturas') returning id into v_e1;
  insert into rh.etapas (processo_id, ordem, nome) values (v_p2, 1, 'Assinaturas') returning id into v_e2;
  insert into rh.etapas (processo_id, ordem, nome, ativo) values (v_p1, 2, 'Removida', false) returning id into v_e3;
  insert into rh.etapas (processo_id, ordem, nome) values (v_p3, 1, 'Assinaturas') returning id into v_e4;
  perform set_config('r03.p1', v_p1::text, true);
  perform set_config('r03.p2', v_p2::text, true);
  perform set_config('r03.p3', v_p3::text, true);
  perform set_config('r03.e1', v_e1::text, true);
  perform set_config('r03.e2', v_e2::text, true);
  perform set_config('r03.e3', v_e3::text, true);
  perform set_config('r03.e4', v_e4::text, true);
end $$;
select set_config('request.jwt.claims',
         json_build_object('sub', '00000000-0000-0000-0000-0000000000a1', 'role', 'authenticated',
                           'email', 'rh@teste.local',
                           'app_metadata', json_build_object('role', 'rh'))::text, true);
set local role authenticated;
do $$
declare
  p1 text := current_setting('r03.p1');
  p2 text := current_setting('r03.p2');
  p3 text := current_setting('r03.p3');
  e1 text := current_setting('r03.e1');
  e2 text := current_setting('r03.e2');
  e3 text := current_setting('r03.e3');
  e4 text := current_setting('r03.e4');
  u text := gen_random_uuid()::text;
  v_cam text;
  v_recusados int := 0;
  v_aceitos text := '';
  v_certo text;
  v_trocada text := 'LIBERADO';
  v_sem_arquivo text := 'LIBERADO';
begin
  foreach v_cam in array array[
    'Contrato Ana.pdf',                                   -- nome digitado, sem pastas
    p1 || '/' || e1 || '/Contrato Ana.pdf',               -- nome digitado no fim
    p1 || '/' || e2 || '/' || u || '.pdf',                -- etapa de outro processo
    p1 || '/' || gen_random_uuid() || '/' || u || '.pdf', -- etapa que não existe
    p1 || '/' || e3 || '/' || u || '.pdf',                -- etapa removida (ativo = false)
    p3 || '/' || e4 || '/' || u || '.pdf',                -- processo cancelado
    p1 || '/' || e1 || '/' || u || '.exe',                -- extensão não aceita
    p1 || '/' || e1 || '/' || u || '.PDF',                -- extensão maiúscula
    p1 || '/' || e1 || '/x/' || u || '.pdf',              -- pasta a mais
    p1 || '/' || e1 || '/../' || u || '.pdf'              -- tentativa de subir pasta
  ] loop
    begin
      insert into storage.objects (bucket_id, name, metadata)
      values ('rh-anexos', v_cam, '{"size": 10, "mimetype": "application/pdf"}');
      v_aceitos := v_aceitos || v_cam || ' ';
    exception when insufficient_privilege then
      v_recusados := v_recusados + 1;
    end;
  end loop;

  -- Controle: o caminho certo passa
  v_cam := p1 || '/' || e1 || '/' || u || '.pdf';
  begin
    insert into storage.objects (bucket_id, name, metadata)
    values ('rh-anexos', v_cam, '{"size": 10, "mimetype": "application/pdf"}');
    v_certo := 'aceito';
  exception when insufficient_privilege then
    v_certo := 'RECUSADO';
  end;

  -- Registro dizendo uma etapa e caminho de outra
  begin
    insert into rh.anexos (etapa_id, caminho, nome_original, tipo, tamanho)
    values (e2::uuid, v_cam, 'Trocado.pdf', 'application/pdf', 10);
  exception when insufficient_privilege then
    v_trocada := 'bloqueado';
  end;

  -- Registro de um arquivo que não está no bucket
  begin
    insert into rh.anexos (etapa_id, caminho, nome_original, tipo, tamanho)
    values (e1::uuid, p1 || '/' || e1 || '/' || gen_random_uuid() || '.pdf', 'Fantasma.pdf', 'application/pdf', 10);
  exception when insufficient_privilege then
    v_sem_arquivo := 'bloqueado';
  end;

  raise exception 'RESULTADO (nada foi salvo): recusados=% de 10 | aceitos_indevidos=% | caminho_certo=% | registro_etapa_trocada=% | registro_sem_arquivo=%',
    v_recusados, coalesce(nullif(btrim(v_aceitos), ''), 'nenhum'), v_certo, v_trocada, v_sem_arquivo;
end $$;
reset role;
rollback;


-- -----------------------------------------------------------------------------
-- R.8 Retrato DEPOIS (esperado: os mesmos retrato_public, itens, retrato_storage e anexos_antigos do R.0)
-- -----------------------------------------------------------------------------
with publico as (
  select 'rel ' || c.relname || ' ' || c.relkind::text || ' ' || coalesce(c.relacl::text, '') || ' ' || c.relrowsecurity as x
    from pg_class c where c.relnamespace = 'public'::regnamespace
  union all
  select 'col ' || c.relname || '.' || a.attname || ' ' || format_type(a.atttypid, a.atttypmod) || ' ' || coalesce(a.attacl::text, '')
    from pg_attribute a join pg_class c on c.oid = a.attrelid
   where c.relnamespace = 'public'::regnamespace and a.attnum > 0 and not a.attisdropped
  union all
  select 'fn ' || p.oid::regprocedure::text || ' ' || md5(p.prosrc) || ' ' || coalesce(p.proacl::text, '') || ' '
         || p.prosecdef || ' ' || coalesce(array_to_string(p.proconfig, ','), '')
    from pg_proc p where p.pronamespace = 'public'::regnamespace
  union all
  select 'pol ' || tablename || ' ' || policyname || ' ' || cmd || ' ' || array_to_string(roles, ',') || ' '
         || coalesce(qual, '') || ' ' || coalesce(with_check, '')
    from pg_policies where schemaname = 'public'
  union all
  select 'trg ' || c.relname || ' ' || t.tgname || ' ' || t.tgenabled::text
    from pg_trigger t join pg_class c on c.oid = t.tgrelid
   where c.relnamespace = 'public'::regnamespace and not t.tgisinternal
  union all
  select 'nsp ' || coalesce(n.nspacl::text, '') from pg_namespace n where n.nspname = 'public'
  union all
  select 'def ' || d.defaclnamespace::text || ' ' || d.defaclobjtype::text || ' ' || d.defaclacl::text
    from pg_default_acl d where d.defaclnamespace not in (select oid from pg_namespace where nspname in ('torre', 'rh'))
), armazenamento as (
  select 'pol ' || tablename || ' ' || policyname || ' ' || cmd || ' ' || permissive || ' ' || array_to_string(roles, ',') || ' '
         || coalesce(qual, '') || ' ' || coalesce(with_check, '') as x
    from pg_policies where schemaname = 'storage' and policyname not like 'rh\_anexos\_%'
  union all
  select 'bkt ' || b.id || ' ' || coalesce(b.public::text, '') || ' ' || coalesce(b.file_size_limit::text, '') || ' '
         || coalesce(array_to_string(b.allowed_mime_types, ','), '')
    from storage.buckets b where b.id <> 'rh-anexos'
)
select (select md5(string_agg(x, E'\n' order by x)) from publico) as retrato_public,
       (select count(*) from publico) as itens,
       (select coalesce(md5(string_agg(x, E'\n' order by x)), 'vazio') || ' (' || count(*) || ' itens)' from armazenamento) as retrato_storage,
       (select count(*) || ' etapas, ' || coalesce(sum(cardinality(e.anexos)), 0) || ' nomes, md5 '
               || coalesce(md5(string_agg(e.id::text || ':' || array_to_string(e.anexos, '|'), ',' order by e.id)), 'vazio')
          from rh.etapas e where cardinality(e.anexos) > 0) as anexos_antigos;
