-- =============================================================================
-- R05 - Lixeira de colaboradores do RH                RASCUNHO - AINDA NÃO RODADO
--
-- Rode DEPOIS do R01, R01b e R03.
--
-- Excluir = mandar para a lixeira. NADA é apagado (sem delete físico, sem
-- limpeza automática): o colaborador ganha excluido_em/excluido_por e some,
-- junto com tudo que é dele (processos, etapas, observações, anexos, exames,
-- férias e contratos PJ), de todas as leituras do site. Restaurar devolve tudo
-- como estava.
--
-- O que muda:
--   - rh.colaboradores: colunas excluido_em, excluido_por e excluido_por_email
--     (o e-mail é para a lixeira mostrar quem excluiu). Só o servidor
--     preenche: o trigger rh_15_lixeira ignora o que vier do navegador.
--   - RPCs (security definer, search_path vazio, só 'rh' e 'admin'):
--       rh.excluir_colaborador(p_id uuid)   -> manda para a lixeira
--       rh.restaurar_colaborador(p_id uuid) -> tira da lixeira
--       rh.lixeira()                        -> lista o que está na lixeira
--     As duas primeiras gravam por update, então a auditoria (rh_90_auditar)
--     registra quem, quando, antes e depois.
--   - Policies do schema rh: a leitura (e a gravação de filhos) passa a exigir
--     que o colaborador não esteja na lixeira. Funções de apoio:
--     rh.colaborador_visivel, rh.processo_visivel, rh.etapa_visivel.
--     Nenhuma policy nova de delete; grants não mudam; os triggers
--     rh_00_sem_delete/rh_00_sem_truncate continuam ligados.
--   - Arquivos do bucket rh-anexos não mudam (a tela deixa de listá-los porque
--     rh.anexos do excluído não aparece mais).
--
-- Como rodar (no SQL Editor, uma parte de cada vez):
--   R.0  retrato do public ANTES (anote o resultado);
--   1-6  bloco principal (begin ... commit); pode rodar de novo;
--   R.1-R.5 conferências, uma por vez: cada uma termina com
--        raise exception 'RESULTADO ...' + rollback (nada fica salvo);
--   R.6  retrato do public DEPOIS (tem que dar igual ao R.0).
-- =============================================================================


-- -----------------------------------------------------------------------------
-- R.0 Retrato do public (rode ANTES e anote; o R.6 repete e tem que dar igual)
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
-- BLOCO PRINCIPAL (1 a 6)
-- =============================================================================
begin;


-- -----------------------------------------------------------------------------
-- 1. Colunas da lixeira (vazias = não está na lixeira)
-- -----------------------------------------------------------------------------
alter table rh.colaboradores add column if not exists excluido_em        timestamptz;
alter table rh.colaboradores add column if not exists excluido_por       uuid;
alter table rh.colaboradores add column if not exists excluido_por_email text;
create index if not exists colaboradores_lixeira on rh.colaboradores (excluido_em) where excluido_em is not null;


-- -----------------------------------------------------------------------------
-- 2. Só o servidor preenche a lixeira
--    Insert: sempre vazio. Update: mantém o valor anterior, a não ser que
--    venha de dentro das RPCs (marca rh.lixeira = 'sim' na transação e roda
--    como o dono da função, nunca como authenticated/anon).
-- -----------------------------------------------------------------------------
create or replace function rh.colaboradores_lixeira()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    new.excluido_em := null;
    new.excluido_por := null;
    new.excluido_por_email := null;
  elsif coalesce(current_setting('rh.lixeira', true), '') <> 'sim'
        or current_user in ('authenticated', 'anon') then
    new.excluido_em := old.excluido_em;
    new.excluido_por := old.excluido_por;
    new.excluido_por_email := old.excluido_por_email;
  end if;
  return new;
end $$;

drop trigger if exists rh_15_lixeira on rh.colaboradores;
create trigger rh_15_lixeira before insert or update on rh.colaboradores
  for each row execute function rh.colaboradores_lixeira();


-- -----------------------------------------------------------------------------
-- 3. Visibilidade (usadas nas policies; security definer para enxergar o
--    colaborador mesmo quando ele está escondido pela própria policy)
-- -----------------------------------------------------------------------------
create or replace function rh.colaborador_visivel(p_colaborador uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from rh.colaboradores c where c.id = p_colaborador and c.excluido_em is null)
$$;

create or replace function rh.processo_visivel(p_processo uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from rh.processos p join rh.colaboradores c on c.id = p.colaborador_id
                  where p.id = p_processo and c.excluido_em is null)
$$;

create or replace function rh.etapa_visivel(p_etapa uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from rh.etapas e
                   join rh.processos p on p.id = e.processo_id
                   join rh.colaboradores c on c.id = p.colaborador_id
                  where e.id = p_etapa and c.excluido_em is null)
$$;


-- -----------------------------------------------------------------------------
-- 4. RPCs da lixeira (só 'rh' e 'admin'; diretoria, motorista, rh_restrito e
--    anon não). O update passa pelos triggers de sempre: carimbos e auditoria.
-- -----------------------------------------------------------------------------
create or replace function rh.excluir_colaborador(p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not (rh.eh_rh() or rh.eh_admin()) then
    raise exception 'rh.excluir_colaborador: só rh ou admin podem excluir' using errcode = 'insufficient_privilege';
  end if;
  if auth.uid() is null then
    raise exception 'rh.excluir_colaborador: precisa de usuário autenticado' using errcode = 'insufficient_privilege';
  end if;

  perform set_config('rh.lixeira', 'sim', true);
  update rh.colaboradores
     set excluido_em = now(),
         excluido_por = auth.uid(),
         excluido_por_email = nullif((select auth.jwt()) ->> 'email', '')
   where id = p_id and excluido_em is null;
  if not found then
    perform set_config('rh.lixeira', '', true);
    raise exception 'rh.excluir_colaborador: colaborador não encontrado ou já está na lixeira' using errcode = 'no_data_found';
  end if;
  perform set_config('rh.lixeira', '', true);
end $$;

create or replace function rh.restaurar_colaborador(p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not (rh.eh_rh() or rh.eh_admin()) then
    raise exception 'rh.restaurar_colaborador: só rh ou admin podem restaurar' using errcode = 'insufficient_privilege';
  end if;

  perform set_config('rh.lixeira', 'sim', true);
  update rh.colaboradores
     set excluido_em = null, excluido_por = null, excluido_por_email = null
   where id = p_id and excluido_em is not null;
  if not found then
    perform set_config('rh.lixeira', '', true);
    raise exception 'rh.restaurar_colaborador: colaborador não está na lixeira' using errcode = 'no_data_found';
  end if;
  perform set_config('rh.lixeira', '', true);
end $$;

create or replace function rh.lixeira()
returns table (id uuid, nome text, cargo text, vinculo text, excluido_em timestamptz, excluido_por_email text)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not (rh.eh_rh() or rh.eh_admin()) then
    raise exception 'rh.lixeira: só rh ou admin veem a lixeira' using errcode = 'insufficient_privilege';
  end if;
  return query
    select c.id, c.nome, c.cargo, c.vinculo, c.excluido_em, c.excluido_por_email
      from rh.colaboradores c
     where c.excluido_em is not null
     order by c.excluido_em desc;
end $$;


-- -----------------------------------------------------------------------------
-- 5. Policies: quem pode continua igual (R01b/R03); some o que está na lixeira.
--    Leitura e gravação de filhos exigem o colaborador fora da lixeira (update
--    de linha escondida não acha a linha: 0 linhas).
-- -----------------------------------------------------------------------------
alter policy rh_le on rh.colaboradores
  using ((rh.eh_rh() or rh.eh_admin() or rh.eh_rh_restrito()) and excluido_em is null);

do $$
declare
  t text;
begin
  foreach t in array array['processos', 'contratos_pj', 'exames', 'ferias'] loop
    execute format('alter policy rh_le on rh.%I
                    using ((rh.eh_rh() or rh.eh_admin() or rh.eh_rh_restrito()) and rh.colaborador_visivel(colaborador_id))', t);
    execute format('alter policy rh_insere on rh.%I
                    with check ((rh.eh_rh() or rh.eh_admin()) and rh.colaborador_visivel(colaborador_id))', t);
    execute format('alter policy rh_atualiza on rh.%I
                    using (rh.eh_rh() or rh.eh_admin())
                    with check ((rh.eh_rh() or rh.eh_admin()) and rh.colaborador_visivel(colaborador_id))', t);
  end loop;
end $$;

alter policy rh_le on rh.etapas
  using ((rh.eh_rh() or rh.eh_admin() or rh.eh_rh_restrito()) and rh.processo_visivel(processo_id));
alter policy rh_insere on rh.etapas
  with check ((rh.eh_rh() or rh.eh_admin()) and rh.processo_visivel(processo_id));
alter policy rh_atualiza on rh.etapas
  using (rh.eh_rh() or rh.eh_admin() or rh.eh_rh_restrito())
  with check ((rh.eh_rh() or rh.eh_admin() or rh.eh_rh_restrito()) and rh.processo_visivel(processo_id));

alter policy rh_le on rh.observacoes
  using ((rh.eh_rh() or rh.eh_admin() or rh.eh_rh_restrito()) and rh.etapa_visivel(etapa_id));
alter policy rh_insere on rh.observacoes
  with check ((rh.eh_rh() or rh.eh_admin() or rh.eh_rh_restrito()) and rh.etapa_visivel(etapa_id));

alter policy rh_le on rh.anexos
  using ((rh.eh_rh() or rh.eh_admin() or rh.eh_rh_restrito()) and rh.etapa_visivel(etapa_id));
alter policy rh_insere on rh.anexos
  with check ((rh.eh_rh() or rh.eh_admin()) and rh.etapa_visivel(etapa_id));
alter policy rh_atualiza on rh.anexos
  using (rh.eh_rh() or rh.eh_admin())
  with check ((rh.eh_rh() or rh.eh_admin()) and rh.etapa_visivel(etapa_id));


-- -----------------------------------------------------------------------------
-- 6. Permissões das funções novas (anon, public e service_role: nada)
-- -----------------------------------------------------------------------------
revoke all on function rh.colaboradores_lixeira() from public, anon, authenticated, service_role;
revoke all on function rh.colaborador_visivel(uuid), rh.processo_visivel(uuid), rh.etapa_visivel(uuid),
                       rh.excluir_colaborador(uuid), rh.restaurar_colaborador(uuid), rh.lixeira()
  from public, anon, authenticated, service_role;
grant execute on function rh.colaborador_visivel(uuid), rh.processo_visivel(uuid), rh.etapa_visivel(uuid),
                          rh.excluir_colaborador(uuid), rh.restaurar_colaborador(uuid), rh.lixeira()
  to authenticated;


commit;


-- =============================================================================
-- CONFERÊNCIAS (rode uma por vez; cada uma termina com RESULTADO + rollback)
-- =============================================================================


-- -----------------------------------------------------------------------------
-- R.1 Estrutura e permissões (esperado: colunas=excluido_em:timestamp with time zone excluido_por:uuid excluido_por_email:text | funcoes=colaborador_visivel:true:search_path="" etapa_visivel:true:search_path="" excluir_colaborador:true:search_path="" lixeira:true:search_path="" processo_visivel:true:search_path="" restaurar_colaborador:true:search_path="" | executa=authenticated:6 anon:0 service_role:0 public:0 | gatilho_executavel_por_alguem=false | trigger=rh_15_lixeira:O | policies=30 | com_lixeira=21 | policies_delete=0 | delete_ou_truncate=0 | bloqueios_ligados=22 | colaboradores=INSERT,SELECT,UPDATE)
-- -----------------------------------------------------------------------------
do $$
begin
  raise exception 'RESULTADO: colunas=% | funcoes=% | executa=authenticated:% anon:% service_role:% public:% | gatilho_executavel_por_alguem=% | trigger=% | policies=% | com_lixeira=% | policies_delete=% | delete_ou_truncate=% | bloqueios_ligados=% | colaboradores=%',
    (select string_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod), ' ' order by a.attnum)
       from pg_attribute a where a.attrelid = 'rh.colaboradores'::regclass and a.attname like 'excluido%' and not a.attisdropped),
    (select string_agg(p.proname || ':' || p.prosecdef || ':' || coalesce(array_to_string(p.proconfig, ','), 'SEM search_path'), ' ' order by p.proname)
       from pg_proc p where p.pronamespace = 'rh'::regnamespace
        and p.proname in ('colaborador_visivel', 'processo_visivel', 'etapa_visivel', 'excluir_colaborador', 'restaurar_colaborador', 'lixeira')),
    (select count(*) from pg_proc p where p.pronamespace = 'rh'::regnamespace
        and p.proname in ('colaborador_visivel', 'processo_visivel', 'etapa_visivel', 'excluir_colaborador', 'restaurar_colaborador', 'lixeira')
        and has_function_privilege('authenticated', p.oid, 'execute')),
    (select count(*) from pg_proc p where p.pronamespace = 'rh'::regnamespace
        and p.proname in ('colaborador_visivel', 'processo_visivel', 'etapa_visivel', 'excluir_colaborador', 'restaurar_colaborador', 'lixeira')
        and has_function_privilege('anon', p.oid, 'execute')),
    (select count(*) from pg_proc p where p.pronamespace = 'rh'::regnamespace
        and p.proname in ('colaborador_visivel', 'processo_visivel', 'etapa_visivel', 'excluir_colaborador', 'restaurar_colaborador', 'lixeira')
        and has_function_privilege('service_role', p.oid, 'execute')),
    (select count(*) from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
      where p.pronamespace = 'rh'::regnamespace and a.grantee = 0
        and p.proname in ('colaborador_visivel', 'processo_visivel', 'etapa_visivel', 'excluir_colaborador', 'restaurar_colaborador', 'lixeira')),
    (has_function_privilege('authenticated', 'rh.colaboradores_lixeira()', 'execute')
      or has_function_privilege('anon', 'rh.colaboradores_lixeira()', 'execute'))::text,
    (select string_agg(t.tgname || ':' || t.tgenabled::text, ',') from pg_trigger t
      where t.tgrelid = 'rh.colaboradores'::regclass and t.tgname = 'rh_15_lixeira'),
    (select count(*) from pg_policies where schemaname = 'rh'),
    (select count(*) from pg_policies where schemaname = 'rh'
        and (coalesce(qual, '') || coalesce(with_check, '')) ~ '(excluido_em IS NULL|_visivel\()'),
    (select count(*) from pg_policies where schemaname = 'rh' and cmd in ('DELETE', 'ALL')),
    (select count(*) from pg_class c, aclexplode(c.relacl) a
      where c.relnamespace = 'rh'::regnamespace and a.privilege_type in ('DELETE', 'TRUNCATE')
        and a.grantee <> c.relowner),
    (select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid
      where c.relnamespace = 'rh'::regnamespace and t.tgenabled = 'O'
        and t.tgname in ('rh_00_sem_delete', 'rh_00_sem_truncate')),
    (select string_agg(a.privilege_type, ',' order by a.privilege_type) from pg_class c, aclexplode(c.relacl) a
      where c.oid = 'rh.colaboradores'::regclass and a.grantee = 'authenticated'::regrole::oid);
end $$;


-- -----------------------------------------------------------------------------
-- R.2 'rh' exclui e restaura; nada é apagado (esperado: ve_antes=colaboradores:1 processos:1 etapas:2 observacoes:1 anexos:1 exames:1 ferias:1 contratos_pj:1 | ve_na_lixeira=colaboradores:0 processos:0 etapas:0 observacoes:0 anexos:0 exames:0 ferias:0 contratos_pj:0 | lixeira=Teste R05 por rh@teste.local | ve_restaurado=colaboradores:1 processos:1 etapas:2 observacoes:1 anexos:1 exames:1 ferias:1 contratos_pj:1 | outro_colaborador_continua=true | linhas_no_banco_iguais=true | excluido_pelo_servidor=true | auditoria=2 linhas, quem=rh@teste.local)
-- -----------------------------------------------------------------------------
begin;
select set_config('request.jwt.claims',
         json_build_object('sub', '00000000-0000-0000-0000-0000000000a1', 'role', 'authenticated',
                           'email', 'rh@teste.local',
                           'app_metadata', json_build_object('role', 'rh'))::text, true);
do $$
declare
  v_colab uuid;
  v_outro uuid;
  v_proc uuid;
  v_etapa uuid;
  v_caminho text;
begin
  -- Dados (como dono das tabelas): um colaborador PJ com tudo e outro que não sai
  insert into rh.colaboradores (nome, vinculo) values ('Teste R05', 'PJ') returning id into v_colab;
  insert into rh.colaboradores (nome, vinculo) values ('Fica R05', 'CLT') returning id into v_outro;
  insert into rh.processos (colaborador_id, modelo_id, modelo_nome)
  select v_colab, m.id, m.nome from rh.modelos m where m.chave = 'distrato_pj' returning id into v_proc;
  insert into rh.etapas (processo_id, ordem, nome) values (v_proc, 1, 'Comunicação') returning id into v_etapa;
  insert into rh.etapas (processo_id, ordem, nome) values (v_proc, 2, 'Distrato');
  insert into rh.observacoes (etapa_id, texto) values (v_etapa, 'Comunicado entregue');
  v_caminho := v_proc || '/' || v_etapa || '/' || gen_random_uuid() || '.pdf';
  insert into storage.objects (bucket_id, name, metadata) values ('rh-anexos', v_caminho, '{"size":10,"mimetype":"application/pdf"}');
  insert into rh.anexos (etapa_id, caminho, nome_original, tipo, tamanho) values (v_etapa, v_caminho, 'distrato.pdf', 'application/pdf', 10);
  insert into rh.exames (colaborador_id, tipo, data_realizacao) values (v_colab, 'periodico', current_date - 10);
  insert into rh.ferias (colaborador_id, aquisitivo_inicio, saldo_dias) values (v_colab, current_date - 400, 30);
  insert into rh.contratos_pj (colaborador_id, inicio, fim, valor, aviso_dias) values (v_colab, current_date - 100, current_date + 100, 1000, 30);
  perform set_config('r05.colab', v_colab::text, true);
  perform set_config('r05.outro', v_outro::text, true);
  perform set_config('r05.linhas_antes', (select format('%s %s %s %s %s %s %s %s %s',
      (select count(*) from rh.colaboradores), (select count(*) from rh.processos), (select count(*) from rh.etapas),
      (select count(*) from rh.observacoes), (select count(*) from rh.anexos), (select count(*) from rh.exames),
      (select count(*) from rh.ferias), (select count(*) from rh.contratos_pj),
      (select count(*) from storage.objects where bucket_id = 'rh-anexos'))), true);
end $$;
set local role authenticated;
do $$
declare
  v_colab uuid := current_setting('r05.colab')::uuid;
  v_ve text := $q$format('colaboradores:%s processos:%s etapas:%s observacoes:%s anexos:%s exames:%s ferias:%s contratos_pj:%s',
      (select count(*) from rh.colaboradores where id = $1),
      (select count(*) from rh.processos where colaborador_id = $1),
      (select count(*) from rh.etapas e join rh.processos p on p.id = e.processo_id where p.colaborador_id = $1),
      (select count(*) from rh.observacoes o join rh.etapas e on e.id = o.etapa_id join rh.processos p on p.id = e.processo_id where p.colaborador_id = $1),
      (select count(*) from rh.anexos a join rh.etapas e on e.id = a.etapa_id join rh.processos p on p.id = e.processo_id where p.colaborador_id = $1),
      (select count(*) from rh.exames where colaborador_id = $1),
      (select count(*) from rh.ferias where colaborador_id = $1),
      (select count(*) from rh.contratos_pj where colaborador_id = $1))$q$;
  v_antes text;
  v_lixo text;
  v_lixeira text;
  v_depois text;
begin
  execute 'select ' || v_ve into v_antes using v_colab;
  perform rh.excluir_colaborador(v_colab);
  execute 'select ' || v_ve into v_lixo using v_colab;
  select string_agg(l.nome || ' por ' || l.excluido_por_email, ', ') into v_lixeira from rh.lixeira() l;
  perform set_config('r05.excluido', (select format('%s', (select 1 from rh.lixeira() l where l.id = v_colab and l.excluido_em = now()))), true);
  perform rh.restaurar_colaborador(v_colab);
  execute 'select ' || v_ve into v_depois using v_colab;
  perform set_config('r05.ve', v_antes || ' | ' || v_lixo || ' | ' || coalesce(v_lixeira, 'vazia') || ' | ' || v_depois, true);
  perform set_config('r05.outro_ve', exists (select 1 from rh.colaboradores where id = current_setting('r05.outro')::uuid)::text, true);
end $$;
reset role;
do $$
declare
  v_ve text[] := string_to_array(current_setting('r05.ve'), ' | ');
  v_linhas_depois text;
begin
  v_linhas_depois := format('%s %s %s %s %s %s %s %s %s',
      (select count(*) from rh.colaboradores), (select count(*) from rh.processos), (select count(*) from rh.etapas),
      (select count(*) from rh.observacoes), (select count(*) from rh.anexos), (select count(*) from rh.exames),
      (select count(*) from rh.ferias), (select count(*) from rh.contratos_pj),
      (select count(*) from storage.objects where bucket_id = 'rh-anexos'));
  raise exception 'RESULTADO (nada foi salvo): ve_antes=% | ve_na_lixeira=% | lixeira=% | ve_restaurado=% | outro_colaborador_continua=% | linhas_no_banco_iguais=% | excluido_pelo_servidor=% | auditoria=% linhas, quem=%',
    v_ve[1], v_ve[2], v_ve[3], v_ve[4], current_setting('r05.outro_ve'),
    (v_linhas_depois = current_setting('r05.linhas_antes'))::text,
    (current_setting('r05.excluido') = '1')::text,
    (select count(*) from rh.auditoria where tabela = 'colaboradores' and registro_id = current_setting('r05.colab')::uuid),
    (select string_agg(distinct a.quem_email, ',') from rh.auditoria a
      where a.tabela = 'colaboradores' and a.registro_id = current_setting('r05.colab')::uuid);
end $$;
rollback;


-- -----------------------------------------------------------------------------
-- R.3 'admin' exclui e restaura (esperado: excluiu=ok | ve_na_lixeira=0 | lixeira=1 | restaurou=ok | ve_restaurado=1 | excluir_de_novo_na_lixeira=nao_encontrado | restaurar_quem_nao_esta=nao_encontrado)
-- -----------------------------------------------------------------------------
begin;
do $$
declare
  v_colab uuid;
begin
  insert into rh.colaboradores (nome, vinculo) values ('Teste R05 admin', 'CLT') returning id into v_colab;
  perform set_config('r05.colab', v_colab::text, true);
end $$;
select set_config('request.jwt.claims',
         json_build_object('sub', '00000000-0000-0000-0000-0000000000c3', 'role', 'authenticated',
                           'email', 'admin@teste.local',
                           'app_metadata', json_build_object('role', 'admin'))::text, true);
set local role authenticated;
do $$
declare
  v_colab uuid := current_setting('r05.colab')::uuid;
  v_excluiu text := 'ok';
  v_ve_lixo bigint;
  v_lixeira bigint;
  v_restaurou text := 'ok';
  v_ve bigint;
  v_de_novo text := 'LIBERADO';
  v_nao_esta text := 'LIBERADO';
begin
  perform rh.excluir_colaborador(v_colab);
  select count(*) into v_ve_lixo from rh.colaboradores where id = v_colab;
  select count(*) into v_lixeira from rh.lixeira() l where l.id = v_colab;
  begin
    perform rh.excluir_colaborador(v_colab);
  exception when no_data_found then
    v_de_novo := 'nao_encontrado';
  end;
  perform rh.restaurar_colaborador(v_colab);
  select count(*) into v_ve from rh.colaboradores where id = v_colab;
  begin
    perform rh.restaurar_colaborador(v_colab);
  exception when no_data_found then
    v_nao_esta := 'nao_encontrado';
  end;
  raise exception 'RESULTADO (nada foi salvo): excluiu=% | ve_na_lixeira=% | lixeira=% | restaurou=% | ve_restaurado=% | excluir_de_novo_na_lixeira=% | restaurar_quem_nao_esta=%',
    v_excluiu, v_ve_lixo, v_lixeira, v_restaurou, v_ve, v_de_novo, v_nao_esta;
end $$;
reset role;
rollback;


-- -----------------------------------------------------------------------------
-- R.4 Só rh/admin mexem na lixeira (esperado: rh_restrito=excluir:bloqueado restaurar:bloqueado lixeira:bloqueado ve_excluido:0 | diretoria=excluir:bloqueado restaurar:bloqueado lixeira:bloqueado ve_excluido:0 | motorista=excluir:bloqueado restaurar:bloqueado lixeira:bloqueado ve_excluido:0 | anon=excluir:bloqueado restaurar:bloqueado lixeira:bloqueado | nada_mudou=true)
-- -----------------------------------------------------------------------------
begin;
select set_config('request.jwt.claims',
         json_build_object('sub', '00000000-0000-0000-0000-0000000000a1', 'role', 'authenticated',
                           'email', 'rh@teste.local',
                           'app_metadata', json_build_object('role', 'rh'))::text, true);
do $$
declare
  v_ativo uuid;
  v_lixo uuid;
begin
  insert into rh.colaboradores (nome, vinculo) values ('Ativo R05', 'CLT') returning id into v_ativo;
  insert into rh.colaboradores (nome, vinculo) values ('Lixo R05', 'CLT') returning id into v_lixo;
  perform rh.excluir_colaborador(v_lixo);
  perform set_config('r05.ativo', v_ativo::text, true);
  perform set_config('r05.lixo', v_lixo::text, true);
  perform set_config('r05.saida', '', true);
  perform set_config('r05.foto', (select string_agg(c.nome || ':' || coalesce(c.excluido_em::text, '-'), ',' order by c.nome)
                                    from rh.colaboradores c), true);
end $$;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated","app_metadata":{"role":"rh_restrito"}}', true);
set local role authenticated;
do $$
declare
  v_ex text := 'LIBERADO';
  v_re text := 'LIBERADO';
  v_li text := 'LIBERADO';
  v_ve text := '';
begin
  begin
    perform rh.excluir_colaborador(current_setting('r05.ativo')::uuid);
  exception when insufficient_privilege then v_ex := 'bloqueado';
  end;
  begin
    perform rh.restaurar_colaborador(current_setting('r05.lixo')::uuid);
  exception when insufficient_privilege then v_re := 'bloqueado';
  end;
  begin
    perform count(*) from rh.lixeira();
  exception when insufficient_privilege then v_li := 'bloqueado';
  end;
  v_ve := ' ve_excluido:' || (select count(*) from rh.colaboradores where id = current_setting('r05.lixo')::uuid);
  perform set_config('r05.saida', current_setting('r05.saida') || ' | rh_restrito=excluir:' || v_ex
                     || ' restaurar:' || v_re || ' lixeira:' || v_li || v_ve, true);
end $$;
reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000d4","role":"authenticated","app_metadata":{"role":"diretoria"}}', true);
set local role authenticated;
do $$
declare
  v_ex text := 'LIBERADO';
  v_re text := 'LIBERADO';
  v_li text := 'LIBERADO';
  v_ve text := '';
begin
  begin
    perform rh.excluir_colaborador(current_setting('r05.ativo')::uuid);
  exception when insufficient_privilege then v_ex := 'bloqueado';
  end;
  begin
    perform rh.restaurar_colaborador(current_setting('r05.lixo')::uuid);
  exception when insufficient_privilege then v_re := 'bloqueado';
  end;
  begin
    perform count(*) from rh.lixeira();
  exception when insufficient_privilege then v_li := 'bloqueado';
  end;
  v_ve := ' ve_excluido:' || (select count(*) from rh.colaboradores where id = current_setting('r05.lixo')::uuid);
  perform set_config('r05.saida', current_setting('r05.saida') || ' | diretoria=excluir:' || v_ex
                     || ' restaurar:' || v_re || ' lixeira:' || v_li || v_ve, true);
end $$;
reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000e5","role":"authenticated","app_metadata":{"role":"motorista"}}', true);
set local role authenticated;
do $$
declare
  v_ex text := 'LIBERADO';
  v_re text := 'LIBERADO';
  v_li text := 'LIBERADO';
  v_ve text := '';
begin
  begin
    perform rh.excluir_colaborador(current_setting('r05.ativo')::uuid);
  exception when insufficient_privilege then v_ex := 'bloqueado';
  end;
  begin
    perform rh.restaurar_colaborador(current_setting('r05.lixo')::uuid);
  exception when insufficient_privilege then v_re := 'bloqueado';
  end;
  begin
    perform count(*) from rh.lixeira();
  exception when insufficient_privilege then v_li := 'bloqueado';
  end;
  v_ve := ' ve_excluido:' || (select count(*) from rh.colaboradores where id = current_setting('r05.lixo')::uuid);
  perform set_config('r05.saida', current_setting('r05.saida') || ' | motorista=excluir:' || v_ex
                     || ' restaurar:' || v_re || ' lixeira:' || v_li || v_ve, true);
end $$;
reset role;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
set local role anon;
do $$
declare
  v_ex text := 'LIBERADO';
  v_re text := 'LIBERADO';
  v_li text := 'LIBERADO';
  v_ve text := '';
begin
  begin
    perform rh.excluir_colaborador(current_setting('r05.ativo')::uuid);
  exception when insufficient_privilege then v_ex := 'bloqueado';
  end;
  begin
    perform rh.restaurar_colaborador(current_setting('r05.lixo')::uuid);
  exception when insufficient_privilege then v_re := 'bloqueado';
  end;
  begin
    perform count(*) from rh.lixeira();
  exception when insufficient_privilege then v_li := 'bloqueado';
  end;
  perform set_config('r05.saida', current_setting('r05.saida') || ' | anon=excluir:' || v_ex
                     || ' restaurar:' || v_re || ' lixeira:' || v_li || v_ve, true);
end $$;
reset role;
do $$
begin
  raise exception 'RESULTADO (nada foi salvo): %| nada_mudou=%',
    substr(current_setting('r05.saida'), 4) || ' ',
    (current_setting('r05.foto') = (select string_agg(c.nome || ':' || coalesce(c.excluido_em::text, '-'), ',' order by c.nome)
                                      from rh.colaboradores c))::text;
end $$;
rollback;


-- -----------------------------------------------------------------------------
-- R.5 Ninguém preenche a lixeira por fora das RPCs; delete continua barrado (esperado: rh_update_excluido_em=ignorado | rh_insert_com_excluido=ignorado | rh_le_excluido=0 linhas | rh_altera_excluido=0 linhas | rh_cria_processo_do_excluido=bloqueado | rh_observa_etapa_do_excluido=bloqueado | rh_delete=bloqueado | dono_delete=bloqueado | dono_update_excluido_em=ignorado)
-- -----------------------------------------------------------------------------
begin;
select set_config('request.jwt.claims',
         json_build_object('sub', '00000000-0000-0000-0000-0000000000a1', 'role', 'authenticated',
                           'email', 'rh@teste.local',
                           'app_metadata', json_build_object('role', 'rh'))::text, true);
do $$
declare
  v_ativo uuid;
  v_lixo uuid;
  v_proc uuid;
  v_etapa uuid;
  v_dono_delete text := 'LIBERADO';
begin
  insert into rh.colaboradores (nome, vinculo) values ('Ativo R05', 'CLT') returning id into v_ativo;
  insert into rh.colaboradores (nome, vinculo) values ('Lixo R05', 'CLT') returning id into v_lixo;
  insert into rh.processos (colaborador_id, modelo_id, modelo_nome)
  select v_lixo, m.id, m.nome from rh.modelos m where m.chave = 'rescisao_clt' returning id into v_proc;
  insert into rh.etapas (processo_id, ordem, nome) values (v_proc, 1, 'Comunicação') returning id into v_etapa;
  perform rh.excluir_colaborador(v_lixo);
  update rh.colaboradores set excluido_em = now() - interval '1 day' where id = v_ativo;
  begin
    delete from rh.colaboradores where id = v_lixo;
  exception when insufficient_privilege then v_dono_delete := 'bloqueado';
  end;
  perform set_config('r05.ativo', v_ativo::text, true);
  perform set_config('r05.lixo', v_lixo::text, true);
  perform set_config('r05.etapa', v_etapa::text, true);
  perform set_config('r05.dono', 'dono_delete=' || v_dono_delete || ' | dono_update_excluido_em='
    || case when (select excluido_em from rh.colaboradores where id = v_ativo) is null then 'ignorado' else 'GRAVOU' end, true);
end $$;
set local role authenticated;
do $$
declare
  v_ativo uuid := current_setting('r05.ativo')::uuid;
  v_lixo uuid := current_setting('r05.lixo')::uuid;
  v_novo uuid;
  v_n bigint;
  v_upd text;
  v_ins text;
  v_le text;
  v_altera text;
  v_proc text := 'LIBERADO';
  v_obs text := 'LIBERADO';
  v_del text := 'LIBERADO';
begin
  update rh.colaboradores set excluido_em = now(), excluido_por = auth.uid(), excluido_por_email = 'x' where id = v_ativo;
  v_upd := case when (select excluido_em from rh.colaboradores where id = v_ativo) is null then 'ignorado' else 'GRAVOU' end;

  insert into rh.colaboradores (nome, vinculo, excluido_em, excluido_por) values ('Já excluído R05', 'CLT', now(), auth.uid())
  returning id into v_novo;
  v_ins := case when (select excluido_em from rh.colaboradores where id = v_novo) is null then 'ignorado' else 'GRAVOU' end;

  select count(*) into v_n from rh.colaboradores where id = v_lixo;
  v_le := v_n || ' linhas';
  update rh.colaboradores set cargo = 'Alterado' where id = v_lixo;
  get diagnostics v_n = row_count;
  v_altera := v_n || ' linhas';

  begin
    insert into rh.processos (colaborador_id, modelo_id, modelo_nome)
    select v_lixo, m.id, m.nome from rh.modelos m where m.chave = 'rescisao_clt';
  exception when insufficient_privilege then v_proc := 'bloqueado';
  end;
  begin
    insert into rh.observacoes (etapa_id, texto) values (current_setting('r05.etapa')::uuid, 'não pode');
  exception when insufficient_privilege then v_obs := 'bloqueado';
  end;
  begin
    delete from rh.colaboradores where id = v_ativo;
  exception when insufficient_privilege then v_del := 'bloqueado';
  end;

  raise exception 'RESULTADO (nada foi salvo): rh_update_excluido_em=% | rh_insert_com_excluido=% | rh_le_excluido=% | rh_altera_excluido=% | rh_cria_processo_do_excluido=% | rh_observa_etapa_do_excluido=% | rh_delete=% | %',
    v_upd, v_ins, v_le, v_altera, v_proc, v_obs, v_del, current_setting('r05.dono');
end $$;
reset role;
rollback;


-- -----------------------------------------------------------------------------
-- R.6 Retrato do public DEPOIS (tem que dar igual ao R.0)
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
