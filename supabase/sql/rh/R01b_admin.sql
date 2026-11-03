-- =============================================================================
-- R01b - Admin com o mesmo acesso do 'rh' no schema rh   RASCUNHO - AINDA NÃO RODADO
--
-- Rode DEPOIS do R01 (este arquivo só altera o que o R01 criou).
--
-- Decisão: admin (app_metadata.role = 'admin') tem no schema rh a mesma
-- permissão do papel 'rh': lê e grava tudo e lê a auditoria. Nada de delete.
--   - diretoria e motorista continuam sem acesso (por isso NÃO usa
--     public.is_admin(), que também vale para a diretoria);
--   - 'rh' e 'rh_restrito' continuam exatamente como no R01.
--
-- O que muda:
--   - nova função rh.eh_admin() (security definer, search_path vazio,
--     executável só por authenticated);
--   - nas policies do schema rh, onde valia rh.eh_rh() passa a valer
--     rh.eh_rh() or rh.eh_admin() (select, insert e update, inclusive a
--     auditoria). Grants, triggers e tabelas não mudam.
--
-- Como rodar (no SQL Editor, uma parte de cada vez):
--   R.0  retrato do public ANTES (tem que dar igual ao R.0/R.9 do R01);
--   1-2  bloco principal (begin ... commit); pode rodar de novo;
--   R.1-R.6 conferências, uma por vez: cada uma termina com
--        raise exception 'RESULTADO ...' + rollback (nada fica salvo);
--   R.7  retrato do public DEPOIS (tem que dar igual ao R.0).
--   Obs.: depois deste arquivo a conferência R.3 do R01 deixa de valer para
--   'admin' (agora lê e grava); motorista e diretoria seguem iguais.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- R.0 Retrato do public (rode ANTES e anote; o R.7 repete e tem que dar igual)
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
-- BLOCO PRINCIPAL (1 e 2)
-- =============================================================================
begin;


-- -----------------------------------------------------------------------------
-- 1. Papel admin (só app_metadata.role = 'admin'; diretoria fica de fora)
-- -----------------------------------------------------------------------------
create or replace function rh.eh_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select auth.jwt()) -> 'app_metadata' ->> 'role', '') = 'admin'
$$;

revoke all on function rh.eh_admin() from public, anon, authenticated, service_role;
grant execute on function rh.eh_admin() to authenticated;


-- -----------------------------------------------------------------------------
-- 2. Policies: onde valia rh.eh_rh(), passa a valer rh.eh_rh() or rh.eh_admin()
--    (alter policy: só troca a regra; nomes, comandos e papéis ficam iguais;
--    continua sem nenhuma policy de delete)
-- -----------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['colaboradores', 'modelos', 'modelo_etapas', 'processos', 'etapas',
                           'observacoes', 'contratos_pj', 'exames', 'ferias'] loop
    execute format('alter policy rh_le on rh.%I
                    using (rh.eh_rh() or rh.eh_admin() or rh.eh_rh_restrito())', t);
  end loop;

  foreach t in array array['colaboradores', 'modelos', 'modelo_etapas', 'processos', 'etapas',
                           'contratos_pj', 'exames', 'ferias'] loop
    execute format('alter policy rh_insere on rh.%I
                    with check (rh.eh_rh() or rh.eh_admin())', t);
  end loop;

  foreach t in array array['colaboradores', 'modelos', 'modelo_etapas', 'processos',
                           'contratos_pj', 'exames', 'ferias'] loop
    execute format('alter policy rh_atualiza on rh.%I
                    using (rh.eh_rh() or rh.eh_admin()) with check (rh.eh_rh() or rh.eh_admin())', t);
  end loop;
end $$;

alter policy rh_atualiza on rh.etapas
  using (rh.eh_rh() or rh.eh_admin() or rh.eh_rh_restrito())
  with check (rh.eh_rh() or rh.eh_admin() or rh.eh_rh_restrito());

alter policy rh_insere on rh.observacoes
  with check (rh.eh_rh() or rh.eh_admin() or rh.eh_rh_restrito());

alter policy rh_le on rh.auditoria using (rh.eh_rh() or rh.eh_admin());


commit;


-- =============================================================================
-- CONFERÊNCIAS (rode uma por vez; cada uma termina com RESULTADO + rollback)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- R.1 Função e policies (esperado: eh_admin=definer:true search_path="" | executa=authenticated:true anon:false service_role:false | usa_is_admin_ou_diretoria=false | policies=27 | com_admin=27 | sem_admin=nenhuma | com_restrito=11 | policies_delete=0 | observacoes=INSERT,SELECT | auditoria=SELECT | delete_ou_truncate=0)
-- -----------------------------------------------------------------------------
do $$
begin
  raise exception 'RESULTADO: eh_admin=definer:% % | executa=authenticated:% anon:% service_role:% | usa_is_admin_ou_diretoria=% | policies=% | com_admin=% | sem_admin=% | com_restrito=% | policies_delete=% | observacoes=% | auditoria=% | delete_ou_truncate=%',
    (select p.prosecdef::text from pg_proc p where p.oid = 'rh.eh_admin()'::regprocedure),
    (select coalesce(array_to_string(p.proconfig, ','), 'SEM search_path') from pg_proc p where p.oid = 'rh.eh_admin()'::regprocedure),
    has_function_privilege('authenticated', 'rh.eh_admin()', 'execute')::text,
    has_function_privilege('anon', 'rh.eh_admin()', 'execute')::text,
    has_function_privilege('service_role', 'rh.eh_admin()', 'execute')::text,
    (select (p.prosrc ilike '%is_admin%' or p.prosrc ilike '%diretoria%')::text
       from pg_proc p where p.oid = 'rh.eh_admin()'::regprocedure),
    (select count(*) from pg_policies where schemaname = 'rh'),
    (select count(*) from pg_policies where schemaname = 'rh'
        and coalesce(qual, with_check) like '%eh_admin()%'
        and (with_check is null or with_check like '%eh_admin()%')),
    (select coalesce(string_agg(tablename || '.' || policyname, ', ' order by tablename, policyname), 'nenhuma')
       from pg_policies where schemaname = 'rh'
        and not (coalesce(qual, with_check) like '%eh_admin()%' and (with_check is null or with_check like '%eh_admin()%'))),
    (select count(*) from pg_policies where schemaname = 'rh' and coalesce(qual, with_check) like '%eh_rh_restrito()%'),
    (select count(*) from pg_policies where schemaname = 'rh' and cmd in ('DELETE', 'ALL')),
    (select string_agg(a.privilege_type, ',' order by a.privilege_type) from pg_class c, aclexplode(c.relacl) a
      where c.oid = 'rh.observacoes'::regclass and a.grantee = 'authenticated'::regrole::oid),
    (select string_agg(a.privilege_type, ',' order by a.privilege_type) from pg_class c, aclexplode(c.relacl) a
      where c.oid = 'rh.auditoria'::regclass and a.grantee = 'authenticated'::regrole::oid),
    (select count(*) from pg_class c, aclexplode(c.relacl) a
      where c.relnamespace = 'rh'::regnamespace and a.privilege_type in ('DELETE', 'TRUNCATE')
        and a.grantee <> c.relowner);
end $$;


-- -----------------------------------------------------------------------------
-- R.2 Admin lê e grava todas as tabelas e lê a auditoria (esperado: gravou=ok | atualizou=8 de 8 | leu: colaboradores=2 processos=1 etapas=7 observacoes=1 contratos=1 exames=1 ferias=1 modelos=4 modelo_etapas=19 | auditoria_lida=8 | carimbos_do_servidor=true | etapa_concluida_e_renomeada=true)
-- -----------------------------------------------------------------------------
begin;
select set_config('request.jwt.claims',
         json_build_object('sub', '00000000-0000-0000-0000-0000000000c3', 'role', 'authenticated',
                           'email', 'admin@teste.local',
                           'app_metadata', json_build_object('role', 'admin'))::text, true);
set local role authenticated;
do $$
declare
  v_sub uuid := '00000000-0000-0000-0000-0000000000c3';
  v_colab uuid;
  v_pj uuid;
  v_modelo uuid;
  v_admissao uuid;
  v_me uuid;
  v_proc uuid;
  v_etapa uuid;
  v_ct uuid;
  v_ex uuid;
  v_fe uuid;
  v_n bigint;
  v_atu int := 0;
  v_leu text;
begin
  insert into rh.colaboradores (nome, cargo, setor, vinculo, situacao, data_admissao)
  values ('Teste CLT R01b', 'Analista', 'RH', 'CLT', 'Ativo', current_date - 400) returning id into v_colab;
  insert into rh.colaboradores (nome, cargo, setor, vinculo, situacao, data_admissao)
  values ('Teste PJ R01b', 'Consultor', 'TI', 'PJ', 'Ativo', current_date - 300) returning id into v_pj;

  select id into v_modelo from rh.modelos where chave = 'rescisao_clt';
  select id into v_admissao from rh.modelos where chave = 'admissao_clt';
  insert into rh.modelo_etapas (modelo_id, ordem, nome) values (v_admissao, 1, 'Etapa R01b') returning id into v_me;

  insert into rh.processos (colaborador_id, modelo_id, modelo_nome)
  values (v_colab, v_modelo, 'Rescisão CLT') returning id into v_proc;
  insert into rh.etapas (processo_id, ordem, nome)
  select v_proc, e.ordem, e.nome from rh.modelo_etapas e where e.modelo_id = v_modelo and e.ativo;
  select id into v_etapa from rh.etapas where processo_id = v_proc order by ordem limit 1;

  insert into rh.observacoes (etapa_id, texto) values (v_etapa, 'Comunicado entregue');
  insert into rh.contratos_pj (colaborador_id, inicio, fim, valor, aviso_dias)
  values (v_pj, current_date - 300, current_date + 30, 12500.50, 30) returning id into v_ct;
  insert into rh.exames (colaborador_id, tipo, data_realizacao, vencimento)
  values (v_colab, 'periodico', current_date - 340, current_date + 25) returning id into v_ex;
  insert into rh.ferias (colaborador_id, aquisitivo_inicio, saldo_dias)
  values (v_colab, date '2024-12-02', 30) returning id into v_fe;

  -- Um update em cada uma das 8 tabelas que mudam
  update rh.colaboradores set situacao = 'Em desligamento' where id = v_colab;
  get diagnostics v_n = row_count; v_atu := v_atu + v_n;
  update rh.modelos set nome = 'Admissão CLT (R01b)' where id = v_admissao;
  get diagnostics v_n = row_count; v_atu := v_atu + v_n;
  update rh.modelo_etapas set nome = 'Etapa R01b renomeada' where id = v_me;
  get diagnostics v_n = row_count; v_atu := v_atu + v_n;
  update rh.processos set modelo_nome = 'Rescisão CLT (R01b)' where id = v_proc;
  get diagnostics v_n = row_count; v_atu := v_atu + v_n;
  update rh.etapas set concluida = true, nome = 'Comunicação feita', responsavel = 'DP' where id = v_etapa;
  get diagnostics v_n = row_count; v_atu := v_atu + v_n;
  update rh.contratos_pj set valor = 13000 where id = v_ct;
  get diagnostics v_n = row_count; v_atu := v_atu + v_n;
  update rh.exames set vencimento = current_date + 60 where id = v_ex;
  get diagnostics v_n = row_count; v_atu := v_atu + v_n;
  update rh.ferias set saldo_dias = 20 where id = v_fe;
  get diagnostics v_n = row_count; v_atu := v_atu + v_n;

  v_leu := format('colaboradores=%s processos=%s etapas=%s observacoes=%s contratos=%s exames=%s ferias=%s modelos=%s modelo_etapas=%s',
    (select count(*) from rh.colaboradores where criado_por = v_sub),
    (select count(*) from rh.processos where criado_por = v_sub),
    (select count(*) from rh.etapas where criado_por = v_sub),
    (select count(*) from rh.observacoes where autor = v_sub),
    (select count(*) from rh.contratos_pj where criado_por = v_sub),
    (select count(*) from rh.exames where criado_por = v_sub),
    (select count(*) from rh.ferias where criado_por = v_sub),
    (select count(*) from rh.modelos),
    (select count(*) from rh.modelo_etapas));

  raise exception 'RESULTADO (nada foi salvo): gravou=ok | atualizou=% de 8 | leu: % | auditoria_lida=% | carimbos_do_servidor=% | etapa_concluida_e_renomeada=%',
    v_atu, v_leu,
    (select count(*) from rh.auditoria where quem = v_sub),
    (select (criado_por = v_sub and atualizado_por = v_sub and atualizado_em = now())::text
       from rh.colaboradores where id = v_colab),
    (select (concluida and concluida_por = v_sub and concluida_em = now() and nome = 'Comunicação feita')::text
       from rh.etapas where id = v_etapa);
end $$;
reset role;
rollback;


-- -----------------------------------------------------------------------------
-- R.3 Observação do admin: autor/hora do servidor; não edita nem apaga; sem delete físico; auditoria intocável (esperado: autor_servidor=true | email_servidor=true | hora_servidor=true | admin_edita_obs=bloqueado | admin_apaga_obs=bloqueado | dono_edita_obs=bloqueado | dono_apaga_obs=bloqueado | admin_altera_auditoria=bloqueado | admin_apaga_auditoria=bloqueado | delete_admin=colaboradores:bloqueado modelos:bloqueado modelo_etapas:bloqueado processos:bloqueado etapas:bloqueado contratos_pj:bloqueado exames:bloqueado ferias:bloqueado)
-- -----------------------------------------------------------------------------
begin;
do $$
declare
  v_colab uuid;
  v_proc uuid;
  v_etapa uuid;
begin
  insert into rh.colaboradores (nome, vinculo) values ('Teste R01b', 'CLT') returning id into v_colab;
  insert into rh.processos (colaborador_id, modelo_id, modelo_nome)
  select v_colab, m.id, m.nome from rh.modelos m where m.chave = 'rescisao_clt' returning id into v_proc;
  insert into rh.etapas (processo_id, ordem, nome) values (v_proc, 1, 'Comunicação') returning id into v_etapa;
  perform set_config('r01b.colab', v_colab::text, true);
  perform set_config('r01b.etapa', v_etapa::text, true);
end $$;
select set_config('request.jwt.claims',
         json_build_object('sub', '00000000-0000-0000-0000-0000000000c3', 'role', 'authenticated',
                           'email', 'admin@teste.local',
                           'app_metadata', json_build_object('role', 'admin'))::text, true);
set local role authenticated;
do $$
declare
  v_colab uuid := current_setting('r01b.colab')::uuid;
  v_etapa uuid := current_setting('r01b.etapa')::uuid;
  v_obs rh.observacoes;
  v_aud bigint;
  v_upd text := 'LIBERADO';
  v_del text := 'LIBERADO';
  v_aud_upd text := 'LIBERADO';
  v_aud_del text := 'LIBERADO';
  v_apagar text := '';
  t text;
begin
  -- O navegador tenta mandar autor, e-mail e hora falsos
  insert into rh.observacoes (etapa_id, texto, autor, autor_email, criado_em)
  values (v_etapa, 'Texto original', gen_random_uuid(), 'falso@invasor', timestamptz '2000-01-01')
  returning * into v_obs;
  perform set_config('r01b.obs', v_obs.id::text, true);
  perform set_config('r01b.autor', (v_obs.autor = '00000000-0000-0000-0000-0000000000c3')::text, true);
  perform set_config('r01b.email', (v_obs.autor_email = 'admin@teste.local')::text, true);
  perform set_config('r01b.hora', (v_obs.criado_em = now())::text, true);

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

  -- Gera uma linha de auditoria (o admin lê) e tenta mexer nela
  update rh.colaboradores set cargo = 'Analista' where id = v_colab;
  select id into v_aud from rh.auditoria where tabela = 'colaboradores' and registro_id = v_colab;
  begin
    update rh.auditoria set tabela = 'x' where id = v_aud;
  exception when insufficient_privilege then
    v_aud_upd := 'bloqueado';
  end;
  begin
    delete from rh.auditoria where id = v_aud;
  exception when insufficient_privilege then
    v_aud_del := 'bloqueado';
  end;
  if v_aud is null then
    v_aud_upd := 'SEM AUDITORIA';
    v_aud_del := 'SEM AUDITORIA';
  end if;

  foreach t in array array['colaboradores', 'modelos', 'modelo_etapas', 'processos', 'etapas',
                           'contratos_pj', 'exames', 'ferias'] loop
    begin
      execute format('delete from rh.%I', t);
      v_apagar := v_apagar || t || ':LIBERADO ';
    exception when insufficient_privilege then
      v_apagar := v_apagar || t || ':bloqueado ';
    end;
  end loop;

  perform set_config('r01b.admin',
    format('admin_edita_obs=%s | admin_apaga_obs=%s', v_upd, v_del), true);
  perform set_config('r01b.auditoria',
    format('admin_altera_auditoria=%s | admin_apaga_auditoria=%s', v_aud_upd, v_aud_del), true);
  perform set_config('r01b.apagar', btrim(v_apagar), true);
end $$;
reset role;
do $$
declare
  v_obs uuid := current_setting('r01b.obs')::uuid;
  v_upd text := 'LIBERADO';
  v_del text := 'LIBERADO';
begin
  -- Nem o dono das tabelas (postgres) altera ou apaga a observação
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
  raise exception 'RESULTADO (nada foi salvo): autor_servidor=% | email_servidor=% | hora_servidor=% | % | dono_edita_obs=% | dono_apaga_obs=% | % | delete_admin=%',
    current_setting('r01b.autor'), current_setting('r01b.email'), current_setting('r01b.hora'),
    current_setting('r01b.admin'), v_upd, v_del, current_setting('r01b.auditoria'), current_setting('r01b.apagar');
end $$;
rollback;


-- -----------------------------------------------------------------------------
-- R.4 Motorista e diretoria continuam sem nada (esperado: motorista=linhas_lidas:0 gravar:bloqueado atualizar:0 linhas observacao:bloqueado eh_admin:false | diretoria=linhas_lidas:0 gravar:bloqueado atualizar:0 linhas observacao:bloqueado eh_admin:false | linhas_no_banco>0=true)
--     Antes, como dono, grava 1 colaborador + 1 processo + 1 etapa + 1 observação
--     + 1 linha de auditoria para provar que existe o que ler.
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
  insert into rh.colaboradores (nome, vinculo) values ('Teste R01b', 'CLT') returning id into v_colab;
  insert into rh.processos (colaborador_id, modelo_id, modelo_nome)
  select v_colab, m.id, m.nome from rh.modelos m where m.chave = 'rescisao_clt' returning id into v_proc;
  insert into rh.etapas (processo_id, ordem, nome) values (v_proc, 1, 'Comunicação') returning id into v_etapa;
  insert into rh.observacoes (etapa_id, texto) values (v_etapa, 'Observação de teste');
  update rh.colaboradores set cargo = 'Analista' where id = v_colab;
  perform set_config('r01b.etapa', v_etapa::text, true);
  perform set_config('r01b.linhas', (select (count(*) > 0)::text from rh.auditoria), true);
end $$;
set local role authenticated;
do $$
declare
  v_etapa uuid := current_setting('r01b.etapa')::uuid;
  v_papel text;
  o text;
  v_n bigint;
  v_total bigint;
  v_grava text;
  v_obs text;
  v_res text := '';
begin
  foreach v_papel in array array['motorista', 'diretoria'] loop
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
      insert into rh.colaboradores (nome, vinculo) values ('Invasor R01b', 'CLT');
      v_grava := 'LIBERADO';
    exception when insufficient_privilege then
      v_grava := 'bloqueado';
    end;
    update rh.colaboradores set cargo = 'Invadido';
    get diagnostics v_n = row_count;
    begin
      insert into rh.observacoes (etapa_id, texto) values (v_etapa, 'Invasor R01b');
      v_obs := 'LIBERADO';
    exception when insufficient_privilege then
      v_obs := 'bloqueado';
    end;
    v_res := v_res || v_papel || '=linhas_lidas:' || v_total || ' gravar:' || v_grava
             || ' atualizar:' || v_n || ' linhas observacao:' || v_obs
             || ' eh_admin:' || rh.eh_admin()::text || ' | ';
  end loop;
  raise exception 'RESULTADO (nada foi salvo): %linhas_no_banco>0=%', v_res, current_setting('r01b.linhas');
end $$;
reset role;
rollback;


-- -----------------------------------------------------------------------------
-- R.5 'rh' igual ao R01 (mesmo teste e mesmo esperado do R.4 do R01) (esperado: gravou=ok | leu: colaboradores=2 processos=1 etapas=7 observacoes=1 contratos=1 exames=1 ferias=1 modelos=4 auditoria=2 | carimbos_do_servidor=t | concessivo_calculado=t)
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
-- R.6 'rh_restrito' igual ao R01 (mesmo teste e mesmo esperado do R.5 do R01) (esperado: criar_colaborador=bloqueado | observacao=gravou | concluir_etapa=gravou | renomear_etapa=bloqueado | editar_colaborador=0 linhas | criar_exame=bloqueado | le_colaborador=t | le_auditoria=0 linhas)
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
-- R.7 Nada mudou no public (esperado: o mesmo retrato_public e itens do R.0)
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
