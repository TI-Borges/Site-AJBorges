-- =============================================================================
-- R01 - Estrutura do Dashboard RH (schema rh)          RASCUNHO - AINDA NÃO RODADO
--
-- Espelha o protótipo em memória de dashboard-rh/JavaScript/rh.js:
--   colaboradores, modelos (+ etapas do modelo), processos, etapas,
--   observações, contratos PJ, exames (SST) e férias.
--
-- Acesso pelo papel do JWT (app_metadata.role, o mesmo campo que o
-- public.is_admin() e o auth.js leem):
--   'rh'          lê e grava tudo do schema rh (menos a auditoria, que só lê);
--   'rh_restrito' lê tudo (menos a auditoria) e grava só observações e
--                 conclusão/reabertura de etapas;
--   qualquer outro papel (admin, diretoria, motorista) e anon: nada.
--   service_role também fica sem permissão nas tabelas (dado de RH separado).
--
-- Regras:
--   - RLS em todas as tabelas;
--   - sem delete físico: colunas ativo/cancelado; delete e truncate barrados
--     por trigger (vale até para o dono das tabelas);
--   - observações: só insert; autor, e-mail e hora vêm do servidor
--     (auth.uid(), auth.jwt(), now()), o que vier do navegador é ignorado;
--   - criado_em/criado_por/atualizado_em/atualizado_por preenchidos pelo
--     servidor em todas as tabelas;
--   - todo update gera uma linha em rh.auditoria (antes/depois em jsonb);
--     só 'rh' lê; ninguém altera nem apaga.
--
-- Como rodar (no SQL Editor, uma parte de cada vez):
--   R.0  retrato do public ANTES (anote o resultado);
--   1-8  bloco principal (begin ... commit);
--   R.1-R.8 conferências, uma por vez: cada uma termina com
--        raise exception 'RESULTADO ...' + rollback (nada fica salvo);
--   R.9  retrato do public DEPOIS (tem que dar igual ao R.0).
--   Obs.: o retrato daqui ignora os default privileges dos schemas torre e
--   rh; compare R.0 com R.9 (não com o 0_retrato da Torre).
--
-- Depois de rodar, para o site usar: incluir "rh" em Exposed schemas
-- (Project Settings > API). Isso não faz parte deste arquivo.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- R.0 Retrato do public (rode ANTES e anote; o R.9 repete e tem que dar igual)
-- -----------------------------------------------------------------------------
select md5(string_agg(x, E'\n' order by x)) as retrato_public, count(*) as itens
from (
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
) s;


-- =============================================================================
-- BLOCO PRINCIPAL (1 a 8)
-- =============================================================================
begin;


-- -----------------------------------------------------------------------------
-- 1. Schema (sem acesso para anon)
-- -----------------------------------------------------------------------------
create schema if not exists rh;
revoke all on schema rh from public;
grant usage on schema rh to authenticated;


-- -----------------------------------------------------------------------------
-- 2. Papéis (security definer, search_path vazio)
-- -----------------------------------------------------------------------------
create or replace function rh.eh_rh()
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select auth.jwt()) -> 'app_metadata' ->> 'role', '') = 'rh'
$$;

create or replace function rh.eh_rh_restrito()
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select auth.jwt()) -> 'app_metadata' ->> 'role', '') = 'rh_restrito'
$$;


-- -----------------------------------------------------------------------------
-- 3. Tabelas
--    Datas do dia a dia em date; carimbos em timestamptz; ids uuid.
-- -----------------------------------------------------------------------------

-- Colaboradores (CLT, PJ, Estagiário)
create table if not exists rh.colaboradores (
  id                 uuid primary key default gen_random_uuid(),
  nome               text not null check (length(btrim(nome)) between 1 and 200),
  cargo              text check (length(cargo) <= 120),
  setor              text check (length(setor) <= 120),
  vinculo            text not null check (vinculo in ('CLT', 'PJ', 'Estagiário')),
  situacao           text not null default 'Ativo'
                     check (situacao in ('Ativo', 'Em admissão', 'Em desligamento', 'Inativo')),
  data_admissao      date,
  data_proximo_exame date,
  ativo              boolean not null default true,
  criado_em          timestamptz not null default now(),
  criado_por         uuid,
  atualizado_em      timestamptz not null default now(),
  atualizado_por     uuid
);

-- Modelos de etapas (Rescisão CLT, Distrato PJ, Exame periódico, Admissão CLT)
create table if not exists rh.modelos (
  id             uuid primary key default gen_random_uuid(),
  chave          text not null unique check (chave ~ '^[a-z0-9_]{1,60}$'),
  nome           text not null check (length(btrim(nome)) between 1 and 120),
  ativo          boolean not null default true,
  criado_em      timestamptz not null default now(),
  criado_por     uuid,
  atualizado_em  timestamptz not null default now(),
  atualizado_por uuid
);

-- Etapas de cada modelo (ordem sem unique, para poder trocar duas de lugar)
create table if not exists rh.modelo_etapas (
  id             uuid primary key default gen_random_uuid(),
  modelo_id      uuid not null references rh.modelos (id),
  ordem          int not null check (ordem >= 1),
  nome           text not null check (length(btrim(nome)) between 1 and 200),
  ativo          boolean not null default true,
  criado_em      timestamptz not null default now(),
  criado_por     uuid,
  atualizado_em  timestamptz not null default now(),
  atualizado_por uuid
);
create index if not exists modelo_etapas_modelo on rh.modelo_etapas (modelo_id, ordem);

-- Processos (as etapas são copiadas do modelo; modelo_nome guarda o nome da época)
create table if not exists rh.processos (
  id             uuid primary key default gen_random_uuid(),
  colaborador_id uuid not null references rh.colaboradores (id),
  modelo_id      uuid not null references rh.modelos (id),
  modelo_nome    text not null check (length(btrim(modelo_nome)) between 1 and 120),
  cancelado      boolean not null default false,
  criado_em      timestamptz not null default now(),
  criado_por     uuid,
  atualizado_em  timestamptz not null default now(),
  atualizado_por uuid
);
create index if not exists processos_colaborador on rh.processos (colaborador_id);

-- Etapas de um processo (checklist). anexos = só os nomes dos arquivos, como
-- no protótipo; o arquivo em si ficaria no Storage (fora deste passo).
-- concluida_em/concluida_por: preenchidos pelo servidor.
create table if not exists rh.etapas (
  id             uuid primary key default gen_random_uuid(),
  processo_id    uuid not null references rh.processos (id),
  ordem          int not null check (ordem >= 1),
  nome           text not null check (length(btrim(nome)) between 1 and 200),
  concluida      boolean not null default false,
  concluida_em   timestamptz,
  concluida_por  uuid,
  responsavel    text check (length(responsavel) <= 120),
  prazo          date,
  anexos         text[] not null default '{}',
  ativo          boolean not null default true,
  criado_em      timestamptz not null default now(),
  criado_por     uuid,
  atualizado_em  timestamptz not null default now(),
  atualizado_por uuid
);
create index if not exists etapas_processo on rh.etapas (processo_id, ordem);

-- Observações das etapas (histórico append-only: só insert)
create table if not exists rh.observacoes (
  id             uuid primary key default gen_random_uuid(),
  etapa_id       uuid not null references rh.etapas (id),
  texto          text not null check (length(btrim(texto)) between 1 and 2000),
  autor          uuid not null,
  autor_email    text,
  criado_em      timestamptz not null default now(),
  criado_por     uuid,
  atualizado_em  timestamptz not null default now(),
  atualizado_por uuid
);
create index if not exists observacoes_etapa on rh.observacoes (etapa_id, criado_em);

-- Contratos PJ (um ativo por colaborador)
create table if not exists rh.contratos_pj (
  id             uuid primary key default gen_random_uuid(),
  colaborador_id uuid not null references rh.colaboradores (id),
  inicio         date not null,
  fim            date not null,
  valor          numeric(14, 2) not null check (valor >= 0),
  aviso_dias     int not null check (aviso_dias between 0 and 365),
  ativo          boolean not null default true,
  criado_em      timestamptz not null default now(),
  criado_por     uuid,
  atualizado_em  timestamptz not null default now(),
  atualizado_por uuid,
  check (fim >= inicio)
);
create unique index if not exists contratos_pj_um_ativo on rh.contratos_pj (colaborador_id) where ativo;

-- Exames (SST). Os anteriores do mesmo tipo ficam como histórico; quem vale
-- é decidido na leitura (realização mais recente), como no protótipo.
create table if not exists rh.exames (
  id              uuid primary key default gen_random_uuid(),
  colaborador_id  uuid not null references rh.colaboradores (id),
  tipo            text not null check (tipo in ('admissional', 'periodico', 'retorno', 'demissional')),
  data_realizacao date not null,
  vencimento      date,
  ativo           boolean not null default true,
  criado_em       timestamptz not null default now(),
  criado_por      uuid,
  atualizado_em   timestamptz not null default now(),
  atualizado_por  uuid,
  check (vencimento is null or vencimento >= data_realizacao)
);
create index if not exists exames_colaborador on rh.exames (colaborador_id, tipo, data_realizacao desc);

-- Férias (CLT). Aquisitivo = 12 meses a partir do início; concessivo = 12
-- meses seguintes (CLT art. 134), calculados pelo banco.
create table if not exists rh.ferias (
  id                 uuid primary key default gen_random_uuid(),
  colaborador_id     uuid not null references rh.colaboradores (id),
  aquisitivo_inicio  date not null,
  aquisitivo_fim     date generated always as ((aquisitivo_inicio + interval '1 year' - interval '1 day')::date) stored,
  concessivo_inicio  date generated always as ((aquisitivo_inicio + interval '1 year')::date) stored,
  concessivo_fim     date generated always as ((aquisitivo_inicio + interval '2 years' - interval '1 day')::date) stored,
  saldo_dias         int not null check (saldo_dias between 0 and 30),
  programacao_inicio date,
  programacao_fim    date,
  ativo              boolean not null default true,
  criado_em          timestamptz not null default now(),
  criado_por         uuid,
  atualizado_em      timestamptz not null default now(),
  atualizado_por     uuid,
  check ((programacao_inicio is null) = (programacao_fim is null)),
  check (programacao_fim is null or programacao_fim >= programacao_inicio)
);
create index if not exists ferias_colaborador on rh.ferias (colaborador_id, aquisitivo_inicio desc);

-- Auditoria: uma linha por update (quem, quando, tabela, id, antes, depois)
create table if not exists rh.auditoria (
  id          bigint generated always as identity primary key,
  quando      timestamptz not null default now(),
  quem        uuid,
  quem_email  text,
  tabela      text not null,
  registro_id uuid not null,
  antes       jsonb not null,
  depois      jsonb not null
);
create index if not exists auditoria_registro on rh.auditoria (tabela, registro_id, quando desc);


-- -----------------------------------------------------------------------------
-- 4. Funções dos triggers
-- -----------------------------------------------------------------------------

-- Carimbos do servidor (o que o navegador mandar nesses campos é ignorado)
create or replace function rh.carimbar()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    new.criado_em := now();
    new.criado_por := auth.uid();
  else
    new.id := old.id;
    new.criado_em := old.criado_em;
    new.criado_por := old.criado_por;
  end if;
  new.atualizado_em := now();
  new.atualizado_por := auth.uid();
  return new;
end $$;

-- Observação: autor, e-mail e hora sempre do servidor
create or replace function rh.observacao_servidor()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.autor := auth.uid();
  new.autor_email := nullif((select auth.jwt()) ->> 'email', '');
  if new.autor is null then
    raise exception 'rh.observacoes: precisa de usuário autenticado' using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;

-- Etapa: conclusão carimbada pelo servidor; 'rh_restrito' só muda "concluida"
create or replace function rh.etapas_regras()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' or new.concluida is distinct from old.concluida then
    new.concluida_em := case when new.concluida then now() end;
    new.concluida_por := case when new.concluida then auth.uid() end;
  else
    new.concluida_em := old.concluida_em;
    new.concluida_por := old.concluida_por;
  end if;

  if tg_op = 'UPDATE' and rh.eh_rh_restrito()
     and (new.processo_id, new.ordem, new.nome, new.responsavel, new.prazo, new.anexos, new.ativo)
         is distinct from
         (old.processo_id, old.ordem, old.nome, old.responsavel, old.prazo, old.anexos, old.ativo) then
    raise exception 'rh.etapas: rh_restrito só pode concluir ou reabrir etapas' using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;

-- Sem delete físico; observações e auditoria não mudam (vale até para o dono)
create or replace function rh.bloquear_alteracao()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'rh.%: % não é permitido (sem delete físico; observações e auditoria não mudam)',
    tg_table_name, lower(tg_op) using errcode = 'insufficient_privilege';
end $$;

-- Auditoria de updates (security definer: grava na rh.auditoria sem dar grant a ninguém)
create or replace function rh.auditar()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if to_jsonb(old) is distinct from to_jsonb(new) then
    insert into rh.auditoria (quem, quem_email, tabela, registro_id, antes, depois)
    values (auth.uid(), nullif((select auth.jwt()) ->> 'email', ''), tg_table_name, new.id, to_jsonb(old), to_jsonb(new));
  end if;
  return null;
end $$;


-- -----------------------------------------------------------------------------
-- 5. Triggers
--    Ordem dentro do mesmo momento = ordem alfabética do nome (rh_10, rh_20...).
-- -----------------------------------------------------------------------------
do $$
declare
  t text;
begin
  -- Carimbos, auditoria e bloqueio de delete/truncate nas 8 tabelas que mudam
  foreach t in array array['colaboradores', 'modelos', 'modelo_etapas', 'processos', 'etapas',
                           'contratos_pj', 'exames', 'ferias'] loop
    execute format('drop trigger if exists rh_10_carimbar on rh.%I', t);
    execute format('create trigger rh_10_carimbar before insert or update on rh.%I
                    for each row execute function rh.carimbar()', t);
    execute format('drop trigger if exists rh_90_auditar on rh.%I', t);
    execute format('create trigger rh_90_auditar after update on rh.%I
                    for each row execute function rh.auditar()', t);
  end loop;

  foreach t in array array['colaboradores', 'modelos', 'modelo_etapas', 'processos', 'etapas',
                           'observacoes', 'contratos_pj', 'exames', 'ferias', 'auditoria'] loop
    execute format('drop trigger if exists rh_00_sem_delete on rh.%I', t);
    execute format('create trigger rh_00_sem_delete before delete on rh.%I
                    for each row execute function rh.bloquear_alteracao()', t);
    execute format('drop trigger if exists rh_00_sem_truncate on rh.%I', t);
    execute format('create trigger rh_00_sem_truncate before truncate on rh.%I
                    for each statement execute function rh.bloquear_alteracao()', t);
  end loop;
end $$;

-- Etapas: regras de conclusão e do rh_restrito
drop trigger if exists rh_20_regras on rh.etapas;
create trigger rh_20_regras before insert or update on rh.etapas
  for each row execute function rh.etapas_regras();

-- Observações: só insert (update barrado), autor/hora do servidor
drop trigger if exists rh_00_sem_update on rh.observacoes;
create trigger rh_00_sem_update before update on rh.observacoes
  for each row execute function rh.bloquear_alteracao();
drop trigger if exists rh_10_carimbar on rh.observacoes;
create trigger rh_10_carimbar before insert on rh.observacoes
  for each row execute function rh.carimbar();
drop trigger if exists rh_20_autor on rh.observacoes;
create trigger rh_20_autor before insert on rh.observacoes
  for each row execute function rh.observacao_servidor();

-- Auditoria: ninguém altera
drop trigger if exists rh_00_sem_update on rh.auditoria;
create trigger rh_00_sem_update before update on rh.auditoria
  for each row execute function rh.bloquear_alteracao();


-- -----------------------------------------------------------------------------
-- 6. RLS e policies
--    leitura: rh ou rh_restrito (auditoria: só rh);
--    escrita: rh; rh_restrito só insere observação e atualiza etapa (o
--    trigger rh_20_regras deixa mudar só "concluida");
--    nenhuma policy de delete.
-- -----------------------------------------------------------------------------
alter table rh.colaboradores enable row level security;
alter table rh.modelos       enable row level security;
alter table rh.modelo_etapas enable row level security;
alter table rh.processos     enable row level security;
alter table rh.etapas        enable row level security;
alter table rh.observacoes   enable row level security;
alter table rh.contratos_pj  enable row level security;
alter table rh.exames        enable row level security;
alter table rh.ferias        enable row level security;
alter table rh.auditoria     enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array['colaboradores', 'modelos', 'modelo_etapas', 'processos', 'etapas',
                           'observacoes', 'contratos_pj', 'exames', 'ferias'] loop
    execute format('drop policy if exists rh_le on rh.%I', t);
    execute format('create policy rh_le on rh.%I for select to authenticated
                    using (rh.eh_rh() or rh.eh_rh_restrito())', t);
  end loop;

  foreach t in array array['colaboradores', 'modelos', 'modelo_etapas', 'processos', 'etapas',
                           'contratos_pj', 'exames', 'ferias'] loop
    execute format('drop policy if exists rh_insere on rh.%I', t);
    execute format('create policy rh_insere on rh.%I for insert to authenticated
                    with check (rh.eh_rh())', t);
  end loop;

  foreach t in array array['colaboradores', 'modelos', 'modelo_etapas', 'processos',
                           'contratos_pj', 'exames', 'ferias'] loop
    execute format('drop policy if exists rh_atualiza on rh.%I', t);
    execute format('create policy rh_atualiza on rh.%I for update to authenticated
                    using (rh.eh_rh()) with check (rh.eh_rh())', t);
  end loop;
end $$;

drop policy if exists rh_atualiza on rh.etapas;
create policy rh_atualiza on rh.etapas for update to authenticated
  using (rh.eh_rh() or rh.eh_rh_restrito())
  with check (rh.eh_rh() or rh.eh_rh_restrito());

drop policy if exists rh_insere on rh.observacoes;
create policy rh_insere on rh.observacoes for insert to authenticated
  with check (rh.eh_rh() or rh.eh_rh_restrito());

drop policy if exists rh_le on rh.auditoria;
create policy rh_le on rh.auditoria for select to authenticated using (rh.eh_rh());


-- -----------------------------------------------------------------------------
-- 7. Permissões
--    - anon e public: nada (nem usage no schema);
--    - authenticated: select/insert/update nas tabelas (as policies decidem
--      quem); observações só select/insert; auditoria só select; delete nunca;
--    - service_role: nada;
--    - funções fechadas; authenticated executa só eh_rh() e eh_rh_restrito();
--    - default privileges: o que for criado depois no schema rh já nasce fechado.
-- -----------------------------------------------------------------------------
revoke all on all tables in schema rh from public, anon, authenticated, service_role;
revoke all on all sequences in schema rh from public, anon, authenticated, service_role;
grant select, insert, update on
  rh.colaboradores, rh.modelos, rh.modelo_etapas, rh.processos, rh.etapas,
  rh.contratos_pj, rh.exames, rh.ferias
  to authenticated;
grant select, insert on rh.observacoes to authenticated;
grant select on rh.auditoria to authenticated;

revoke all on all functions in schema rh from public, anon, authenticated, service_role;
grant execute on function rh.eh_rh(), rh.eh_rh_restrito() to authenticated;

alter default privileges in schema rh revoke all on tables from public, anon, authenticated, service_role;
alter default privileges in schema rh revoke all on sequences from public, anon, authenticated, service_role;
alter default privileges in schema rh revoke execute on functions from public, anon, authenticated, service_role;


-- -----------------------------------------------------------------------------
-- 8. Modelos iniciais (etapas do protótipo). Admissão CLT começa vazio
--    (aguardando a lista dos 19 passos do RH). Nenhum colaborador de exemplo.
--    Pode rodar de novo: não duplica.
-- -----------------------------------------------------------------------------
insert into rh.modelos (chave, nome) values
  ('rescisao_clt',    'Rescisão CLT'),
  ('distrato_pj',     'Distrato PJ'),
  ('exame_periodico', 'Exame periódico'),
  ('admissao_clt',    'Admissão CLT')
on conflict (chave) do nothing;

insert into rh.modelo_etapas (modelo_id, ordem, nome)
select m.id, e.ordem, e.nome
  from rh.modelos m
  join (values
    ('rescisao_clt', 1, 'Comunicação'),
    ('rescisao_clt', 2, 'Aviso'),
    ('rescisao_clt', 3, 'Cálculo'),
    ('rescisao_clt', 4, 'Conferência'),
    ('rescisao_clt', 5, 'Pagamento'),
    ('rescisao_clt', 6, 'Assinaturas'),
    ('rescisao_clt', 7, 'Arquivo'),
    ('distrato_pj', 1, 'Comunicação'),
    ('distrato_pj', 2, 'Prazo contratual'),
    ('distrato_pj', 3, 'Distrato'),
    ('distrato_pj', 4, 'Assinaturas'),
    ('distrato_pj', 5, 'Pagamento'),
    ('distrato_pj', 6, 'Encerramento'),
    ('exame_periodico', 1, 'Vencimento'),
    ('exame_periodico', 2, 'Agendamento'),
    ('exame_periodico', 3, 'Realização'),
    ('exame_periodico', 4, 'ASO'),
    ('exame_periodico', 5, 'Atualização do controle')
  ) as e (chave, ordem, nome) on e.chave = m.chave
 where not exists (select 1 from rh.modelo_etapas x where x.modelo_id = m.id);


commit;


-- =============================================================================
-- CONFERÊNCIAS (rode uma por vez; cada uma termina com RESULTADO + rollback)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- R.1 Estrutura e permissões (esperado: tabelas_rls=auditoria:true, colaboradores:true, contratos_pj:true, etapas:true, exames:true, ferias:true, modelo_etapas:true, modelos:true, observacoes:true, processos:true | anon_usa_schema=f | anon_privilegios=0 | delete_ou_truncate=0 | observacoes=INSERT,SELECT | auditoria=SELECT | service_role_tabelas=0 | funcoes_papel=eh_rh:true:search_path="", eh_rh_restrito:true:search_path="" | funcoes_para_anon=0 | policies_delete=0 | modelos=Admissão CLT:0, Distrato PJ:6, Exame periódico:5, Rescisão CLT:7)
-- -----------------------------------------------------------------------------
do $$
begin
  raise exception 'RESULTADO: tabelas_rls=% | anon_usa_schema=% | anon_privilegios=% | delete_ou_truncate=% | observacoes=% | auditoria=% | service_role_tabelas=% | funcoes_papel=% | funcoes_para_anon=% | policies_delete=% | modelos=%',
    (select string_agg(c.relname || ':' || c.relrowsecurity, ', ' order by c.relname)
       from pg_class c where c.relnamespace = 'rh'::regnamespace and c.relkind = 'r'),
    has_schema_privilege('anon', 'rh', 'usage'),
    (select count(*) from pg_class c, aclexplode(c.relacl) a
      where c.relnamespace = 'rh'::regnamespace and a.grantee in (0::oid, 'anon'::regrole::oid)),
    (select count(*) from pg_class c, aclexplode(c.relacl) a
      where c.relnamespace = 'rh'::regnamespace and a.privilege_type in ('DELETE', 'TRUNCATE')
        and a.grantee <> c.relowner),
    (select string_agg(a.privilege_type, ',' order by a.privilege_type) from pg_class c, aclexplode(c.relacl) a
      where c.oid = 'rh.observacoes'::regclass and a.grantee = 'authenticated'::regrole::oid),
    (select string_agg(a.privilege_type, ',' order by a.privilege_type) from pg_class c, aclexplode(c.relacl) a
      where c.oid = 'rh.auditoria'::regclass and a.grantee = 'authenticated'::regrole::oid),
    (select count(*) from pg_class c, aclexplode(c.relacl) a
      where c.relnamespace = 'rh'::regnamespace and a.grantee = 'service_role'::regrole::oid),
    (select string_agg(p.proname || ':' || p.prosecdef || ':' || coalesce(array_to_string(p.proconfig, ','), 'SEM search_path'),
                       ', ' order by p.proname)
       from pg_proc p where p.pronamespace = 'rh'::regnamespace and p.proname in ('eh_rh', 'eh_rh_restrito')),
    (select count(*) from pg_proc p where p.pronamespace = 'rh'::regnamespace and has_function_privilege('anon', p.oid, 'execute')),
    (select count(*) from pg_policies where schemaname = 'rh' and cmd in ('DELETE', 'ALL')),
    (select string_agg(m.nome || ':' || (select count(*) from rh.modelo_etapas e where e.modelo_id = m.id and e.ativo), ', ' order by m.nome)
       from rh.modelos m);
end $$;


-- -----------------------------------------------------------------------------
-- R.2 Anon não lê nem grava nada (esperado: leu=nada | bloqueados=10 de 10 | gravar=bloqueado | funcao=bloqueada)
-- -----------------------------------------------------------------------------
begin;
set local role anon;
do $$
declare
  o text;
  v_n bigint;
  v_leu text := '';
  v_bloq int := 0;
  v_grava text := 'LIBERADO';
  v_fn text := 'LIBERADA';
begin
  foreach o in array array['colaboradores', 'modelos', 'modelo_etapas', 'processos', 'etapas',
                           'observacoes', 'contratos_pj', 'exames', 'ferias', 'auditoria'] loop
    begin
      execute format('select count(*) from rh.%I', o) into v_n;
      v_leu := v_leu || o || '=' || v_n || ' ';
    exception when insufficient_privilege then
      v_bloq := v_bloq + 1;
    end;
  end loop;
  begin
    insert into rh.colaboradores (nome, vinculo) values ('Anon R01', 'CLT');
  exception when insufficient_privilege then
    v_grava := 'bloqueado';
  end;
  begin
    perform rh.eh_rh();
  exception when insufficient_privilege then
    v_fn := 'bloqueada';
  end;
  raise exception 'RESULTADO (nada foi salvo): leu=% | bloqueados=% de 10 | gravar=% | funcao=%',
    coalesce(nullif(btrim(v_leu), ''), 'nada'), v_bloq, v_grava, v_fn;
end $$;
rollback;


-- -----------------------------------------------------------------------------
-- R.3 Motorista, admin e diretoria da frota não leem nem gravam (esperado: motorista=linhas_lidas:0 gravar:bloqueado | admin=linhas_lidas:0 gravar:bloqueado | diretoria=linhas_lidas:0 gravar:bloqueado | linhas_no_banco>0=true)
--     Antes, como dono, grava 1 colaborador + 1 processo + 1 etapa + 1 observação
--     para provar que existe o que ler (e os 4 modelos já existem).
-- -----------------------------------------------------------------------------
begin;
do $$
declare
  v_colab uuid;
  v_proc uuid;
  v_etapa uuid;
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', '00000000-0000-0000-0000-0000000000a1', 'role', 'authenticated',
                      'app_metadata', json_build_object('role', 'rh'))::text, true);
  insert into rh.colaboradores (nome, vinculo) values ('Teste R01', 'CLT') returning id into v_colab;
  insert into rh.processos (colaborador_id, modelo_id, modelo_nome)
  select v_colab, m.id, m.nome from rh.modelos m where m.chave = 'rescisao_clt' returning id into v_proc;
  insert into rh.etapas (processo_id, ordem, nome) values (v_proc, 1, 'Comunicação') returning id into v_etapa;
  insert into rh.observacoes (etapa_id, texto) values (v_etapa, 'Observação de teste');
  update rh.colaboradores set cargo = 'Analista' where id = v_colab;
  perform set_config('r01.linhas', (select (count(*) > 0)::text from rh.auditoria), true);
end $$;
set local role authenticated;
do $$
declare
  v_papel text;
  o text;
  v_n bigint;
  v_total bigint;
  v_grava text;
  v_res text := '';
begin
  foreach v_papel in array array['motorista', 'admin', 'diretoria'] loop
    perform set_config('request.jwt.claims',
      json_build_object('sub', gen_random_uuid(), 'role', 'authenticated',
                        'app_metadata', json_build_object('role', v_papel))::text, true);
    v_total := 0;
    foreach o in array array['colaboradores', 'modelos', 'modelo_etapas', 'processos', 'etapas',
                             'observacoes', 'contratos_pj', 'exames', 'ferias', 'auditoria'] loop
      execute format('select count(*) from rh.%I', o) into v_n;
      v_total := v_total + v_n;
    end loop;
    begin
      insert into rh.colaboradores (nome, vinculo) values ('Invasor R01', 'CLT');
      v_grava := 'LIBERADO';
    exception when insufficient_privilege then
      v_grava := 'bloqueado';
    end;
    v_res := v_res || v_papel || '=linhas_lidas:' || v_total || ' gravar:' || v_grava || ' | ';
  end loop;
  raise exception 'RESULTADO (nada foi salvo): %linhas_no_banco>0=%', v_res, current_setting('r01.linhas');
end $$;
reset role;
rollback;


-- -----------------------------------------------------------------------------
-- R.4 'rh' lê e grava tudo (esperado: gravou=ok | leu: colaboradores=2 processos=1 etapas=7 observacoes=1 contratos=1 exames=1 ferias=1 modelos=4 auditoria=2 | carimbos_do_servidor=t | concessivo_calculado=t)
-- -----------------------------------------------------------------------------
begin;
select set_config('request.jwt.claims',
         json_build_object('sub', '00000000-0000-0000-0000-0000000000a1', 'role', 'authenticated',
                           'email', 'rh@teste.local',
                           'app_metadata', json_build_object('role', 'rh'))::text, true);
set local role authenticated;
do $$
declare
  v_sub uuid := '00000000-0000-0000-0000-0000000000a1';
  v_colab uuid;
  v_pj uuid;
  v_modelo uuid;
  v_proc uuid;
  v_etapa uuid;
  v_ferias uuid;
  v_leu text;
begin
  insert into rh.colaboradores (nome, cargo, setor, vinculo, situacao, data_admissao)
  values ('Teste CLT R01', 'Analista', 'RH', 'CLT', 'Ativo', current_date - 400) returning id into v_colab;
  insert into rh.colaboradores (nome, cargo, setor, vinculo, situacao, data_admissao)
  values ('Teste PJ R01', 'Consultor', 'TI', 'PJ', 'Ativo', current_date - 300) returning id into v_pj;

  select id into v_modelo from rh.modelos where chave = 'rescisao_clt';
  insert into rh.processos (colaborador_id, modelo_id, modelo_nome)
  values (v_colab, v_modelo, 'Rescisão CLT') returning id into v_proc;
  insert into rh.etapas (processo_id, ordem, nome)
  select v_proc, e.ordem, e.nome from rh.modelo_etapas e where e.modelo_id = v_modelo and e.ativo;
  select id into v_etapa from rh.etapas where processo_id = v_proc order by ordem limit 1;

  insert into rh.observacoes (etapa_id, texto) values (v_etapa, 'Comunicado entregue');
  insert into rh.contratos_pj (colaborador_id, inicio, fim, valor, aviso_dias)
  values (v_pj, current_date - 300, current_date + 30, 12500.50, 30);
  insert into rh.exames (colaborador_id, tipo, data_realizacao, vencimento)
  values (v_colab, 'periodico', current_date - 340, current_date + 25);
  insert into rh.ferias (colaborador_id, aquisitivo_inicio, saldo_dias)
  values (v_colab, date '2024-12-02', 30) returning id into v_ferias;

  update rh.etapas set concluida = true, responsavel = 'DP' where id = v_etapa;
  update rh.colaboradores set situacao = 'Em desligamento' where id = v_colab;

  v_leu := format('colaboradores=%s processos=%s etapas=%s observacoes=%s contratos=%s exames=%s ferias=%s modelos=%s auditoria=%s',
    (select count(*) from rh.colaboradores where criado_por = v_sub),
    (select count(*) from rh.processos where criado_por = v_sub),
    (select count(*) from rh.etapas where criado_por = v_sub),
    (select count(*) from rh.observacoes where autor = v_sub),
    (select count(*) from rh.contratos_pj where criado_por = v_sub),
    (select count(*) from rh.exames where criado_por = v_sub),
    (select count(*) from rh.ferias where criado_por = v_sub),
    (select count(*) from rh.modelos),
    (select count(*) from rh.auditoria where quem = v_sub));

  raise exception 'RESULTADO (nada foi salvo): gravou=ok | leu: % | carimbos_do_servidor=% | concessivo_calculado=%',
    v_leu,
    (select concluida and concluida_por = v_sub and concluida_em = now() and atualizado_por = v_sub
       from rh.etapas where id = v_etapa),
    (select aquisitivo_fim = date '2025-12-01' and concessivo_inicio = date '2025-12-02' and concessivo_fim = date '2026-12-01'
       from rh.ferias where id = v_ferias);
end $$;
reset role;
rollback;


-- -----------------------------------------------------------------------------
-- R.5 'rh_restrito' (esperado: criar_colaborador=bloqueado | observacao=gravou | concluir_etapa=gravou | renomear_etapa=bloqueado | editar_colaborador=0 linhas | criar_exame=bloqueado | le_colaborador=t | le_auditoria=0 linhas)
-- -----------------------------------------------------------------------------
begin;
do $$
declare
  v_colab uuid;
  v_proc uuid;
  v_etapa uuid;
begin
  insert into rh.colaboradores (nome, vinculo) values ('Teste R01', 'CLT') returning id into v_colab;
  insert into rh.processos (colaborador_id, modelo_id, modelo_nome)
  select v_colab, m.id, m.nome from rh.modelos m where m.chave = 'rescisao_clt' returning id into v_proc;
  insert into rh.etapas (processo_id, ordem, nome) values (v_proc, 1, 'Comunicação') returning id into v_etapa;
  update rh.colaboradores set cargo = 'Analista' where id = v_colab;
  perform set_config('r01.colab', v_colab::text, true);
  perform set_config('r01.etapa', v_etapa::text, true);
end $$;
select set_config('request.jwt.claims',
         json_build_object('sub', '00000000-0000-0000-0000-0000000000b2', 'role', 'authenticated',
                           'email', 'rh.restrito@teste.local',
                           'app_metadata', json_build_object('role', 'rh_restrito'))::text, true);
set local role authenticated;
do $$
declare
  v_colab uuid := current_setting('r01.colab')::uuid;
  v_etapa uuid := current_setting('r01.etapa')::uuid;
  v_n bigint;
  v_criar text := 'LIBERADO';
  v_obs text;
  v_concluir text;
  v_renomear text := 'LIBERADO';
  v_editar text;
  v_exame text := 'LIBERADO';
begin
  begin
    insert into rh.colaboradores (nome, vinculo) values ('Novo R01', 'CLT');
  exception when insufficient_privilege then
    v_criar := 'bloqueado';
  end;

  insert into rh.observacoes (etapa_id, texto) values (v_etapa, 'Registro do restrito');
  v_obs := case when exists (select 1 from rh.observacoes where etapa_id = v_etapa
                              and autor = '00000000-0000-0000-0000-0000000000b2') then 'gravou' else 'NÃO GRAVOU' end;

  update rh.etapas set concluida = true where id = v_etapa;
  get diagnostics v_n = row_count;
  v_concluir := case when v_n = 1 then 'gravou' else 'NÃO GRAVOU (' || v_n || ')' end;

  begin
    update rh.etapas set nome = 'Renomeada' where id = v_etapa;
  exception when insufficient_privilege then
    v_renomear := 'bloqueado';
  end;

  update rh.colaboradores set cargo = 'Alterado' where id = v_colab;
  get diagnostics v_n = row_count;
  v_editar := v_n || ' linhas';

  begin
    insert into rh.exames (colaborador_id, tipo, data_realizacao) values (v_colab, 'periodico', current_date);
  exception when insufficient_privilege then
    v_exame := 'bloqueado';
  end;

  raise exception 'RESULTADO (nada foi salvo): criar_colaborador=% | observacao=% | concluir_etapa=% | renomear_etapa=% | editar_colaborador=% | criar_exame=% | le_colaborador=% | le_auditoria=% linhas',
    v_criar, v_obs, v_concluir, v_renomear, v_editar, v_exame,
    exists (select 1 from rh.colaboradores where id = v_colab),
    (select count(*) from rh.auditoria);
end $$;
reset role;
rollback;


-- -----------------------------------------------------------------------------
-- R.6 Observação não pode ser editada nem apagada; autor e hora do servidor; sem delete físico (esperado: autor_servidor=true | email_servidor=true | hora_servidor=true | rh_update=bloqueado | rh_delete=bloqueado | dono_update=bloqueado | dono_delete=bloqueado | delete_rh=colaboradores:bloqueado etapas:bloqueado exames:bloqueado ferias:bloqueado contratos_pj:bloqueado processos:bloqueado)
-- -----------------------------------------------------------------------------
begin;
do $$
declare
  v_colab uuid;
  v_proc uuid;
  v_etapa uuid;
begin
  insert into rh.colaboradores (nome, vinculo) values ('Teste R01', 'CLT') returning id into v_colab;
  insert into rh.processos (colaborador_id, modelo_id, modelo_nome)
  select v_colab, m.id, m.nome from rh.modelos m where m.chave = 'rescisao_clt' returning id into v_proc;
  insert into rh.etapas (processo_id, ordem, nome) values (v_proc, 1, 'Comunicação') returning id into v_etapa;
  perform set_config('r01.etapa', v_etapa::text, true);
end $$;
select set_config('request.jwt.claims',
         json_build_object('sub', '00000000-0000-0000-0000-0000000000a1', 'role', 'authenticated',
                           'email', 'rh@teste.local',
                           'app_metadata', json_build_object('role', 'rh'))::text, true);
set local role authenticated;
do $$
declare
  v_etapa uuid := current_setting('r01.etapa')::uuid;
  v_obs rh.observacoes;
  v_upd text := 'LIBERADO';
  v_del text := 'LIBERADO';
  v_apagar text := '';
  t text;
begin
  -- O navegador tenta mandar autor, e-mail e hora falsos
  insert into rh.observacoes (etapa_id, texto, autor, autor_email, criado_em)
  values (v_etapa, 'Texto original', gen_random_uuid(), 'falso@invasor', timestamptz '2000-01-01')
  returning * into v_obs;
  perform set_config('r01.obs', v_obs.id::text, true);
  perform set_config('r01.autor', (v_obs.autor = '00000000-0000-0000-0000-0000000000a1')::text, true);
  perform set_config('r01.email', (v_obs.autor_email = 'rh@teste.local')::text, true);
  perform set_config('r01.hora', (v_obs.criado_em = now())::text, true);

  begin
    update rh.observacoes set texto = 'Editado' where id = v_obs.id;
  exception when insufficient_privilege then
    v_upd := 'bloqueado';
  end;
  begin
    delete from rh.observacoes where id = v_obs.id;
  exception when insufficient_privilege then
    v_del := 'bloqueado';
  end;
  perform set_config('r01.rh_upd', v_upd, true);
  perform set_config('r01.rh_del', v_del, true);

  foreach t in array array['colaboradores', 'etapas', 'exames', 'ferias', 'contratos_pj', 'processos'] loop
    begin
      execute format('delete from rh.%I', t);
      v_apagar := v_apagar || t || ':LIBERADO ';
    exception when insufficient_privilege then
      v_apagar := v_apagar || t || ':bloqueado ';
    end;
  end loop;
  perform set_config('r01.apagar', btrim(v_apagar), true);
end $$;
reset role;
do $$
declare
  v_obs uuid := current_setting('r01.obs')::uuid;
  v_upd text := 'LIBERADO';
  v_del text := 'LIBERADO';
begin
  -- Nem o dono das tabelas (postgres) altera ou apaga observação
  begin
    update rh.observacoes set texto = 'Editado pelo dono' where id = v_obs;
  exception when insufficient_privilege then
    v_upd := 'bloqueado';
  end;
  begin
    delete from rh.observacoes where id = v_obs;
  exception when insufficient_privilege then
    v_del := 'bloqueado';
  end;
  raise exception 'RESULTADO (nada foi salvo): autor_servidor=% | email_servidor=% | hora_servidor=% | rh_update=% | rh_delete=% | dono_update=% | dono_delete=% | delete_rh=%',
    current_setting('r01.autor'), current_setting('r01.email'), current_setting('r01.hora'),
    current_setting('r01.rh_upd'), current_setting('r01.rh_del'), v_upd, v_del, current_setting('r01.apagar');
end $$;
rollback;


-- -----------------------------------------------------------------------------
-- R.7 Update gera auditoria; só 'rh' lê; ninguém altera a auditoria (esperado: auditou=true | quem=true | antes=Analista | depois=Coordenador | linhas_do_registro=1 | restrito_le=0 linhas | rh_altera=bloqueado | dono_altera=bloqueado | dono_apaga=bloqueado)
-- -----------------------------------------------------------------------------
begin;
select set_config('request.jwt.claims',
         json_build_object('sub', '00000000-0000-0000-0000-0000000000a1', 'role', 'authenticated',
                           'email', 'rh@teste.local',
                           'app_metadata', json_build_object('role', 'rh'))::text, true);
set local role authenticated;
do $$
declare
  v_colab uuid;
  v_aud rh.auditoria;
  v_antes bigint;
  v_alt text := 'LIBERADO';
begin
  insert into rh.colaboradores (nome, cargo, vinculo) values ('Teste R01', 'Analista', 'CLT') returning id into v_colab;
  update rh.colaboradores set cargo = 'Coordenador' where id = v_colab;
  select * into v_aud from rh.auditoria where tabela = 'colaboradores' and registro_id = v_colab order by id desc limit 1;

  perform set_config('r01.colab', v_colab::text, true);
  perform set_config('r01.aud', v_aud.id::text, true);
  perform set_config('r01.auditou', (v_aud.id is not null)::text, true);
  perform set_config('r01.quem', (v_aud.quem = '00000000-0000-0000-0000-0000000000a1' and v_aud.quem_email = 'rh@teste.local')::text, true);
  perform set_config('r01.antes', coalesce(v_aud.antes ->> 'cargo', 'NULO'), true);
  perform set_config('r01.depois', coalesce(v_aud.depois ->> 'cargo', 'NULO'), true);

  -- Um insert + um update = exatamente 1 linha de auditoria (insert não audita)
  select count(*) into v_antes from rh.auditoria where registro_id = v_colab;
  perform set_config('r01.linhas', v_antes::text, true);

  begin
    update rh.auditoria set tabela = 'x' where id = v_aud.id;
  exception when insufficient_privilege then
    v_alt := 'bloqueado';
  end;
  perform set_config('r01.rh_alt', v_alt, true);
end $$;
select set_config('request.jwt.claims',
         json_build_object('sub', '00000000-0000-0000-0000-0000000000b2', 'role', 'authenticated',
                           'app_metadata', json_build_object('role', 'rh_restrito'))::text, true);
do $$
begin
  perform set_config('r01.restrito', (select count(*)::text from rh.auditoria), true);
end $$;
reset role;
do $$
declare
  v_aud bigint := current_setting('r01.aud')::bigint;
  v_upd text := 'LIBERADO';
  v_del text := 'LIBERADO';
begin
  begin
    update rh.auditoria set tabela = 'x' where id = v_aud;
  exception when insufficient_privilege then
    v_upd := 'bloqueado';
  end;
  begin
    delete from rh.auditoria where id = v_aud;
  exception when insufficient_privilege then
    v_del := 'bloqueado';
  end;
  raise exception 'RESULTADO (nada foi salvo): auditou=% | quem=% | antes=% | depois=% | linhas_do_registro=% | restrito_le=% linhas | rh_altera=% | dono_altera=% | dono_apaga=%',
    current_setting('r01.auditou'), current_setting('r01.quem'), current_setting('r01.antes'),
    current_setting('r01.depois'), current_setting('r01.linhas'), current_setting('r01.restrito'),
    current_setting('r01.rh_alt'), v_upd, v_del;
end $$;
rollback;


-- -----------------------------------------------------------------------------
-- R.8 service_role também não lê nem grava (esperado: leu=nada | bloqueados=10 de 10 | gravar=bloqueado)
-- -----------------------------------------------------------------------------
begin;
set local role service_role;
do $$
declare
  o text;
  v_n bigint;
  v_leu text := '';
  v_bloq int := 0;
  v_grava text := 'LIBERADO';
begin
  foreach o in array array['colaboradores', 'modelos', 'modelo_etapas', 'processos', 'etapas',
                           'observacoes', 'contratos_pj', 'exames', 'ferias', 'auditoria'] loop
    begin
      execute format('select count(*) from rh.%I', o) into v_n;
      v_leu := v_leu || o || '=' || v_n || ' ';
    exception when insufficient_privilege then
      v_bloq := v_bloq + 1;
    end;
  end loop;
  begin
    insert into rh.colaboradores (nome, vinculo) values ('Service R01', 'CLT');
  exception when insufficient_privilege then
    v_grava := 'bloqueado';
  end;
  raise exception 'RESULTADO (nada foi salvo): leu=% | bloqueados=% de 10 | gravar=%',
    coalesce(nullif(btrim(v_leu), ''), 'nada'), v_bloq, v_grava;
end $$;
reset role;
rollback;


-- -----------------------------------------------------------------------------
-- R.9 Nada mudou no public (esperado: o mesmo retrato_public e itens do R.0)
-- -----------------------------------------------------------------------------
select md5(string_agg(x, E'\n' order by x)) as retrato_public, count(*) as itens
from (
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
) s;
