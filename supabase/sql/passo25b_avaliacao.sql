-- =============================================================================
-- PASSO 25b - Avaliação "Apto / Inapto" no Dashboard do Cadastro     RASCUNHO - AINDA NÃO RODADO
-- AJBorges Transporte & Logística
--
-- Rode DEPOIS do passo25 (cadastro único). É uma marcação extra, só para controle
-- da gestão: NÃO muda a aprovação/recusa (status) nem a trava por CPF/CNPJ.
--
--   1. Colunas novas em public.cadastros_agregados, todas nulas:
--        avaliacao        'apto' | 'inapto' | null (= "Sem avaliação")
--        avaliacao_motivo opcional, até 300 letras
--        avaliado_por     e-mail de quem marcou (vem do servidor)
--        avaliado_em      quando marcou (vem do servidor)
--      Os cadastros que já existem ficam com as 4 colunas nulas ("Sem avaliação"):
--      add column sem default não reescreve nenhuma linha e nenhum outro campo muda.
--   2. RPC public.avaliar_cadastro(p_id, p_avaliacao, p_motivo): só is_admin()
--      (admin/diretoria); grava só as 4 colunas.
--   3. Trigger trg_cadastro_avaliacao (BEFORE INSERT OR UPDATE): cadastro novo nasce
--      sem avaliação (a ficha e a edge function não conseguem marcar); mudar
--      qualquer uma das 4 colunas exige is_admin(), e quem/quando são sempre
--      os do servidor (não dá para escrever outro nome ou outra data). Mudanças em
--      outras colunas (status, dados, documentos...) seguem como hoje.
--   Nenhum delete, truncate ou update de cadastro neste arquivo (fora as
--   conferências, que terminam em rollback). Nenhuma policy nova: quem lê os
--   cadastros continua sendo quem já lia (admin/diretoria, pela RLS de hoje).
--
-- Como rodar (SQL Editor do Supabase):
--   a) rode o item 0 sozinho e anote o resultado;
--   b) rode do "begin;" até o "commit;" (se algo falhar, nada é alterado; pode ser
--      reexecutado);
--   c) rode cada conferência do item 7 separadamente (tudo é desfeito com
--      rollback; o resultado aparece como erro "RESULTADO ...");
--   d) o 7.6 repete o item 0: tem que dar igual (rode num horário calmo).
-- Depois: publicar o site (o dashboard passa a mostrar e marcar a avaliação).
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 0. ANTES (só leitura): retrato do public, cadastros (sem as colunas novas) e arquivos
--    (anote; o 7.6 repete e tem que dar igual. O retrato deixa de fora só as 4
--     colunas, as 2 funções e o trigger que este passo cria)
-- -----------------------------------------------------------------------------
select (select md5(string_agg(x, E'\n' order by x)) from (
          select 'rel ' || c.relname || ' ' || c.relkind::text || ' ' || coalesce(c.relacl::text, '') || ' ' || c.relrowsecurity as x
            from pg_class c where c.relnamespace = 'public'::regnamespace
          union all
          select 'col ' || c.relname || '.' || a.attname || ' ' || format_type(a.atttypid, a.atttypmod) || ' ' || coalesce(a.attacl::text, '')
            from pg_attribute a join pg_class c on c.oid = a.attrelid
           where c.relnamespace = 'public'::regnamespace and a.attnum > 0 and not a.attisdropped
             and not (c.relname = 'cadastros_agregados' and a.attname in ('avaliacao', 'avaliacao_motivo', 'avaliado_por', 'avaliado_em'))
          union all
          select 'fn ' || p.oid::regprocedure::text || ' ' || md5(p.prosrc) || ' ' || coalesce(p.proacl::text, '') || ' '
                 || p.prosecdef || ' ' || coalesce(array_to_string(p.proconfig, ','), '')
            from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname not in ('avaliar_cadastro', 'cadastro_avaliacao_guarda')
          union all
          select 'pol ' || tablename || ' ' || policyname || ' ' || cmd || ' ' || array_to_string(roles, ',') || ' '
                 || coalesce(qual, '') || ' ' || coalesce(with_check, '')
            from pg_policies where schemaname = 'public'
          union all
          select 'trg ' || c.relname || ' ' || t.tgname || ' ' || t.tgenabled::text
            from pg_trigger t join pg_class c on c.oid = t.tgrelid
           where c.relnamespace = 'public'::regnamespace and not t.tgisinternal and t.tgname <> 'trg_cadastro_avaliacao'
          union all
          select 'nsp ' || coalesce(n.nspacl::text, '') from pg_namespace n where n.nspname = 'public'
        ) s) as retrato_public,
       (select count(*) from public.cadastros_agregados) as cadastros,
       (select md5(coalesce(string_agg((to_jsonb(c) - array['avaliacao', 'avaliacao_motivo', 'avaliado_por', 'avaliado_em'])::text, E'\n' order by c.id), ''))
          from public.cadastros_agregados c) as md5_cadastros_sem_colunas_novas,
       (select count(*) from storage.objects o where o.bucket_id = 'documentos-cadastro') as arquivos,
       (select md5(coalesce(string_agg(o.id::text || ' ' || o.name, E'\n' order by o.name), ''))
          from storage.objects o where o.bucket_id = 'documentos-cadastro') as md5_arquivos;


begin;


-- -----------------------------------------------------------------------------
-- 1. Colunas (as linhas que já existem ficam nulas = "Sem avaliação")
-- -----------------------------------------------------------------------------
alter table public.cadastros_agregados add column if not exists avaliacao text;
alter table public.cadastros_agregados add column if not exists avaliacao_motivo text;
alter table public.cadastros_agregados add column if not exists avaliado_por text;
alter table public.cadastros_agregados add column if not exists avaliado_em timestamptz;

alter table public.cadastros_agregados drop constraint if exists cadastros_agregados_avaliacao;
alter table public.cadastros_agregados add constraint cadastros_agregados_avaliacao
  check (avaliacao is null or avaliacao in ('apto', 'inapto'));
alter table public.cadastros_agregados drop constraint if exists cadastros_agregados_avaliacao_motivo;
alter table public.cadastros_agregados add constraint cadastros_agregados_avaliacao_motivo
  check (avaliacao_motivo is null or char_length(avaliacao_motivo) <= 300);


-- -----------------------------------------------------------------------------
-- 2. Guarda das 4 colunas (vale para a RPC e para qualquer update direto)
-- -----------------------------------------------------------------------------
create or replace function public.cadastro_avaliacao_guarda()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Cadastro novo (ficha / edge function) nasce sem avaliação
  if tg_op = 'INSERT' then
    new.avaliacao := null;
    new.avaliacao_motivo := null;
    new.avaliado_por := null;
    new.avaliado_em := null;
    return new;
  end if;

  if new.avaliacao is not distinct from old.avaliacao
     and new.avaliacao_motivo is not distinct from old.avaliacao_motivo
     and new.avaliado_por is not distinct from old.avaliado_por
     and new.avaliado_em is not distinct from old.avaliado_em then
    return new;
  end if;

  if not coalesce(public.is_admin(), false) then
    raise exception 'Acesso negado: só a gestão marca a avaliação.' using errcode = 'insufficient_privilege';
  end if;

  new.avaliacao_motivo := nullif(btrim(coalesce(new.avaliacao_motivo, '')), '');
  if new.avaliacao is null then
    new.avaliacao_motivo := null;
  end if;
  -- Quem e quando: sempre do servidor
  new.avaliado_por := coalesce(nullif(auth.jwt() ->> 'email', ''), 'admin');
  new.avaliado_em := now();
  return new;
end;
$$;

drop trigger if exists trg_cadastro_avaliacao on public.cadastros_agregados;
create trigger trg_cadastro_avaliacao
  before insert or update on public.cadastros_agregados
  for each row execute function public.cadastro_avaliacao_guarda();


-- -----------------------------------------------------------------------------
-- 3. RPC avaliar_cadastro: só admin/diretoria; grava só as colunas da avaliação
--    p_avaliacao: 'apto', 'inapto' ou null/'' (= "Sem avaliação", apaga o motivo)
-- -----------------------------------------------------------------------------
create or replace function public.avaliar_cadastro(
  p_id uuid,
  p_avaliacao text,
  p_motivo text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_avaliacao text := nullif(lower(btrim(coalesce(p_avaliacao, ''))), '');
  v_motivo    text := nullif(btrim(coalesce(p_motivo, '')), '');
  v_linha     jsonb;
begin
  if not coalesce(public.is_admin(), false) then
    raise exception 'Acesso negado.' using errcode = 'insufficient_privilege';
  end if;

  if v_avaliacao is not null and v_avaliacao not in ('apto', 'inapto') then
    raise exception 'Avaliação inválida. Use apto, inapto ou deixe sem avaliação.' using errcode = 'check_violation';
  end if;

  if char_length(coalesce(v_motivo, '')) > 300 then
    raise exception 'O motivo tem no máximo 300 letras.' using errcode = 'check_violation';
  end if;

  update public.cadastros_agregados
     set avaliacao = v_avaliacao,
         avaliacao_motivo = case when v_avaliacao is null then null else v_motivo end
   where id = p_id
  returning jsonb_build_object('id', id, 'avaliacao', avaliacao, 'avaliacao_motivo', avaliacao_motivo,
                               'avaliado_por', avaliado_por, 'avaliado_em', avaliado_em)
    into v_linha;

  if v_linha is null then
    raise exception 'Cadastro não encontrado.';
  end if;

  return v_linha;
end;
$$;


-- -----------------------------------------------------------------------------
-- 4. Permissões: só authenticated chama a RPC (e ela confere is_admin());
--    a função do trigger ninguém chama direto
-- -----------------------------------------------------------------------------
revoke all on function public.avaliar_cadastro(uuid, text, text) from public, anon, authenticated, service_role;
grant execute on function public.avaliar_cadastro(uuid, text, text) to authenticated;
revoke all on function public.cadastro_avaliacao_guarda() from public, anon, authenticated, service_role;


commit;


-- =============================================================================
-- 7. Conferências (depois do commit; rode cada bloco separadamente)
--    O resultado aparece como erro "RESULTADO ..." e tudo é desfeito (rollback).
--    As marcações são feitas em cadastros de TESTE criados dentro da transação
--    (números 999.999.999-xx, que a ficha não aceita); nenhum cadastro de verdade
--    é marcado.
-- =============================================================================

-- 7.1 Estrutura e permissões (esperado: colunas=avaliacao:text avaliacao_motivo:text avaliado_em:timestamp with time zone avaliado_por:text | checks=2 | trigger=ligado | quando=before insert update | rpc=authenticated:t anon:f definer:t config=search_path="" | guarda=anon:f authenticated:f | cadastros_com_avaliacao=0 | policies_novas=0)
do $$
begin
  raise exception 'RESULTADO: colunas=% | checks=% | trigger=% | quando=% | rpc=authenticated:% anon:% definer:% config=% | guarda=anon:% authenticated:% | cadastros_com_avaliacao=% | policies_novas=%',
    (select string_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod), ' ' order by a.attname)
       from pg_attribute a
      where a.attrelid = 'public.cadastros_agregados'::regclass and not a.attisdropped
        and a.attname in ('avaliacao', 'avaliacao_motivo', 'avaliado_por', 'avaliado_em')),
    (select count(*) from pg_constraint
      where conrelid = 'public.cadastros_agregados'::regclass
        and conname in ('cadastros_agregados_avaliacao', 'cadastros_agregados_avaliacao_motivo')),
    (select case when t.tgenabled = 'O' then 'ligado' else 'DESLIGADO' end from pg_trigger t
      where t.tgrelid = 'public.cadastros_agregados'::regclass and t.tgname = 'trg_cadastro_avaliacao'),
    -- tgtype: 2 = BEFORE, 4 = INSERT, 8 = DELETE, 16 = UPDATE
    (select case when t.tgtype & 2 = 2 then 'before' else 'after' end
            || case when t.tgtype & 4 = 4 then ' insert' else '' end
            || case when t.tgtype & 8 = 8 then ' delete' else '' end
            || case when t.tgtype & 16 = 16 then ' update' else '' end
       from pg_trigger t
      where t.tgrelid = 'public.cadastros_agregados'::regclass and t.tgname = 'trg_cadastro_avaliacao'),
    has_function_privilege('authenticated', 'public.avaliar_cadastro(uuid, text, text)', 'execute'),
    has_function_privilege('anon', 'public.avaliar_cadastro(uuid, text, text)', 'execute'),
    (select p.prosecdef from pg_proc p where p.oid = 'public.avaliar_cadastro(uuid, text, text)'::regprocedure),
    (select array_to_string(p.proconfig, ',') from pg_proc p where p.oid = 'public.avaliar_cadastro(uuid, text, text)'::regprocedure),
    has_function_privilege('anon', 'public.cadastro_avaliacao_guarda()', 'execute'),
    has_function_privilege('authenticated', 'public.cadastro_avaliacao_guarda()', 'execute'),
    (select count(*) from public.cadastros_agregados
      where avaliacao is not null or avaliacao_motivo is not null or avaliado_por is not null or avaliado_em is not null),
    (select count(*) from pg_policies where schemaname = 'public' and tablename = 'cadastros_agregados'
        and (coalesce(qual, '') || coalesce(with_check, '')) ~* 'avalia');
end $$;

-- 7.2 Admin marca apto / inapto (esperado: numeros_de_teste_livres=t | apto=apto | motivo_apto=Documentos conferidos com a GR | quem=admin@teste.local | quando_do_servidor=t | inapto=inapto | motivo_com_html_guardado_como_texto=<b>Placa</b> divergente | motivo_301=recusado | avaliacao_invalida=recusado | sem_avaliacao=(nula) motivo:(nulo) | quem_forjado_vira_o_do_servidor=admin@teste.local | insert_com_avaliacao=ignorada)
begin;
select set_config('request.jwt.claims',
         '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated","email":"admin@teste.local","app_metadata":{"role":"admin"}}', true);
insert into public.cadastros_agregados (user_id, tipo, status, nome, cpf, email, celular, sem_carreta, dados)
values (null, 'pf', 'pendente', 'Fulano de Teste P25b', '99999999991', null, '11900000000', true, '{"cpf": "99999999991"}');
select set_config('p25b.livre',
         (select case when count(*) = 1 then 't' else 'f' end from public.cadastros_agregados where regexp_replace(coalesce(cpf, ''), '\D', '', 'g') = '99999999991'), true);
select set_config('p25b.id', (select id::text from public.cadastros_agregados where cpf = '99999999991' and nome = 'Fulano de Teste P25b'), true);
set local role authenticated;
do $$
declare
  v_id     uuid := current_setting('p25b.id')::uuid;
  v_apto   jsonb;
  v_m301   text := 'ACEITO';
  v_inval  text := 'ACEITO';
  v_inapto jsonb;
  v_sem    jsonb;
begin
  v_apto := public.avaliar_cadastro(v_id, 'Apto', '  Documentos conferidos com a GR  ');
  begin perform public.avaliar_cadastro(v_id, 'inapto', repeat('x', 301));
  exception when check_violation then v_m301 := 'recusado'; end;
  begin perform public.avaliar_cadastro(v_id, 'talvez', null);
  exception when check_violation then v_inval := 'recusado'; end;
  v_inapto := public.avaliar_cadastro(v_id, 'inapto', '<b>Placa</b> divergente');
  v_sem := public.avaliar_cadastro(v_id, null, 'motivo que deve sumir');
  perform set_config('p25b.res', format('apto=%s | motivo_apto=%s | quem=%s | quando_do_servidor=%s | inapto=%s | motivo_com_html_guardado_como_texto=%s | motivo_301=%s | avaliacao_invalida=%s | sem_avaliacao=%s motivo:%s',
    v_apto ->> 'avaliacao', v_apto ->> 'avaliacao_motivo', v_apto ->> 'avaliado_por',
    case when (v_apto ->> 'avaliado_em')::timestamptz = now() then 't' else 'f' end,
    v_inapto ->> 'avaliacao', v_inapto ->> 'avaliacao_motivo', v_m301, v_inval,
    coalesce(v_sem ->> 'avaliacao', '(nula)'), coalesce(v_sem ->> 'avaliacao_motivo', '(nulo)')), true);
end $$;
reset role;
do $$
declare
  v_id uuid := current_setting('p25b.id')::uuid;
  v_novo uuid;
begin
  -- Update direto tentando escrever outro nome e outra data: o servidor troca pelos dele
  update public.cadastros_agregados
     set avaliacao = 'apto', avaliado_por = 'outra pessoa', avaliado_em = '2000-01-01'
   where id = v_id;
  -- Cadastro novo chegando já "apto" (como se a ficha mandasse): nasce sem avaliação
  insert into public.cadastros_agregados (user_id, tipo, status, nome, cpf, email, celular, sem_carreta, dados,
                                          avaliacao, avaliacao_motivo, avaliado_por, avaliado_em)
  values (null, 'pf', 'pendente', 'Ciclano de Teste P25b', '99999999992', null, '11900000000', true, '{}',
          'apto', 'forjado', 'ficha', now())
  returning id into v_novo;
  raise exception 'RESULTADO (nada foi salvo): numeros_de_teste_livres=% | % | quem_forjado_vira_o_do_servidor=% | insert_com_avaliacao=%',
    current_setting('p25b.livre'), current_setting('p25b.res'),
    (select avaliado_por || case when avaliado_em = now() then '' else ' (DATA FORJADA)' end from public.cadastros_agregados where id = v_id),
    (select case when avaliacao is null and avaliacao_motivo is null and avaliado_por is null and avaliado_em is null
                 then 'ignorada' else 'GRAVADA' end from public.cadastros_agregados where id = v_novo);
end $$;
rollback;

-- 7.3 Motorista e anon não marcam (esperado: motorista_rpc=bloqueado | motorista_update_direto=bloqueado | anon_rpc=bloqueado | sem_login_update_direto=bloqueado | motorista_ve_cadastros=0 | continua_sem_avaliacao=t)
begin;
insert into public.cadastros_agregados (user_id, tipo, status, nome, cpf, email, celular, sem_carreta, dados)
values (null, 'pf', 'pendente', 'Fulano de Teste P25b', '99999999991', null, '11900000000', true, '{}');
select set_config('p25b.id', (select id::text from public.cadastros_agregados where cpf = '99999999991'), true);
select set_config('request.jwt.claims',
         '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated","app_metadata":{"role":"motorista"}}', true);
-- update direto com o JWT do motorista (como se ele tivesse um caminho até a tabela)
do $$
declare
  v_dir text := 'LIBERADO';
begin
  begin
    update public.cadastros_agregados set avaliacao = 'apto' where id = current_setting('p25b.id')::uuid;
  exception when insufficient_privilege then v_dir := 'bloqueado'; end;
  perform set_config('p25b.dir', v_dir, true);
end $$;
set local role authenticated;
do $$
declare
  v_rpc text := 'LIBERADO';
begin
  begin perform public.avaliar_cadastro(current_setting('p25b.id')::uuid, 'apto', null);
  exception when insufficient_privilege then v_rpc := 'bloqueado'; end;
  perform set_config('p25b.rpc', v_rpc, true);
  perform set_config('p25b.ve', (select count(*)::text from public.cadastros_agregados), true);
end $$;
reset role;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
set local role anon;
do $$
declare
  v_rpc text := 'LIBERADO';
begin
  begin perform public.avaliar_cadastro(current_setting('p25b.id')::uuid, 'apto', null);
  exception when insufficient_privilege then v_rpc := 'bloqueado'; end;
  perform set_config('p25b.anon', v_rpc, true);
end $$;
reset role;
-- update direto sem login nenhum (service_role da edge function, SQL Editor): também não marca
select set_config('request.jwt.claims', '', true);
do $$
declare
  v_dir text := 'LIBERADO';
begin
  begin
    update public.cadastros_agregados set avaliacao = 'inapto' where id = current_setting('p25b.id')::uuid;
  exception when insufficient_privilege then v_dir := 'bloqueado'; end;
  raise exception 'RESULTADO (nada foi salvo): motorista_rpc=% | motorista_update_direto=% | anon_rpc=% | sem_login_update_direto=% | motorista_ve_cadastros=% | continua_sem_avaliacao=%',
    current_setting('p25b.rpc'), current_setting('p25b.dir'), current_setting('p25b.anon'), v_dir, current_setting('p25b.ve'),
    (select avaliacao is null and avaliado_por is null from public.cadastros_agregados where id = current_setting('p25b.id')::uuid);
end $$;
rollback;

-- 7.4 Marcar não muda status, documentos nem a trava por CPF (esperado: status_igual=t | documentos_iguais=t | resto_da_linha_igual=t | inapto_continua_travando=recusado | apto_num_recusado_nao_trava=aceito | inapto_nao_libera_cpf_de_ativo=recusado)
begin;
select set_config('request.jwt.claims',
         '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated","email":"admin@teste.local","app_metadata":{"role":"admin"}}', true);
insert into public.cadastros_agregados (user_id, tipo, status, nome, cpf, email, celular, sem_carreta, dados, documentos)
values (null, 'pf', 'pendente', 'Fulano de Teste P25b', '99999999991', null, '11900000000', true, '{"x": 1}',
        '[{"campo": "cnh", "path": "terceiros/teste-p25b/cnh_1_a.pdf"}]'),
       (null, 'pf', 'recusado', 'Ciclano de Teste P25b', '99999999992', null, '11900000000', true, '{}', '[]');
do $$
declare
  v_a      uuid := (select id from public.cadastros_agregados where cpf = '99999999991');
  v_b      uuid := (select id from public.cadastros_agregados where cpf = '99999999992');
  v_antes  text;
  v_status text;
  v_docs   jsonb;
  v_trava  text := 'ACEITO';
  v_livre  text := 'RECUSADO';
  v_inapto text := 'ACEITO';
begin
  select (to_jsonb(c) - array['avaliacao', 'avaliacao_motivo', 'avaliado_por', 'avaliado_em'])::text, c.status, c.documentos
    into v_antes, v_status, v_docs
    from public.cadastros_agregados c where c.id = v_a;

  perform public.avaliar_cadastro(v_a, 'inapto', 'Teste da conferência 7.4');
  perform public.avaliar_cadastro(v_b, 'apto', 'Teste da conferência 7.4');

  -- A trava continua: o cadastro ativo marcado "inapto" ainda ocupa o CPF
  begin
    insert into public.cadastros_agregados (user_id, tipo, status, nome, cpf, email, celular, sem_carreta, dados)
    values (null, 'pf', 'pendente', 'Fulano de Teste P25b', '999.999.999-91', null, '11900000000', true, '{}');
  exception when unique_violation then v_trava := 'recusado'; end;
  -- "Apto" num recusado não o torna ativo: o CPF dele continua livre
  insert into public.cadastros_agregados (user_id, tipo, status, nome, cpf, email, celular, sem_carreta, dados)
  values (null, 'pf', 'pendente', 'Ciclano de Teste P25b', '99999999992', null, '11900000000', true, '{}');
  v_livre := 'aceito';
  -- E marcar "inapto" o ativo não libera o CPF
  perform public.avaliar_cadastro(v_a, 'inapto', null);
  begin
    insert into public.cadastros_agregados (user_id, tipo, status, nome, cpf, email, celular, sem_carreta, dados)
    values (null, 'pf', 'pendente', 'Fulano de Teste P25b', '99999999991', null, '11900000000', true, '{}');
  exception when unique_violation then v_inapto := 'recusado'; end;

  raise exception 'RESULTADO (nada foi salvo): status_igual=% | documentos_iguais=% | resto_da_linha_igual=% | inapto_continua_travando=% | apto_num_recusado_nao_trava=% | inapto_nao_libera_cpf_de_ativo=%',
    (select status = v_status from public.cadastros_agregados where id = v_a),
    (select documentos = v_docs from public.cadastros_agregados where id = v_a),
    (select (to_jsonb(c) - array['avaliacao', 'avaliacao_motivo', 'avaliado_por', 'avaliado_em'])::text = v_antes
       from public.cadastros_agregados c where c.id = v_a),
    v_trava, v_livre, v_inapto;
end $$;
rollback;

-- 7.5 Os existentes não mudam e nenhum arquivo é criado ou apagado (esperado: cadastros_antes=N | cadastros_depois=N | existentes_iguais_sem_colunas_novas=t | existentes_sem_avaliacao=t | arquivos_antes=M | arquivos_depois=M | arquivos_iguais=t)
begin;
select set_config('request.jwt.claims',
         '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated","email":"admin@teste.local","app_metadata":{"role":"admin"}}', true);
do $$
declare
  v_cad_antes bigint;
  v_cad_md5   text;
  v_arq_antes bigint;
  v_arq_md5   text;
  v_id        uuid;
begin
  select count(*), md5(coalesce(string_agg((to_jsonb(c) - array['avaliacao', 'avaliacao_motivo', 'avaliado_por', 'avaliado_em'])::text, E'\n' order by c.id), ''))
    into v_cad_antes, v_cad_md5
    from public.cadastros_agregados c;
  select count(*), md5(coalesce(string_agg(o.id::text || ' ' || o.name, E'\n' order by o.name), '')) into v_arq_antes, v_arq_md5
    from storage.objects o where o.bucket_id = 'documentos-cadastro';

  insert into public.cadastros_agregados (user_id, tipo, status, nome, cpf, email, celular, sem_carreta, dados)
  values (null, 'pf', 'pendente', 'Fulano de Teste P25b', '99999999991', null, '11900000000', true, '{}')
  returning id into v_id;
  perform public.avaliar_cadastro(v_id, 'apto', 'Teste da conferência 7.5');
  perform public.avaliar_cadastro(v_id, 'inapto', 'Teste da conferência 7.5');

  raise exception 'RESULTADO (nada foi salvo): cadastros_antes=% | cadastros_depois=% | existentes_iguais_sem_colunas_novas=% | existentes_sem_avaliacao=% | arquivos_antes=% | arquivos_depois=% | arquivos_iguais=%',
    v_cad_antes,
    (select count(*) from public.cadastros_agregados where id <> v_id),
    (select md5(coalesce(string_agg((to_jsonb(c) - array['avaliacao', 'avaliacao_motivo', 'avaliado_por', 'avaliado_em'])::text, E'\n' order by c.id), ''))
       from public.cadastros_agregados c where c.id <> v_id) = v_cad_md5,
    (select bool_and(avaliacao is null and avaliacao_motivo is null and avaliado_por is null and avaliado_em is null)
       from public.cadastros_agregados where id <> v_id),
    v_arq_antes,
    (select count(*) from storage.objects o where o.bucket_id = 'documentos-cadastro'),
    (select md5(coalesce(string_agg(o.id::text || ' ' || o.name, E'\n' order by o.name), ''))
       from storage.objects o where o.bucket_id = 'documentos-cadastro') = v_arq_md5;
end $$;
rollback;

-- 7.6 DEPOIS (só leitura): o mesmo do item 0 (esperado: retrato_public, cadastros, md5_cadastros_sem_colunas_novas, arquivos e md5_arquivos iguais ao item 0)
select (select md5(string_agg(x, E'\n' order by x)) from (
          select 'rel ' || c.relname || ' ' || c.relkind::text || ' ' || coalesce(c.relacl::text, '') || ' ' || c.relrowsecurity as x
            from pg_class c where c.relnamespace = 'public'::regnamespace
          union all
          select 'col ' || c.relname || '.' || a.attname || ' ' || format_type(a.atttypid, a.atttypmod) || ' ' || coalesce(a.attacl::text, '')
            from pg_attribute a join pg_class c on c.oid = a.attrelid
           where c.relnamespace = 'public'::regnamespace and a.attnum > 0 and not a.attisdropped
             and not (c.relname = 'cadastros_agregados' and a.attname in ('avaliacao', 'avaliacao_motivo', 'avaliado_por', 'avaliado_em'))
          union all
          select 'fn ' || p.oid::regprocedure::text || ' ' || md5(p.prosrc) || ' ' || coalesce(p.proacl::text, '') || ' '
                 || p.prosecdef || ' ' || coalesce(array_to_string(p.proconfig, ','), '')
            from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname not in ('avaliar_cadastro', 'cadastro_avaliacao_guarda')
          union all
          select 'pol ' || tablename || ' ' || policyname || ' ' || cmd || ' ' || array_to_string(roles, ',') || ' '
                 || coalesce(qual, '') || ' ' || coalesce(with_check, '')
            from pg_policies where schemaname = 'public'
          union all
          select 'trg ' || c.relname || ' ' || t.tgname || ' ' || t.tgenabled::text
            from pg_trigger t join pg_class c on c.oid = t.tgrelid
           where c.relnamespace = 'public'::regnamespace and not t.tgisinternal and t.tgname <> 'trg_cadastro_avaliacao'
          union all
          select 'nsp ' || coalesce(n.nspacl::text, '') from pg_namespace n where n.nspname = 'public'
        ) s) as retrato_public,
       (select count(*) from public.cadastros_agregados) as cadastros,
       (select md5(coalesce(string_agg((to_jsonb(c) - array['avaliacao', 'avaliacao_motivo', 'avaliado_por', 'avaliado_em'])::text, E'\n' order by c.id), ''))
          from public.cadastros_agregados c) as md5_cadastros_sem_colunas_novas,
       (select count(*) from storage.objects o where o.bucket_id = 'documentos-cadastro') as arquivos,
       (select md5(coalesce(string_agg(o.id::text || ' ' || o.name, E'\n' order by o.name), ''))
          from storage.objects o where o.bucket_id = 'documentos-cadastro') as md5_arquivos;
