-- =============================================================================
-- PASSO 22 - Fretes e abastecimentos sem limite visível (teto de 100)
-- AJBorges Transporte & Logística
--
-- A ficha deixou de ter 8 fretes e 10 abastecimentos fixos: o motorista vai
-- adicionando (a tela para em 100 por bloco). Hoje o banco corta calado o que
-- passa de 8 fretes (_limpar_fretes, passo 19) e de 10 abastecimentos
-- (_limpar_abastecimentos, passo 11). O que muda:
--   1. _limpar_fretes (a de 5 parâmetros, a que o trigger usa): igual à do
--      passo 19, sem o corte "i <= 8"; mais de 100 fretes = erro (nada é gravado).
--   2. _limpar_abastecimentos: igual à do passo 11, sem o corte "i <= 10";
--      mais de 100 abastecimentos = erro (nada é gravado).
--   As duas passam de "language sql" para "language plpgsql" só para poder dar o
--   erro; a limpeza de cada linha é a mesma.
--
-- Não muda: trigger proteger_colunas_admin_fichas (continua chamando as duas do
-- mesmo jeito), a versão de 2 parâmetros da _limpar_fretes (o trigger não usa),
-- regra da comissão, _txt, RLS, is_admin(), login e edge functions. A gestão
-- continua sem passar pelas _limpar_* (a tela dela também para em 100).
-- Fichas já gravadas não são relidas: continuam como estão.
--
-- Rodar no SQL Editor do Supabase até o "commit;". Tudo roda numa transação
-- (begin ... commit): se algo falhar, nada é alterado. Pode ser reexecutado.
-- As conferências ficam depois do commit: rode cada uma separadamente.
-- =============================================================================

begin;


-- -----------------------------------------------------------------------------
-- 1. _limpar_fretes(p_novo, p_antigo, p_tipo, p_com_carreta, p_com_rodotrem)
--    Igual à do passo 19; sai o "i <= 8" e entra o teto de 100.
-- -----------------------------------------------------------------------------
create or replace function public._limpar_fretes(p_novo jsonb, p_antigo jsonb, p_tipo text,
                                                 p_com_carreta numeric, p_com_rodotrem numeric)
returns jsonb
language plpgsql
immutable
set search_path to ''
as $$
begin
  if jsonb_typeof(p_novo) = 'array' and jsonb_array_length(p_novo) > 100 then
    raise exception 'No máximo 100 fretes por ficha.';
  end if;
  return (
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
    where jsonb_typeof(n) = 'object'
  );
end;
$$;


-- -----------------------------------------------------------------------------
-- 2. _limpar_abastecimentos(p)
--    Igual à do passo 11; sai o "i <= 10" e entra o teto de 100.
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
$$;


commit;


-- =============================================================================
-- 7. Conferências (depois do commit; rode cada bloco separadamente)
--    Cada uma desfaz tudo no final (rollback). O resultado aparece como erro
--    "RESULTADO (nada foi salvo): ...".
--    Rodam como o primeiro perfil com role = 'motorista' (deixado como carreta,
--    sem comissão especial, dentro da mesma transação).
-- =============================================================================

-- 7.1 Motorista grava e envia 9 e 100 fretes e abastecimentos (esperado: fretes_9=9 | abast_9=9 | total_9=900.00 | fretes_100=100 | abast_100=100 | total_100=10000.00 | comissao_100=1100.00 | ultimo_frete=Destino 100 | ultimo_abast=Posto 100 | status=pendente)
begin;
-- (número de teste só nesta transação: sequência não volta no rollback, e a conferência não pode gastar número)
create or replace function public.reservar_numero_ficha() returns text language sql as $$ select 'AJB-TESTE-P22'::text $$;
update public.perfis set tipo_veiculo = 'carreta', comissao_alim_carreta = null, comissao_alim_rodotrem = null
 where id = (select id from public.perfis where role = 'motorista' order by id limit 1);
select set_config('request.jwt.claims',
         (select json_build_object('sub', id, 'role', 'authenticated')::text
            from public.perfis where role = 'motorista' order by id limit 1), true);
set local role authenticated;
do $$
declare
  v_id text;
  r9 record;
  r100 record;
  -- n fretes Shopee de 100,00 (comissão 11,00) e n abastecimentos de 50,00
  v_dc9   jsonb;
  v_dc100 jsonb;
  v_ab9   jsonb;
  v_ab100 jsonb;
begin
  select jsonb_build_object('kmSaida', '100000', 'kmEntrada', '101500', 'valorAdiantamento', '0,00', 'fretes',
           jsonb_agg(jsonb_build_object('data', '01/10/2026', 'cliente', 'shopee', 'origem', 'Origem ' || g,
                                        'destino', 'Destino ' || g, 'valor', '100,00') order by g)),
         jsonb_agg(jsonb_build_object('posto', 'Posto ' || g, 'valor', '50,00', 'litros', '10,000', 'combustivel', 'diesel_s10') order by g)
    into v_dc9, v_ab9 from generate_series(1, 9) g;
  select jsonb_build_object('kmSaida', '100000', 'kmEntrada', '101500', 'valorAdiantamento', '0,00', 'fretes',
           jsonb_agg(jsonb_build_object('data', '01/10/2026', 'cliente', 'shopee', 'origem', 'Origem ' || g,
                                        'destino', 'Destino ' || g, 'valor', '100,00') order by g)),
         jsonb_agg(jsonb_build_object('posto', 'Posto ' || g, 'valor', '50,00', 'litros', '10,000', 'combustivel', 'diesel_s10') order by g)
    into v_dc100, v_ab100 from generate_series(1, 100) g;

  -- rascunho com 9, depois com 100, e envio com 100
  insert into public.fichas_viagem (id, motorista, status, abastecimentos, dados_completos)
  values ('x', 'teste', 'rascunho', v_ab9, v_dc9)
  returning * into r9;
  update public.fichas_viagem
     set status = 'pendente', placas = 'ABC1D23', data_saida = '2026-10-01', data_chegada = '2026-10-05',
         abastecimentos = v_ab100, dados_completos = v_dc100
   where id = r9.id
  returning * into r100;
  raise exception 'RESULTADO (nada foi salvo): fretes_9=% | abast_9=% | total_9=% | fretes_100=% | abast_100=% | total_100=% | comissao_100=% | ultimo_frete=% | ultimo_abast=% | status=%',
    jsonb_array_length(r9.dados_completos -> 'fretes'), jsonb_array_length(r9.abastecimentos), r9.total_frete::numeric(14,2),
    jsonb_array_length(r100.dados_completos -> 'fretes'), jsonb_array_length(r100.abastecimentos),
    r100.total_frete::numeric(14,2), r100.vr_comissao::numeric(14,2),
    r100.dados_completos -> 'fretes' -> 99 ->> 'destino', r100.abastecimentos -> 99 ->> 'posto', r100.status;
end $$;
rollback;

-- 7.2 101 fretes ou 101 abastecimentos são recusados (esperado: fretes_101=recusado (No máximo 100 fretes por ficha.) | abast_101=recusado (No máximo 100 abastecimentos por ficha.) | fichas_gravadas=0)
begin;
update public.perfis set tipo_veiculo = 'carreta', comissao_alim_carreta = null, comissao_alim_rodotrem = null
 where id = (select id from public.perfis where role = 'motorista' order by id limit 1);
select set_config('request.jwt.claims',
         (select json_build_object('sub', id, 'role', 'authenticated')::text
            from public.perfis where role = 'motorista' order by id limit 1), true);
set local role authenticated;
do $$
declare
  v_fretes text := 'GRAVOU';
  v_abast  text := 'GRAVOU';
begin
  begin
    insert into public.fichas_viagem (id, motorista, status, dados_completos)
    select 'x', 'teste', 'rascunho', jsonb_build_object('fretes',
             jsonb_agg(jsonb_build_object('data', '01/10/2026', 'cliente', 'shopee', 'origem', 'A', 'destino', 'B', 'valor', '100,00')))
      from generate_series(1, 101);
  exception when others then v_fretes := 'recusado (' || sqlerrm || ')';
  end;
  begin
    insert into public.fichas_viagem (id, motorista, status, abastecimentos, dados_completos)
    select 'x', 'teste', 'rascunho',
           jsonb_agg(jsonb_build_object('posto', 'Posto', 'valor', '50,00', 'litros', '10,000', 'combustivel', 'diesel_s10')), '{}'::jsonb
      from generate_series(1, 101);
  exception when others then v_abast := 'recusado (' || sqlerrm || ')';
  end;
  raise exception 'RESULTADO (nada foi salvo): fretes_101=% | abast_101=% | fichas_gravadas=%',
    v_fretes, v_abast, (select count(*) from public.fichas_viagem where motorista_id = auth.uid() and status = 'rascunho');
end $$;
rollback;

-- 7.3 Fichas antigas continuam válidas (esperado: fichas_com_mais_de_100=0 | antiga_8_fretes=8 | antiga_10_abast=10 | posto_antigo=Posto Antigo Fora da Lista | combustivel_vazio=(vazio) | status=pendente)
--     Uma ficha no formato de antes (8 fretes, 10 abastecimentos, sem combustível nem placa em um deles)
--     passa pelo trigger do motorista do mesmo jeito; e nenhuma ficha gravada passa do teto.
begin;
create or replace function public.reservar_numero_ficha() returns text language sql as $$ select 'AJB-TESTE-P22'::text $$;
update public.perfis set tipo_veiculo = 'carreta', comissao_alim_carreta = null, comissao_alim_rodotrem = null
 where id = (select id from public.perfis where role = 'motorista' order by id limit 1);
-- contagem feita antes do set role (a RLS do motorista esconderia as fichas dos outros)
select set_config('p22.mais_de_100', (select count(*)::text from public.fichas_viagem
         where jsonb_array_length(case when jsonb_typeof(abastecimentos) = 'array' then abastecimentos else '[]'::jsonb end) > 100
            or jsonb_array_length(case when jsonb_typeof(dados_completos -> 'fretes') = 'array' then dados_completos -> 'fretes' else '[]'::jsonb end) > 100), true);
select set_config('request.jwt.claims',
         (select json_build_object('sub', id, 'role', 'authenticated')::text
            from public.perfis where role = 'motorista' order by id limit 1), true);
set local role authenticated;
do $$
declare
  r record;
  v_dc jsonb;
  v_ab jsonb;
begin
  select jsonb_build_object('kmSaida', '100000', 'kmEntrada', '101500', 'valorAdiantamento', '0,00', 'fretes',
           jsonb_agg(jsonb_build_object('data', '01/10/2026', 'cliente', 'alimenticio', 'origem', 'Marília - SP',
                                        'destino', 'Santos - SP', 'valor', '1.000,00', 'comissao', '', 'descarga', '') order by g))
    into v_dc from generate_series(1, 8) g;
  select jsonb_build_array(jsonb_build_object('posto', 'Posto Antigo Fora da Lista', 'nf', '1', 'km', '100', 'valor', '600,00', 'litros', '100'))
         || jsonb_agg(jsonb_build_object('posto', 'Marília - Posto Esmeralda', 'valor', '50,00', 'litros', '10', 'combustivel', 'diesel_s10', 'placa', 'principal') order by g)
    into v_ab from generate_series(1, 9) g;
  insert into public.fichas_viagem (id, motorista, status, placas, data_saida, data_chegada, abastecimentos, dados_completos)
  values ('x', 'teste', 'pendente', 'ABC1D23', '2026-10-01', '2026-10-05', v_ab, v_dc)
  returning * into r;
  raise exception 'RESULTADO (nada foi salvo): fichas_com_mais_de_100=% | antiga_8_fretes=% | antiga_10_abast=% | posto_antigo=% | combustivel_vazio=% | status=%',
    current_setting('p22.mais_de_100'),
    jsonb_array_length(r.dados_completos -> 'fretes'), jsonb_array_length(r.abastecimentos),
    r.abastecimentos -> 0 ->> 'posto', coalesce(r.abastecimentos -> 0 ->> 'combustivel', '(vazio)'), r.status;
end $$;
rollback;
