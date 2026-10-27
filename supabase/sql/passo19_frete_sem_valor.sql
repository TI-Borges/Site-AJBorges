-- =============================================================================
-- PASSO 19 - Frete sem valor: Mercado Livre continua com R$ 400,00
-- AJBorges Transporte & Logística
--
-- O valor do frete passou a ser opcional para o motorista (a gestão completa
-- depois). Recria só a public._limpar_fretes de 5 parâmetros (passo 15). Muda uma
-- regra:
--   Mercado Livre = R$ 400,00 por frete MESMO SEM VALOR. Antes o teste
--   "valor vazio ou 0 = comissão vazia" vinha antes do Mercado Livre.
-- Continua igual: Shopee 11%, Alimentício rodotrem (especial de rodotrem do
-- motorista, senão 8% destino Viana-ES / 9%), Alimentício carreta (especial de
-- carreta, senão 11%), sem valor = comissão vazia (fora o Mercado Livre),
-- limpeza do valor, da descarga e do veículo.
--
-- Não muda: trigger proteger_colunas_admin_fichas (já aceita frete sem valor do
-- motorista: só exige o veículo do Alimentício com valor), _eh_viana_es, a versão
-- de 2 parâmetros da _limpar_fretes e as outras funções.
-- A gestão continua sem passar pela _limpar_fretes: quando ela preenche o valor,
-- a comissão é calculada na tela (relatorio.js, mesma regra) e gravada como veio.
--
-- Rodar no SQL Editor do Supabase até o "commit;". Tudo roda numa transação
-- (begin ... commit): se algo falhar, nada é alterado. Pode ser reexecutado.
-- As conferências ficam depois do commit: rode cada uma separadamente.
-- =============================================================================

begin;


-- -----------------------------------------------------------------------------
-- 1. _limpar_fretes(p_novo, p_antigo, p_tipo, p_com_carreta, p_com_rodotrem)
--    Igual à do passo 15, com o Mercado Livre antes do teste de valor vazio.
-- -----------------------------------------------------------------------------
create or replace function public._limpar_fretes(p_novo jsonb, p_antigo jsonb, p_tipo text,
                                                 p_com_carreta numeric, p_com_rodotrem numeric)
returns jsonb
language sql
immutable
set search_path to ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'data',     public._txt(n -> 'data', 20),
           'cliente',  to_jsonb(coalesce(c.cliente, '')),
           'origem',   public._txt(n -> 'origem'),
           'destino',  public._txt(n -> 'destino'),
           'veiculo',  to_jsonb(c.veiculo),
           'valor',    to_jsonb(coalesce(public._moeda_txt(c.valor), '')),
           'comissao', to_jsonb(coalesce(public._moeda_txt(
                         case
                           when c.cliente = 'mercado_livre' then 400.00
                           when c.valor is null or c.valor = 0 then null
                           when c.cliente = 'shopee'        then round(c.valor * 11 / 100, 2)
                           when c.cliente = 'alimenticio' and c.veiculo = 'rodotrem' then
                             round(c.valor * coalesce(p_com_rodotrem,
                                     case when public._eh_viana_es(public._txt(n -> 'destino') #>> '{}')
                                          then 8 else 9 end) / 100, 2)
                           when c.cliente = 'alimenticio' and c.veiculo = 'carreta' then
                             round(c.valor * coalesce(p_com_carreta, 11) / 100, 2)
                         end), '')),
           'descarga', to_jsonb(coalesce(public._moeda_txt(public._moeda(n -> 'descarga')), ''))
         ) order by i), '[]'::jsonb)
  from jsonb_array_elements(case when jsonb_typeof(p_novo) = 'array' then p_novo else '[]'::jsonb end)
       with ordinality as t(n, i)
  cross join lateral (
    select case when (n ->> 'cliente') in ('alimenticio', 'shopee', 'mercado_livre')
                then n ->> 'cliente' end as cliente,
           case when coalesce(p_tipo, 'carreta') not in ('rodotrem', 'carreta_rodotrem') then 'carreta'
                when (n ->> 'veiculo') in ('carreta', 'rodotrem') then n ->> 'veiculo' end as veiculo,
           public._moeda(n -> 'valor') as valor
  ) c
  where i <= 8 and jsonb_typeof(n) = 'object';
$$;


commit;


-- =============================================================================
-- 2. Conferências (depois do commit; rode cada bloco separadamente)
--    Cada uma desfaz tudo no final (rollback). O resultado aparece como erro
--    "RESULTADO (nada foi salvo): ...".
--    2.2 e 2.3 rodam como o primeiro perfil com role = 'motorista' (deixado como
--    carreta, sem comissão especial, dentro da mesma transação); a 2.3 usa também
--    o segundo motorista (B) e a gestão (claim app_metadata.role = 'admin').
-- =============================================================================

-- 2.1 Regra da comissão, direto na função (esperado: ml_sem_valor=400,00 | ml_zero=400,00 | ml_com_valor=400,00 | shopee_sem_valor=(vazio) | shopee=1.100,00 | alim_rodotrem_sem_valor=(vazio) | rodotrem_viana=800,00 | rodotrem_outro=900,00 | rodotrem_especial_10_5=1.050,00 | carreta=1.100,00 | carreta_especial_6=600,00 | alim_carreta_sem_valor=(vazio))
begin;
do $$
declare
  v_f jsonb := '[
    {"data":"01/10/2026","cliente":"mercado_livre","origem":"A","destino":"B","valor":""},
    {"data":"01/10/2026","cliente":"mercado_livre","origem":"A","destino":"B","valor":"0,00"},
    {"data":"01/10/2026","cliente":"mercado_livre","origem":"A","destino":"B","valor":"1.000,00"},
    {"data":"01/10/2026","cliente":"shopee","origem":"A","destino":"B","valor":""},
    {"data":"01/10/2026","cliente":"shopee","origem":"A","destino":"B","valor":"10.000,00"},
    {"data":"01/10/2026","cliente":"alimenticio","origem":"A","destino":"Viana - ES","valor":"","veiculo":"rodotrem"},
    {"data":"01/10/2026","cliente":"alimenticio","origem":"A","destino":"Viana - ES","valor":"10.000,00","veiculo":"rodotrem"},
    {"data":"01/10/2026","cliente":"alimenticio","origem":"Viana - ES","destino":"Cravinhos - SP","valor":"10.000,00","veiculo":"rodotrem"}]'::jsonb;
  v_rodo   jsonb := public._limpar_fretes(v_f, null, 'rodotrem', null, null);
  v_esp    jsonb := public._limpar_fretes('[{"data":"01/10/2026","cliente":"alimenticio","origem":"A","destino":"Viana - ES","valor":"10.000,00","veiculo":"rodotrem"}]'::jsonb,
                                          null, 'rodotrem', null, 10.5);
  v_car    jsonb := public._limpar_fretes('[{"data":"01/10/2026","cliente":"alimenticio","origem":"A","destino":"B","valor":"10.000,00"},
                                            {"data":"01/10/2026","cliente":"alimenticio","origem":"A","destino":"B","valor":""}]'::jsonb,
                                          null, 'carreta', null, null);
  v_car6   jsonb := public._limpar_fretes('[{"data":"01/10/2026","cliente":"alimenticio","origem":"A","destino":"B","valor":"10.000,00"}]'::jsonb,
                                          null, 'carreta', 6, null);
  c text[];
begin
  select array_agg(coalesce(nullif(f ->> 'comissao', ''), '(vazio)') order by i) into c
    from jsonb_array_elements(v_rodo) with ordinality as t(f, i);
  raise exception 'RESULTADO (nada foi salvo): ml_sem_valor=% | ml_zero=% | ml_com_valor=% | shopee_sem_valor=% | shopee=% | alim_rodotrem_sem_valor=% | rodotrem_viana=% | rodotrem_outro=% | rodotrem_especial_10_5=% | carreta=% | carreta_especial_6=% | alim_carreta_sem_valor=%',
    c[1], c[2], c[3], c[4], c[5], c[6], c[7], c[8],
    v_esp -> 0 ->> 'comissao', v_car -> 0 ->> 'comissao', v_car6 -> 0 ->> 'comissao',
    coalesce(nullif(v_car -> 1 ->> 'comissao', ''), '(vazio)');
end $$;
rollback;

-- 2.2 Motorista envia com frete sem valor (esperado: ml_sem_valor=400,00 | shopee_sem_valor=(vazio) | alimenticio=1.100,00 | valores=(vazio) + 0,00 + 10.000,00 | total_frete=10000.00 | vr_comissao=1500.00 | saldo_comissao=1000.00 | status=pendente)
begin;
-- (número de teste só nesta transação: sequência não volta no rollback, e a conferência não pode gastar número)
create or replace function public.reservar_numero_ficha() returns text language sql as $$ select 'AJB-TESTE-P19'::text $$;
update public.perfis set tipo_veiculo = 'carreta', comissao_alim_carreta = null, comissao_alim_rodotrem = null
 where id = (select id from public.perfis where role = 'motorista' order by id limit 1);
select set_config('request.jwt.claims',
         (select json_build_object('sub', id, 'role', 'authenticated')::text
            from public.perfis where role = 'motorista' order by id limit 1), true);
set local role authenticated;
do $$
declare
  v_id text;
  v_dc jsonb := '{"kmSaida": "100000", "kmEntrada": "101500", "valorAdiantamento": "500,00", "fretes": [
      {"data":"01/10/2026","cliente":"mercado_livre","origem":"Marília - SP","destino":"Santos - SP","valor":""},
      {"data":"02/10/2026","cliente":"shopee","origem":"Santos - SP","destino":"Marília - SP","valor":"0,00"},
      {"data":"03/10/2026","cliente":"alimenticio","origem":"Marília - SP","destino":"Cravinhos - SP","valor":"10.000,00"}]}'::jsonb;
  r record;
begin
  insert into public.fichas_viagem (id, motorista, status, dados_completos)
  values ('x', 'teste', 'rascunho', v_dc)
  returning id into v_id;
  update public.fichas_viagem
     set status = 'pendente', placas = 'ABC1D23', data_saida = '2026-10-01', data_chegada = '2026-10-05', dados_completos = v_dc
   where id = v_id
  returning * into r;
  raise exception 'RESULTADO (nada foi salvo): ml_sem_valor=% | shopee_sem_valor=% | alimenticio=% | valores=% | total_frete=% | vr_comissao=% | saldo_comissao=% | status=%',
    r.dados_completos -> 'fretes' -> 0 ->> 'comissao',
    coalesce(nullif(r.dados_completos -> 'fretes' -> 1 ->> 'comissao', ''), '(vazio)'),
    r.dados_completos -> 'fretes' -> 2 ->> 'comissao',
    (select string_agg(coalesce(nullif(f ->> 'valor', ''), '(vazio)'), ' + ') from jsonb_array_elements(r.dados_completos -> 'fretes') f),
    r.total_frete::numeric(14,2), r.vr_comissao::numeric(14,2), r.saldo_comissao::numeric(14,2), r.status;
end $$;
rollback;

-- 2.3 Gestão preenche o valor; motorista B não mexe (esperado: b_altera=bloqueado | gestao_salva=ok | fretes=1.500,00/400,00 + 2.000,00/220,00 + 10.000,00/1.100,00 | total_frete=13500.00 | vr_comissao=1720.00 | saldo_comissao=1220.00 | status=aguardando_confirmacao)
--     A gestão grava a comissão que a tela calculou (a _limpar_fretes não roda para ela): o banco guarda como veio.
--     "bloqueado" = erro do trigger ou 0 linhas pela RLS. Sem um segundo motorista, b_altera=pulado.
begin;
create or replace function public.reservar_numero_ficha() returns text language sql as $$ select 'AJB-TESTE-P19'::text $$;
update public.perfis set tipo_veiculo = 'carreta', comissao_alim_carreta = null, comissao_alim_rodotrem = null
 where id = (select id from public.perfis where role = 'motorista' order by id limit 1);
-- motorista B escolhido aqui (antes do set role: depois dele a RLS pode esconder o perfil de B)
select set_config('p19.b', coalesce((select id::text from public.perfis where role = 'motorista' order by id offset 1 limit 1), ''), true);
select set_config('request.jwt.claims',
         (select json_build_object('sub', id, 'role', 'authenticated')::text
            from public.perfis where role = 'motorista' order by id limit 1), true);
set local role authenticated;
do $$
declare
  v_a uuid := auth.uid();
  v_id text;
  v_linhas bigint;
  v_b text;
  v_gestao text;
  v_dc jsonb := '{"kmSaida": "100000", "kmEntrada": "101500", "valorAdiantamento": "500,00", "fretes": [
      {"data":"01/10/2026","cliente":"mercado_livre","origem":"Marília - SP","destino":"Santos - SP","valor":""},
      {"data":"02/10/2026","cliente":"shopee","origem":"Santos - SP","destino":"Marília - SP","valor":""},
      {"data":"03/10/2026","cliente":"alimenticio","origem":"Marília - SP","destino":"Cravinhos - SP","valor":"10.000,00"}]}'::jsonb;
begin
  insert into public.fichas_viagem (id, motorista, status, dados_completos)
  values ('x', 'teste', 'rascunho', v_dc)
  returning id into v_id;
  update public.fichas_viagem
     set status = 'pendente', placas = 'ABC1D23', data_saida = '2026-10-01', data_chegada = '2026-10-05', dados_completos = v_dc
   where id = v_id
  returning id into v_id;
  -- motorista B tenta preencher o valor na ficha de A
  if current_setting('p19.b') = '' then
    v_b := 'pulado (só um motorista)';
  else
    perform set_config('request.jwt.claims', json_build_object('sub', current_setting('p19.b'), 'role', 'authenticated')::text, true);
    begin
      update public.fichas_viagem set total_frete = 1 where id = v_id;
      get diagnostics v_linhas = row_count;
      v_b := case when v_linhas = 0 then 'bloqueado (0 linhas)' else 'LIBERADO' end;
    exception when others then v_b := 'bloqueado (' || sqlerrm || ')';
    end;
  end if;
  -- gestão preenche os valores com a comissão calculada na tela (ML 400; Shopee 11% de 2.000)
  perform set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated',
                     'app_metadata', json_build_object('role', 'admin'))::text, true);
  begin
    update public.fichas_viagem
       set status = 'aguardando_confirmacao', total_frete = 13500, vr_comissao = 1720, saldo_comissao = 1220,
           dados_completos = jsonb_set(dados_completos, '{fretes}', '[
             {"data":"01/10/2026","cliente":"mercado_livre","origem":"Marília - SP","destino":"Santos - SP","veiculo":"carreta","valor":"1.500,00","comissao":"400,00","descarga":""},
             {"data":"02/10/2026","cliente":"shopee","origem":"Santos - SP","destino":"Marília - SP","veiculo":"carreta","valor":"2.000,00","comissao":"220,00","descarga":""},
             {"data":"03/10/2026","cliente":"alimenticio","origem":"Marília - SP","destino":"Cravinhos - SP","veiculo":"carreta","valor":"10.000,00","comissao":"1.100,00","descarga":""}]'::jsonb)
     where id = v_id;
    get diagnostics v_linhas = row_count;
    v_gestao := case when v_linhas = 1 then 'ok' else 'NÃO GRAVOU (' || v_linhas || ' linhas)' end;
  exception when others then v_gestao := 'erro: ' || sqlerrm;
  end;
  perform set_config('p19.id', v_id, true);
  perform set_config('p19.b_altera', v_b, true);
  perform set_config('p19.gestao', v_gestao, true);
end $$;
reset role;
do $$
declare r record;
begin
  select * into r from public.fichas_viagem where id = current_setting('p19.id');
  raise exception 'RESULTADO (nada foi salvo): b_altera=% | gestao_salva=% | fretes=% | total_frete=% | vr_comissao=% | saldo_comissao=% | status=%',
    current_setting('p19.b_altera'), current_setting('p19.gestao'),
    (select string_agg((f ->> 'valor') || '/' || (f ->> 'comissao'), ' + ') from jsonb_array_elements(r.dados_completos -> 'fretes') f),
    r.total_frete::numeric(14,2), r.vr_comissao::numeric(14,2), r.saldo_comissao::numeric(14,2), r.status;
end $$;
rollback;
