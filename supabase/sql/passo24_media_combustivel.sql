-- =============================================================================
-- PASSO 24 - Média de combustível tanque cheio a tanque cheio: "Momento" do abastecimento
--            RASCUNHO - AINDA NÃO RODADO
-- AJBorges Transporte & Logística
--
-- A ficha ganhou, em cada abastecimento, o campo "Momento": 'saida' (completar o
-- tanque antes de sair; não entra na média desta viagem), 'durante' ou 'chegada'
-- (completar o tanque para fechar a viagem). A conta da média é feita no site
-- (JavaScript/media-combustivel.js); o banco só precisa GUARDAR a chave.
-- Hoje o trigger do motorista passa cada abastecimento pela
-- public._limpar_abastecimentos, que só guarda as chaves que conhece: o "momento"
-- seria descartado. O que muda:
--   1. public._limpar_abastecimentos(p): igual à do passo 22, com UMA chave a mais,
--      'momento' ('saida' | 'durante' | 'chegada'; qualquer outra coisa ou a chave
--      ausente = null). Todo o resto (posto, posto_outro, nf, km, valor, litros,
--      combustivel, placa, teto de 100) fica igual.
--
-- Não muda: nenhuma coluna, tabela, policy, grant ou trigger; o trigger
-- proteger_colunas_admin_fichas continua chamando a função do mesmo jeito; a
-- gestão continua sem passar pela _limpar_abastecimentos. Nenhum update, delete
-- ou truncate de dados: as fichas já gravadas NÃO são relidas nem recalculadas
-- (ficam sem Momento e o site mostra a conta antiga com o aviso "média antiga").
-- create or replace mantém o dono, os grants, o search_path e o "immutable".
--
-- Como rodar (SQL Editor do Supabase), ANTES de publicar o site:
--   a) rode o item 0 sozinho e anote os valores;
--   b) rode do "begin;" até o "commit;" (tudo numa transação: se algo falhar,
--      nada é alterado; pode ser reexecutado). Ele confere antes que a função de
--      hoje é a do passo 22 (senão para com erro e nada muda);
--   c) rode cada conferência do item 7 separadamente (cada uma desfaz tudo com
--      rollback; o resultado aparece como erro "RESULTADO ...");
--   d) o 7.6 repete o item 0: tem que dar igual (rode num horário calmo: um
--      motorista salvando o rascunho muda a contagem/md5 das fichas).
--   O retrato deixa de fora só o CORPO da _limpar_abastecimentos (o dono, os
--   grants, o search_path e o security definer dela continuam no retrato).
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 0. ANTES (só leitura): retrato do public + fichas e auditoria (anote; o 7.6 repete)
-- -----------------------------------------------------------------------------
select (select md5(string_agg(x, E'\n' order by x)) from (
          select 'rel ' || c.relname || ' ' || c.relkind::text || ' ' || coalesce(c.relacl::text, '') || ' ' || c.relrowsecurity as x
            from pg_class c where c.relnamespace = 'public'::regnamespace
          union all
          select 'col ' || c.relname || '.' || a.attname || ' ' || format_type(a.atttypid, a.atttypmod) || ' ' || coalesce(a.attacl::text, '')
            from pg_attribute a join pg_class c on c.oid = a.attrelid
           where c.relnamespace = 'public'::regnamespace and a.attnum > 0 and not a.attisdropped
          union all
          select 'fn ' || p.oid::regprocedure::text || ' '
                 || case when p.proname = '_limpar_abastecimentos' then '(corpo trocado no passo 24)' else md5(p.prosrc) end || ' '
                 || coalesce(p.proacl::text, '') || ' ' || p.prosecdef || ' ' || p.provolatile::text || ' '
                 || coalesce(array_to_string(p.proconfig, ','), '')
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
        ) s) as retrato_public,
       (select count(*) from public.fichas_viagem) as fichas,
       (select md5(coalesce(string_agg(to_jsonb(f)::text, E'\n' order by f.id), '')) from public.fichas_viagem f) as md5_fichas,
       (select count(*) from public.auditoria_fichas) as auditoria,
       (select md5(coalesce(string_agg(to_jsonb(a)::text, E'\n' order by a.id), '')) from public.auditoria_fichas a) as md5_auditoria;


begin;


-- -----------------------------------------------------------------------------
-- 0.1 Trava: só segue se a função de hoje for a do passo 22 (teto de 100 + posto_outro)
-- -----------------------------------------------------------------------------
do $$
declare
  v_src text := (select p.prosrc from pg_proc p where p.oid = 'public._limpar_abastecimentos(jsonb)'::regprocedure);
begin
  if v_src is null or position('No máximo 100 abastecimentos por ficha.' in v_src) = 0
     or position('posto_outro' in v_src) = 0 then
    raise exception 'PARADO: a _limpar_abastecimentos de hoje não é a do passo 22. Nada foi alterado.';
  end if;
end $$;


-- -----------------------------------------------------------------------------
-- 1. _limpar_abastecimentos(p): a do passo 22 + 'momento'
-- -----------------------------------------------------------------------------
create or replace function public._limpar_abastecimentos(p jsonb)
returns jsonb
language plpgsql
immutable
set search_path to ''
as $$
begin
  if jsonb_typeof(p) = 'array' and jsonb_array_length(p) > 100 then
    raise exception 'No máximo 100 abastecimentos por ficha.';
  end if;
  return (
    select coalesce(jsonb_agg(jsonb_build_object(
             'posto',  public._txt(e -> 'posto'),
             -- nome digitado no posto "Outro" (nos outros postos fica vazio)
             'posto_outro', case when (e ->> 'posto') = 'Outro' then public._txt(e -> 'posto_outro', 80)
                                 else to_jsonb(''::text) end,
             'nf',     public._txt(e -> 'nf', 40),
             'km',     public._txt(e -> 'km', 20),
             'valor',  public._txt(e -> 'valor', 20),
             'litros', public._txt(e -> 'litros', 20),
             'combustivel', case when (e ->> 'combustivel') in ('diesel_s10', 'diesel_s500', 'arla')
                                 then e ->> 'combustivel' end,
             'placa',       case when (e ->> 'placa') in ('principal', 'secundaria')
                                 then e ->> 'placa' end,
             -- passo 24: Saída (fora da média) / Durante / Chegada (fecha a média); o resto = null
             'momento',     case when (e ->> 'momento') in ('saida', 'durante', 'chegada')
                                 then e ->> 'momento' end
           ) order by i), '[]'::jsonb)
    from jsonb_array_elements(case when jsonb_typeof(p) = 'array' then p else '[]'::jsonb end)
         with ordinality as t(e, i)
    where jsonb_typeof(e) = 'object'
  );
end;
$$;


commit;


-- =============================================================================
-- 7. Conferências (depois do commit; rode cada bloco separadamente)
--    O resultado aparece como erro "RESULTADO ..." e tudo é desfeito (rollback).
-- =============================================================================

-- 7.1 Estrutura (esperado: limpar=imutavel:i definer:f search_path="" | chamada_pelo_trigger=t | fichas_com_momento=0)
--     fichas_com_momento: nenhuma ficha gravada tem Momento ainda (rode antes de publicar o site).
do $$
begin
  raise exception 'RESULTADO (só leitura): limpar=imutavel:% definer:% % | chamada_pelo_trigger=% | fichas_com_momento=%',
    (select p.provolatile::text from pg_proc p where p.oid = 'public._limpar_abastecimentos(jsonb)'::regprocedure),
    (select left(p.prosecdef::text, 1) from pg_proc p where p.oid = 'public._limpar_abastecimentos(jsonb)'::regprocedure),
    (select coalesce(array_to_string(p.proconfig, ','), 'SEM search_path') from pg_proc p
      where p.oid = 'public._limpar_abastecimentos(jsonb)'::regprocedure),
    (select left((position('_limpar_abastecimentos' in p.prosrc) > 0)::text, 1) from pg_proc p
      where p.oid = 'public.proteger_colunas_admin_fichas()'::regprocedure),
    (select count(*) from public.fichas_viagem f
      where exists (select 1 from jsonb_array_elements(case when jsonb_typeof(f.abastecimentos) = 'array' then f.abastecimentos else '[]' end) a
                     where jsonb_typeof(a) = 'object' and a ? 'momento' and a ->> 'momento' is not null)
         or exists (select 1 from jsonb_array_elements(case when jsonb_typeof(f.dados_completos -> 'abastecimentos') = 'array'
                                                             then f.dados_completos -> 'abastecimentos' else '[]' end) a
                     where jsonb_typeof(a) = 'object' and a ? 'momento' and a ->> 'momento' is not null));
end $$;

-- 7.2 A limpeza guarda o Momento e o resto fica igual ao passo 22 (esperado: momentos=saida,durante,chegada,durante,(nulo),(nulo),(nulo) | resto_igual_ao_passo22=t | linhas=7 | com_101=recusado)
--     A função do passo 22 é recriada só nesta transação (pg_temp) para comparar linha a linha.
begin;
create function pg_temp.limpar_passo22(p jsonb) returns jsonb language plpgsql immutable set search_path to '' as $f$
begin
  if jsonb_typeof(p) = 'array' and jsonb_array_length(p) > 100 then
    raise exception 'No máximo 100 abastecimentos por ficha.';
  end if;
  return (
    select coalesce(jsonb_agg(jsonb_build_object(
             'posto',  public._txt(e -> 'posto'),
             'posto_outro', case when (e ->> 'posto') = 'Outro' then public._txt(e -> 'posto_outro', 80)
                                 else to_jsonb(''::text) end,
             'nf',     public._txt(e -> 'nf', 40),
             'km',     public._txt(e -> 'km', 20),
             'valor',  public._txt(e -> 'valor', 20),
             'litros', public._txt(e -> 'litros', 20),
             'combustivel', case when (e ->> 'combustivel') in ('diesel_s10', 'diesel_s500', 'arla')
                                 then e ->> 'combustivel' end,
             'placa',       case when (e ->> 'placa') in ('principal', 'secundaria')
                                 then e ->> 'placa' end
           ) order by i), '[]'::jsonb)
    from jsonb_array_elements(case when jsonb_typeof(p) = 'array' then p else '[]'::jsonb end)
         with ordinality as t(e, i)
    where jsonb_typeof(e) = 'object'
  );
end;
$f$;
do $$
declare
  v_in   jsonb := '[
    {"posto": "Posto A", "nf": "123", "km": "100.000", "valor": "500,00", "litros": "100,000", "combustivel": "diesel_s10", "placa": "principal", "momento": "saida"},
    {"posto": "Outro", "posto_outro": "Posto <X>", "valor": "300,00", "litros": "60", "combustivel": "diesel_s500", "placa": "secundaria", "momento": "durante"},
    {"posto": "Posto B", "litros": "80", "combustivel": "diesel_s10", "momento": "chegada"},
    {"posto": "Posto C", "litros": "10", "combustivel": "arla", "momento": "durante"},
    {"posto": "Posto D", "litros": "50", "combustivel": "diesel_s10", "momento": "Chegada "},
    {"posto": "Posto E", "litros": "50", "momento": "<img src=x onerror=alert(1)>"},
    "texto solto",
    {"posto": "Posto F", "litros": "40"}
  ]';
  v_novo jsonb := public._limpar_abastecimentos(v_in);
  v_velho jsonb := pg_temp.limpar_passo22(v_in);
  v_101  text := 'ACEITO';
begin
  begin
    perform public._limpar_abastecimentos((select jsonb_agg(jsonb_build_object('posto', 'P')) from generate_series(1, 101)));
  exception when others then
    if sqlerrm = 'No máximo 100 abastecimentos por ficha.' then v_101 := 'recusado'; else v_101 := 'ERRO: ' || sqlerrm; end if;
  end;
  raise exception 'RESULTADO (nada foi salvo): momentos=% | resto_igual_ao_passo22=% | linhas=% | com_101=%',
    (select string_agg(coalesce(a ->> 'momento', '(nulo)'), ',' order by i) from jsonb_array_elements(v_novo) with ordinality t(a, i)),
    (select left(((select jsonb_agg(a - 'momento' order by i) from jsonb_array_elements(v_novo) with ordinality t(a, i)) = v_velho)::text, 1)),
    jsonb_array_length(v_novo), v_101;
end $$;
rollback;

-- 7.3 Motorista grava o Momento no rascunho e no envio (esperado: rascunho=saida,durante,chegada | coluna_igual_dc=t | envio=saida,durante,chegada | arla=durante | invalido=(nulo) | status=pendente)
--     Usa o primeiro motorista SEM rascunho em andamento; o número da ficha é de teste (não gasta número).
begin;
create or replace function public.reservar_numero_ficha() returns text language sql as $$ select 'AJB-TESTE-P24'::text $$;
select set_config('p24.a', (select p.id::text from public.perfis p where p.role = 'motorista'
         and not exists (select 1 from public.fichas_viagem f where f.motorista_id = p.id and f.status = 'rascunho')
       order by p.id limit 1), true);
select set_config('request.jwt.claims', json_build_object('sub', current_setting('p24.a'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
declare
  r_rasc record;
  r_env  record;
  v_abast jsonb := '[
    {"posto": "Posto A", "valor": "1.000,00", "litros": "200", "combustivel": "diesel_s10", "momento": "saida"},
    {"posto": "Posto B", "valor": "1.500,00", "litros": "300", "combustivel": "diesel_s10", "momento": "durante"},
    {"posto": "Posto C", "valor": "1.000,00", "litros": "200", "combustivel": "diesel_s500", "momento": "chegada"}
  ]';
begin
  insert into public.fichas_viagem (id, motorista, status, abastecimentos, dados_completos)
  values ('x', 'teste', 'rascunho', v_abast, jsonb_build_object('kmSaida', '100000', 'abastecimentos', v_abast))
  returning * into r_rasc;
  update public.fichas_viagem
     set status = 'pendente', placas = 'ABC1D23', data_saida = '2026-10-01', data_chegada = '2026-10-05',
         abastecimentos = v_abast || '[{"posto": "Posto D", "litros": "20", "combustivel": "arla", "momento": "durante"},
                                       {"posto": "Posto E", "litros": "10", "combustivel": "diesel_s10", "momento": "fim"}]'::jsonb,
         dados_completos = jsonb_build_object('kmSaida', '100000', 'kmEntrada', '101500', 'valorAdiantamento', '0,00')
   where id = r_rasc.id
  returning * into r_env;
  raise exception 'RESULTADO (nada foi salvo): rascunho=% | coluna_igual_dc=% | envio=% | arla=% | invalido=% | status=%',
    (select string_agg(a ->> 'momento', ',' order by i) from jsonb_array_elements(r_rasc.abastecimentos) with ordinality t(a, i)),
    left((r_env.abastecimentos = r_env.dados_completos -> 'abastecimentos')::text, 1),
    (select string_agg(a ->> 'momento', ',' order by i) from jsonb_array_elements(r_env.abastecimentos) with ordinality t(a, i) where i <= 3),
    r_env.abastecimentos -> 3 ->> 'momento',
    coalesce(r_env.abastecimentos -> 4 ->> 'momento', '(nulo)'),
    r_env.status;
end $$;
rollback;

-- 7.4 A gestão continua gravando como veio (esperado: gestao=saida,chegada | sem_momento=(sem a chave))
--     A gestão não passa pela _limpar_abastecimentos (nem antes nem agora); uma ficha "antiga",
--     sem Momento, continua sem a chave.
begin;
select set_config('request.jwt.claims',
         (select json_build_object('sub', id, 'role', 'authenticated', 'app_metadata', json_build_object('role', 'admin'))::text
            from public.perfis where role = 'admin' order by id limit 1), true);
set local role authenticated;
do $$
declare
  r1 record;
  r2 record;
begin
  insert into public.fichas_viagem (id, motorista, status, abastecimentos, dados_completos)
  values ('AJB-TESTE-P24-GESTAO-1', 'teste', 'pendente',
          '[{"posto": "Posto A", "litros": "100", "combustivel": "diesel_s10", "momento": "saida"},
            {"posto": "Posto B", "litros": "100", "combustivel": "diesel_s10", "momento": "chegada"}]', '{}')
  returning * into r1;
  insert into public.fichas_viagem (id, motorista, status, abastecimentos, dados_completos)
  values ('AJB-TESTE-P24-GESTAO-2', 'teste', 'pendente', '[{"posto": "Posto A", "litros": "100"}]', '{}')
  returning * into r2;
  raise exception 'RESULTADO (nada foi salvo): gestao=% | sem_momento=%',
    (select string_agg(a ->> 'momento', ',' order by i) from jsonb_array_elements(r1.abastecimentos) with ordinality t(a, i)),
    case when r2.abastecimentos -> 0 ? 'momento' then 'TEM A CHAVE' else '(sem a chave)' end;
end $$;
rollback;

-- 7.5 As fichas que já existem não mudam (esperado: fichas_antes=N | fichas_depois=N | fichas_iguais=t | auditoria_antes=M | auditoria_depois=M | auditoria_igual=t)
--     (N e M = os números do item 0.) Uma ficha de teste é gravada e relida pela limpeza nova
--     dentro da transação; as outras têm que continuar idênticas.
begin;
select set_config('request.jwt.claims',
         (select json_build_object('sub', id, 'role', 'authenticated', 'app_metadata', json_build_object('role', 'admin'))::text
            from public.perfis where role = 'admin' order by id limit 1), true);
do $$
declare
  v_fichas    bigint;
  v_md5       text;
  v_aud       bigint;
  v_aud_md5   text;
  v_aud_max   bigint;
begin
  select count(*), md5(coalesce(string_agg(to_jsonb(f)::text, E'\n' order by f.id), '')) into v_fichas, v_md5 from public.fichas_viagem f;
  select count(*), md5(coalesce(string_agg(to_jsonb(a)::text, E'\n' order by a.id), '')), coalesce(max(a.id), 0)
    into v_aud, v_aud_md5, v_aud_max from public.auditoria_fichas a;
  insert into public.fichas_viagem (id, motorista, status, abastecimentos, dados_completos)
  values ('AJB-TESTE-P24-DADOS', 'teste', 'pendente',
          public._limpar_abastecimentos('[{"posto": "Posto A", "litros": "100", "combustivel": "diesel_s10", "momento": "chegada"}]'), '{}');
  raise exception 'RESULTADO (nada foi salvo): fichas_antes=% | fichas_depois=% | fichas_iguais=% | auditoria_antes=% | auditoria_depois=% | auditoria_igual=%',
    v_fichas,
    (select count(*) from public.fichas_viagem where id <> 'AJB-TESTE-P24-DADOS'),
    left(((select md5(coalesce(string_agg(to_jsonb(f)::text, E'\n' order by f.id), '')) from public.fichas_viagem f
            where f.id <> 'AJB-TESTE-P24-DADOS') = v_md5)::text, 1),
    v_aud,
    (select count(*) from public.auditoria_fichas a where a.id <= v_aud_max),
    left(((select md5(coalesce(string_agg(to_jsonb(a)::text, E'\n' order by a.id), '')) from public.auditoria_fichas a
            where a.id <= v_aud_max) = v_aud_md5)::text, 1);
end $$;
rollback;

-- 7.6 DEPOIS (só leitura): o mesmo do item 0 (esperado: retrato_public, fichas, md5_fichas, auditoria e md5_auditoria iguais ao item 0)
select (select md5(string_agg(x, E'\n' order by x)) from (
          select 'rel ' || c.relname || ' ' || c.relkind::text || ' ' || coalesce(c.relacl::text, '') || ' ' || c.relrowsecurity as x
            from pg_class c where c.relnamespace = 'public'::regnamespace
          union all
          select 'col ' || c.relname || '.' || a.attname || ' ' || format_type(a.atttypid, a.atttypmod) || ' ' || coalesce(a.attacl::text, '')
            from pg_attribute a join pg_class c on c.oid = a.attrelid
           where c.relnamespace = 'public'::regnamespace and a.attnum > 0 and not a.attisdropped
          union all
          select 'fn ' || p.oid::regprocedure::text || ' '
                 || case when p.proname = '_limpar_abastecimentos' then '(corpo trocado no passo 24)' else md5(p.prosrc) end || ' '
                 || coalesce(p.proacl::text, '') || ' ' || p.prosecdef || ' ' || p.provolatile::text || ' '
                 || coalesce(array_to_string(p.proconfig, ','), '')
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
        ) s) as retrato_public,
       (select count(*) from public.fichas_viagem) as fichas,
       (select md5(coalesce(string_agg(to_jsonb(f)::text, E'\n' order by f.id), '')) from public.fichas_viagem f) as md5_fichas,
       (select count(*) from public.auditoria_fichas) as auditoria,
       (select md5(coalesce(string_agg(to_jsonb(a)::text, E'\n' order by a.id), '')) from public.auditoria_fichas a) as md5_auditoria;
