-- =============================================================================
-- PASSO 23 - Vários adiantamentos na ficha (teto de 100)   RASCUNHO - AINDA NÃO RODADO
-- AJBorges Transporte & Logística
--
-- O bloco "Adiantamento" da ficha passou a funcionar como Fretes e
-- Abastecimentos: o motorista vai adicionando linhas (a tela para em 100).
-- A ficha manda a lista em dados_completos.adiantamentos ([{ "valor": "500,00" },
-- ...]) e a soma em valorAdiantamento / valor_adiantamento, como antes.
-- Hoje o trigger do motorista só guarda em dados_completos as chaves que ele
-- conhece: a lista nova seria descartada. O que muda:
--   1. public._limpar_adiantamentos(p) (nova): só objetos com valor em
--      dinheiro válido (public._moeda), gravado no formato da ficha
--      ("1.234,56"); mais de 100 linhas = erro (nada é gravado).
--   2. proteger_colunas_admin_fichas: cópia do passo 17 (o passo 19 e o passo
--      22 não mexeram nela), mudando só a parte do motorista, em três pontos
--      marcados com "passo 23":
--        a) lê a lista pela _limpar_adiantamentos;
--        b) com lista, valor_adiantamento = soma das linhas (o saldo de
--           comissão sai dela, como antes). Sem lista (página antiga no
--           celular, ficha antiga), o valor único de antes, do mesmo jeito;
--        c) grava a lista limpa em dados_completos.adiantamentos (sem lista:
--           [], e a tela abre a ficha com 1 linha do valorAdiantamento).
--
-- Não muda: admin/diretoria (continuam livres e não passam pela
-- _limpar_adiantamentos; a tela da gestão também para em 100), colunas,
-- RLS, policies e grants de fichas_viagem, as outras _limpar_*, regras do
-- envio, comissão, Viana, is_admin(), login e edge functions. Fichas já
-- gravadas não são relidas: continuam com o valor único (valor_adiantamento),
-- e o acerto, o saldo e o dashboard continuam lendo valor_adiantamento.
--
-- Como rodar (SQL Editor do Supabase):
--   a) rode o item 0 sozinho e anote o retrato do public;
--   b) rode do "begin;" até o "commit;" (tudo numa transação: se algo
--      falhar, nada é alterado; pode ser reexecutado);
--   c) rode cada conferência do item 8 separadamente (cada uma desfaz tudo
--      com rollback; o resultado aparece como erro "RESULTADO ...");
--   d) a 8.7 repete o retrato do public: tem que dar igual ao item 0.
--      O retrato deixa de fora só as duas funções que este passo cria/troca
--      (_limpar_adiantamentos e proteger_colunas_admin_fichas); a 8.6 confere
--      as duas.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 0. Retrato do public (rode ANTES e anote; a conferência 8.7 repete e tem que dar igual)
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
     and p.proname not in ('_limpar_adiantamentos', 'proteger_colunas_admin_fichas')
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


begin;


-- -----------------------------------------------------------------------------
-- 1. _limpar_adiantamentos(p): até 100 linhas; só as com valor válido
-- -----------------------------------------------------------------------------
create or replace function public._limpar_adiantamentos(p jsonb)
returns jsonb
language plpgsql
immutable
set search_path to ''
as $$
begin
  if jsonb_typeof(p) = 'array' and jsonb_array_length(p) > 100 then
    raise exception 'No máximo 100 adiantamentos por ficha.';
  end if;
  return (
    select coalesce(jsonb_agg(jsonb_build_object(
             'valor', to_jsonb(public._moeda_txt(public._moeda(e -> 'valor')))
           ) order by i), '[]'::jsonb)
    from jsonb_array_elements(case when jsonb_typeof(p) = 'array' then p else '[]'::jsonb end)
         with ordinality as t(e, i)
    where jsonb_typeof(e) = 'object'
      and public._moeda(e -> 'valor') is not null
  );
end;
$$;


-- -----------------------------------------------------------------------------
-- 2. proteger_colunas_admin_fichas: cópia do passo 17, mudando só a parte do
--    motorista. Mudanças em relação ao passo 17 marcadas com "passo 23".
-- -----------------------------------------------------------------------------
create or replace function public.proteger_colunas_admin_fichas()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_novo_dc    jsonb := case when jsonb_typeof(to_jsonb(new) -> 'dados_completos') = 'object'
                             then to_jsonb(new) -> 'dados_completos' else '{}'::jsonb end;
  v_antigo_dc  jsonb := '{}'::jsonb;
  v_antigo_row jsonb := '{}'::jsonb;
  v_abast      jsonb;
  v_fretes     jsonb;
  v_despesas   jsonb;
  v_anexos     jsonb;
  v_dc         jsonb;
  v_nulos      jsonb;
  v_perfil     record;
  -- passo 11: KMs e placa secundária
  v_km_saida    bigint;
  v_km_entrada  bigint;
  v_km_saida2   bigint;
  v_km_entrada2 bigint;
  v_km_total1   bigint;
  v_km_total2   bigint;
  v_km_total    bigint;
  v_placa_sec   text;
  v_km          jsonb;
  -- passo 12: placa principal e o texto que veio na secundária
  v_placa       text;
  v_placa_sec_enviada text;
  -- passo 13: veículo e comissões do perfil, destinos, adiantamento e totais
  v_tipo          text;
  v_com_carreta   numeric;
  v_com_rodotrem  numeric;
  v_destino_ini   text;
  v_destino_fim   text;
  v_adiantamento  numeric;
  -- passo 23: lista de adiantamentos já limpa
  v_adiant_lista  jsonb;
  v_total_frete   numeric;
  v_vr_comissao   numeric;
  v_saldo         numeric;
  v_fin           jsonb;
  -- passo 14: datas da viagem
  v_data_saida    date;
  v_data_chegada  date;
  v_datas         jsonb;
  -- passo 17: número e data do envio do rascunho
  v_envio         jsonb := '{}'::jsonb;
  v_numero        text;
begin
  -- ---------------- Admin / diretoria: livre ----------------
  if public.is_admin() then
    if new.status = 'aprovado'
       and (tg_op = 'INSERT' or old.status is distinct from 'aprovado') then
      new.aprovado_por := coalesce(auth.jwt() ->> 'email', 'admin');
      new.aprovado_em  := now();
    end if;
    return new;
  end if;

  -- ---------------- Motorista (qualquer não-admin) ----------------
  if new.status is null or new.status not in ('rascunho', 'pendente') then
    raise exception 'Acesso negado: status inválido para motorista.';
  end if;

  -- passo 17: depois de enviada (pendente, aprovado...), o motorista não altera mais
  if tg_op = 'UPDATE' and old.status is distinct from 'rascunho' then
    raise exception 'Acesso negado: esta ficha já foi enviada e não pode ser alterada.';
  end if;

  -- passo 13: perfil de quem está logado (INSERT e UPDATE): nome, CPF, tipo de
  -- veículo e comissões especiais do Alimentício
  select nome, cpf, tipo_veiculo, comissao_alim_carreta, comissao_alim_rodotrem
    into v_perfil from public.perfis where id = auth.uid();
  v_tipo         := coalesce(v_perfil.tipo_veiculo, 'carreta');
  v_com_carreta  := v_perfil.comissao_alim_carreta;
  v_com_rodotrem := v_perfil.comissao_alim_rodotrem;

  if tg_op = 'UPDATE' then
    v_antigo_row := to_jsonb(old);
    if jsonb_typeof(v_antigo_row -> 'dados_completos') = 'object' then
      v_antigo_dc := v_antigo_row -> 'dados_completos';
    end if;
  end if;

  -- Só os campos que o motorista pode preencher, já limpos
  v_abast    := public._limpar_abastecimentos(coalesce(to_jsonb(new) -> 'abastecimentos', v_novo_dc -> 'abastecimentos'));
  -- passo 13: comissão calculada pela regra, com o veículo de cada linha
  v_fretes   := public._limpar_fretes(v_novo_dc -> 'fretes', v_antigo_dc -> 'fretes', v_tipo, v_com_carreta, v_com_rodotrem);
  v_despesas := public._limpar_outras_despesas(
                  coalesce(to_jsonb(new) -> 'despesas_extras', v_novo_dc -> 'outrasDespesas'),
                  coalesce(v_antigo_row -> 'despesas_extras', v_antigo_dc -> 'outrasDespesas'));
  v_anexos   := public._limpar_comprovantes(coalesce(to_jsonb(new) -> 'comprovantes', v_novo_dc -> 'anexos'));

  -- passo 13: destinos e adiantamento (coluna; dados_completos é a reserva)
  v_destino_ini  := nullif(btrim(public._txt(coalesce(nullif(to_jsonb(new) -> 'destino_inicial', 'null'::jsonb),
                                                      v_novo_dc -> 'destinoInicial'), 120) #>> '{}'), '');
  v_destino_fim  := nullif(btrim(public._txt(coalesce(nullif(to_jsonb(new) -> 'destino_final', 'null'::jsonb),
                                                      v_novo_dc -> 'destinoFinal'), 120) #>> '{}'), '');
  -- passo 23: com lista (até 100; mais = erro), o adiantamento é a soma das linhas;
  -- sem lista (página antiga, ficha antiga), o valor único de antes, do mesmo jeito.
  v_adiant_lista := public._limpar_adiantamentos(v_novo_dc -> 'adiantamentos');
  -- (a coluna tem default 0: o 0 dela não pode esconder o valor de dados_completos)
  v_adiantamento := coalesce((select sum(public._moeda(a -> 'valor')) from jsonb_array_elements(v_adiant_lista) a),
                             nullif(public._moeda(to_jsonb(new) -> 'valor_adiantamento'), 0),
                             public._moeda(v_novo_dc -> 'valorAdiantamento'),
                             public._moeda(to_jsonb(new) -> 'valor_adiantamento'));
  -- total_frete, vr_comissao e saldo_comissao não são lidos da coluna: são calculados abaixo

  -- passo 13: totais calculados a partir das linhas limpas
  select coalesce(sum(public._moeda(f -> 'valor')), 0),
         coalesce(sum(public._moeda(f -> 'comissao')), 0)
    into v_total_frete, v_vr_comissao
    from jsonb_array_elements(v_fretes) f;
  v_saldo := v_vr_comissao - coalesce(v_adiantamento, 0);

  v_fin := jsonb_build_object(
             'destinoInicial',    coalesce(v_destino_ini, ''),
             'destinoFinal',      coalesce(v_destino_fim, ''),
             'valorAdiantamento', coalesce(public._moeda_txt(v_adiantamento), ''),
             -- passo 23: as linhas (sem lista: [])
             'adiantamentos',     v_adiant_lista,
             'totalFrete',        public._moeda_txt(v_total_frete),
             'vrComissao',        public._moeda_txt(v_vr_comissao),
             'saldoComissao',     public._moeda_txt(v_saldo));

  -- passo 14: datas de saída e chegada (coluna; dados_completos é a reserva).
  -- Gravadas em dados_completos como a ficha usa (DD/MM/AAAA).
  v_data_saida   := coalesce(public._data(to_jsonb(new) -> 'data_saida'),
                             public._data(v_novo_dc -> 'dataSaida'));
  v_data_chegada := coalesce(public._data(to_jsonb(new) -> 'data_chegada'),
                             public._data(v_novo_dc -> 'dataChegada'));
  v_datas := jsonb_build_object(
               'dataSaida',   coalesce(to_char(v_data_saida, 'DD/MM/YYYY'), ''),
               'dataChegada', coalesce(to_char(v_data_chegada, 'DD/MM/YYYY'), ''));

  -- passo 12: placa principal da coluna placas; dados_completos.placas é a reserva
  v_placa := coalesce(public._placa(to_jsonb(new) -> 'placas'),
                      public._placa(v_novo_dc -> 'placas'));

  -- passo 11: KMs e placa secundária vindos do motorista (dados_completos)
  v_km_saida   := public._km(v_novo_dc -> 'kmSaida')::bigint;
  v_km_entrada := public._km(v_novo_dc -> 'kmEntrada')::bigint;
  v_placa_sec  := public._placa(v_novo_dc -> 'placaSecundaria');
  v_placa_sec_enviada := nullif(btrim(public._txt(v_novo_dc -> 'placaSecundaria', 20) #>> '{}'), '');
  -- O segundo trecho só existe quando há placa secundária
  if v_placa_sec is not null then
    v_km_saida2   := public._km(v_novo_dc -> 'kmSaida2')::bigint;
    v_km_entrada2 := public._km(v_novo_dc -> 'kmEntrada2')::bigint;
  end if;

  -- passo 12: regras do envio (só em 'pendente'; rascunho pode ficar incompleto)
  if new.status = 'pendente' then
    if v_placa is null then
      raise exception 'Informe a placa principal (ex.: ABC-1D23).';
    end if;
    if v_placa_sec_enviada is not null and v_placa_sec is null then
      raise exception 'Placa secundária inválida.';
    end if;
    if v_placa_sec = v_placa then
      raise exception 'A placa secundária não pode ser igual à principal.';
    end if;
    -- passo 14: datas obrigatórias e chegada não antes da saída
    if v_data_saida is null or v_data_chegada is null then
      raise exception 'Informe a data de saída e a data de chegada.';
    end if;
    if v_data_chegada < v_data_saida then
      raise exception 'A data de chegada não pode ser antes da data de saída.';
    end if;
    if v_km_saida is null or v_km_entrada is null then
      raise exception 'Informe o KM de saída e o KM de chegada.';
    end if;
    if v_placa_sec is not null and (v_km_saida2 is null or v_km_entrada2 is null) then
      raise exception 'Informe o KM de saída e o KM de chegada da placa secundária.';
    end if;
    if v_km_entrada < v_km_saida or v_km_entrada2 < v_km_saida2 then
      raise exception 'O KM de chegada não pode ser menor que o de saída.';
    end if;
    -- passo 13: rodotrem escolhe o veículo em cada frete do Alimentício com valor
    if v_tipo in ('rodotrem', 'carreta_rodotrem') and exists (
         select 1 from jsonb_array_elements(v_fretes) f
          where f ->> 'cliente' = 'alimenticio'
            and coalesce(public._moeda(f -> 'valor'), 0) > 0
            and f ->> 'veiculo' is null) then
      raise exception 'Escolha o veículo (carreta ou rodotrem) em cada frete do Alimentício.';
    end if;
  end if;

  -- Totais calculados aqui (o motorista não envia): entrada - saída,
  -- só quando os dois existem e entrada >= saída
  if v_km_entrada >= v_km_saida then
    v_km_total1 := v_km_entrada - v_km_saida;
  end if;
  if v_km_entrada2 >= v_km_saida2 then
    v_km_total2 := v_km_entrada2 - v_km_saida2;
  end if;
  -- Viagem toda: soma só os trechos que existem
  if v_km_total1 is not null or v_km_total2 is not null then
    v_km_total := coalesce(v_km_total1, 0) + coalesce(v_km_total2, 0);
  end if;

  v_km := jsonb_build_object(
            'kmSaida',         v_km_saida::text,
            'kmEntrada',       v_km_entrada::text,
            'kmTotal1',        v_km_total1::text,
            'placaSecundaria', v_placa_sec,
            'kmSaida2',        v_km_saida2::text,
            'kmEntrada2',      v_km_entrada2::text,
            'kmTotal2',        v_km_total2::text,
            'kmTotal',         v_km_total::text);

  -- dados_completos = o que já estava no banco + só as partes do motorista
  -- passo 12: + placas (a principal, limpa)
  -- passo 13: + destinos, adiantamento e totais de frete/comissão
  -- passo 14: + datas de saída e chegada
  v_dc := v_antigo_dc || jsonb_build_object(
            'placas',         v_placa,
            'abastecimentos', v_abast,
            'fretes',         v_fretes,
            'outrasDespesas', v_despesas,
            'despesas_extras',v_despesas,
            'anexos',         v_anexos,
            'comprovantes',   v_anexos) || v_km || v_fin || v_datas;

  if tg_op = 'INSERT' then
    -- passo 17: rascunho não gasta número; o id provisório só tem letras,
    -- números e hífen (é também o nome da pasta dos comprovantes)
    if new.status = 'rascunho' then
      new.id := 'RASC-' || replace(gen_random_uuid()::text, '-', '');
    end if;

    -- Dados do motorista vêm do perfil de quem está logado, não do navegador
    -- (passo 13: o perfil já foi lido no começo da parte do motorista)
    v_dc := v_dc || jsonb_build_object(
              'id',           new.id,
              'protocolo',    new.id,
              'motorista',    coalesce(v_perfil.nome, ''),
              'motoristaCpf', coalesce(v_perfil.cpf, ''),
              'motorista_cpf',coalesce(v_perfil.cpf, ''),
              'motoristaId',  auth.uid(),
              'dataEnvio',    to_char(now() at time zone 'America/Sao_Paulo', 'DD/MM/YYYY, HH24:MI:SS'),
              'origemEnvio',  'motorista_com_login',
              'status',       new.status);

    -- Zera todas as colunas que aceitam nulo (exceto as do motorista)...
    select coalesce(jsonb_object_agg(a.attname, null), '{}'::jsonb) into v_nulos
    from pg_attribute a
    where a.attrelid = 'public.fichas_viagem'::regclass
      and a.attnum > 0 and not a.attisdropped and not a.attnotnull
      and a.attname not in ('id','status','abastecimentos','comprovantes','despesas_extras','dados_completos');

    -- ...e aplica só o que é permitido/forçado.
    -- (chaves de colunas que não existirem na tabela são ignoradas)
    -- passo 11: km_saida, km_chegada e km_total vêm dos valores já limpos
    -- passo 12: placas vem da placa principal já limpa
    -- passo 13: destinos, adiantamento e totais de frete/comissão
    -- passo 14: data_saida e data_chegada
    new := jsonb_populate_record(new, v_nulos || jsonb_build_object(
             'motorista_id',    auth.uid(),
             'iniciada_em',     now(),
             'data_envio',      now(),
             'motorista',       v_perfil.nome,
             'motorista_cpf',   v_perfil.cpf,
             'origem_envio',    'motorista_com_login',
             'data_saida',      v_data_saida,
             'data_chegada',    v_data_chegada,
             'placas',          v_placa,
             'km_saida',        v_km_saida,
             'km_chegada',      v_km_entrada,
             'km_total',        v_km_total,
             'destino_inicial',    v_destino_ini,
             'destino_final',      v_destino_fim,
             'valor_adiantamento', v_adiantamento,
             'total_frete',        v_total_frete,
             'vr_comissao',        v_vr_comissao,
             'saldo_comissao',     v_saldo,
             'abastecimentos',  v_abast,
             'comprovantes',    v_anexos,
             'despesas_extras', v_despesas,
             'dados_completos', v_dc));
  else
    -- passo 17: envio do rascunho (rascunho -> pendente) = número da ficha e
    -- data do envio agora (no INSERT do rascunho a data_envio é a do começo da viagem)
    if old.status = 'rascunho' and new.status = 'pendente' then
      v_numero := public.reservar_numero_ficha();
      v_envio  := jsonb_build_object('id', v_numero, 'data_envio', now());
      v_dc := v_dc || jsonb_build_object(
                'id',        v_numero,
                'protocolo', v_numero,
                'dataEnvio', to_char(now() at time zone 'America/Sao_Paulo', 'DD/MM/YYYY, HH24:MI:SS'));
    end if;

    -- UPDATE: parte da linha antiga e troca só o que o motorista pode mexer
    -- passo 12: placas passa a ser a que o motorista mandou (limpa)
    -- passo 13: + destinos, adiantamento e totais de frete/comissão
    -- passo 14: + data_saida e data_chegada
    -- passo 17: + id e data_envio no envio do rascunho (v_envio; vazio nos outros casos)
    new := jsonb_populate_record(old, jsonb_build_object(
             'status',          new.status,
             'data_saida',      v_data_saida,
             'data_chegada',    v_data_chegada,
             'placas',          v_placa,
             'km_saida',        v_km_saida,
             'km_chegada',      v_km_entrada,
             'km_total',        v_km_total,
             'destino_inicial',    v_destino_ini,
             'destino_final',      v_destino_fim,
             'valor_adiantamento', v_adiantamento,
             'total_frete',        v_total_frete,
             'vr_comissao',        v_vr_comissao,
             'saldo_comissao',     v_saldo,
             'abastecimentos',  v_abast,
             'comprovantes',    v_anexos,
             'despesas_extras', v_despesas,
             'dados_completos', v_dc || jsonb_build_object('status', new.status)) || v_envio);
  end if;

  return new;
end;
$function$;


commit;


-- =============================================================================
-- 8. Conferências (depois do commit; rode cada bloco separadamente)
--    Cada uma desfaz tudo no final (rollback). O resultado aparece como erro
--    "RESULTADO (nada foi salvo): ...".
--    Rodam como o primeiro perfil com role = 'motorista' SEM rascunho em
--    andamento (A; deixado como carreta, sem comissão especial, dentro da
--    mesma transação). A 8.5 usa também o segundo (B; sem ele, B é o próprio A).
--    Frete de teste: Shopee de R$ 10.000,00 = comissão de R$ 1.100,00.
-- =============================================================================

-- 8.1 Motorista grava 1, 5 e 100 adiantamentos (esperado: um=1 linha 500.00 | cinco=5 linhas 1500.00 (100,00 + 200,00 + 300,00 + 400,00 + 500,00) | cem=100 linhas 1000.00 | ultimo=10,00 | dc_valor=1.000,00 | saldo=100.00 | status=pendente)
begin;
-- (número de teste só nesta transação: sequência não volta no rollback, e a conferência não pode gastar número)
create or replace function public.reservar_numero_ficha() returns text language sql as $$ select 'AJB-TESTE-P23'::text $$;
select set_config('p23.a', (select p.id::text from public.perfis p where p.role = 'motorista'
         and not exists (select 1 from public.fichas_viagem f where f.motorista_id = p.id and f.status = 'rascunho')
       order by p.id limit 1), true);
update public.perfis set tipo_veiculo = 'carreta', comissao_alim_carreta = null, comissao_alim_rodotrem = null
 where id = current_setting('p23.a')::uuid;
select set_config('request.jwt.claims', json_build_object('sub', current_setting('p23.a'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
declare
  r1   record;
  r5   record;
  r100 record;
  v_frete jsonb := '[{"data": "01/10/2026", "cliente": "shopee", "origem": "Marília - SP", "destino": "Santos - SP", "valor": "10.000,00"}]';
  v_cem   jsonb;
begin
  select jsonb_agg(jsonb_build_object('valor', '10,00')) into v_cem from generate_series(1, 100);
  -- rascunho com 1, depois com 5, e envio com 100 (a coluna diz 9999: vale a soma da lista)
  insert into public.fichas_viagem (id, motorista, status, dados_completos)
  values ('x', 'teste', 'rascunho', '{"valorAdiantamento": "500,00", "adiantamentos": [{"valor": "500,00"}]}')
  returning * into r1;
  update public.fichas_viagem
     set dados_completos = '{"valorAdiantamento": "1.500,00", "adiantamentos": [{"valor": "100,00"}, {"valor": "200,00"},
                             {"valor": "300,00"}, {"valor": "400,00"}, {"valor": "500,00"}]}'
   where id = r1.id
  returning * into r5;
  update public.fichas_viagem
     set status = 'pendente', placas = 'ABC1D23', data_saida = '2026-10-01', data_chegada = '2026-10-05', valor_adiantamento = 9999,
         dados_completos = jsonb_build_object('kmSaida', '100000', 'kmEntrada', '101500', 'valorAdiantamento', '1.000,00',
                                              'fretes', v_frete, 'adiantamentos', v_cem)
   where id = r1.id
  returning * into r100;
  raise exception 'RESULTADO (nada foi salvo): um=% linha % | cinco=% linhas % (%) | cem=% linhas % | ultimo=% | dc_valor=% | saldo=% | status=%',
    jsonb_array_length(r1.dados_completos -> 'adiantamentos'), r1.valor_adiantamento::numeric(14,2),
    jsonb_array_length(r5.dados_completos -> 'adiantamentos'), r5.valor_adiantamento::numeric(14,2),
    (select string_agg(a ->> 'valor', ' + ' order by i)
       from jsonb_array_elements(r5.dados_completos -> 'adiantamentos') with ordinality as t(a, i)),
    jsonb_array_length(r100.dados_completos -> 'adiantamentos'), r100.valor_adiantamento::numeric(14,2),
    r100.dados_completos -> 'adiantamentos' -> 99 ->> 'valor', r100.dados_completos ->> 'valorAdiantamento',
    r100.saldo_comissao::numeric(14,2), r100.status;
end $$;
rollback;

-- 8.2 101 adiantamentos são recusados (esperado: criar_com_101=recusado (No máximo 100 adiantamentos por ficha.) | alterar_para_101=recusado (No máximo 100 adiantamentos por ficha.) | rascunho_continua=2 linhas 300.00 | rascunhos_gravados=1)
begin;
select set_config('p23.a', (select p.id::text from public.perfis p where p.role = 'motorista'
         and not exists (select 1 from public.fichas_viagem f where f.motorista_id = p.id and f.status = 'rascunho')
       order by p.id limit 1), true);
update public.perfis set tipo_veiculo = 'carreta', comissao_alim_carreta = null, comissao_alim_rodotrem = null
 where id = current_setting('p23.a')::uuid;
select set_config('request.jwt.claims', json_build_object('sub', current_setting('p23.a'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
declare
  v_101     jsonb;
  v_criar   text := 'GRAVOU';
  v_alterar text := 'GRAVOU';
  v_id      text;
begin
  select jsonb_agg(jsonb_build_object('valor', '1,00')) into v_101 from generate_series(1, 101);
  begin
    insert into public.fichas_viagem (id, motorista, status, dados_completos)
    values ('x', 'teste', 'rascunho', jsonb_build_object('adiantamentos', v_101));
  exception when others then v_criar := 'recusado (' || sqlerrm || ')';
  end;
  insert into public.fichas_viagem (id, motorista, status, dados_completos)
  values ('x', 'teste', 'rascunho', '{"adiantamentos": [{"valor": "100,00"}, {"valor": "200,00"}]}')
  returning id into v_id;
  begin
    update public.fichas_viagem set dados_completos = jsonb_build_object('adiantamentos', v_101) where id = v_id;
  exception when others then v_alterar := 'recusado (' || sqlerrm || ')';
  end;
  raise exception 'RESULTADO (nada foi salvo): criar_com_101=% | alterar_para_101=% | rascunho_continua=% linhas % | rascunhos_gravados=%',
    v_criar, v_alterar,
    (select jsonb_array_length(dados_completos -> 'adiantamentos') from public.fichas_viagem where id = v_id),
    (select valor_adiantamento::numeric(14,2) from public.fichas_viagem where id = v_id),
    (select count(*) from public.fichas_viagem where motorista_id = auth.uid() and status = 'rascunho');
end $$;
rollback;

-- 8.3 A soma é do banco (esperado: centavos=100 linhas 10.00 | formatos=1.235,00 | lixo_fica_de_fora=2 linhas 1.200,00 (1.000,00 + 200,00) | coluna_diferente=300.00 | saldo=800.00)
--     100 x 0,10; "1.234,56" + "0,44"; linhas vazias, texto e não-objeto ficam de fora (número 200 vale);
--     a coluna valor_adiantamento diferente da lista não vale.
begin;
select set_config('p23.a', (select p.id::text from public.perfis p where p.role = 'motorista'
         and not exists (select 1 from public.fichas_viagem f where f.motorista_id = p.id and f.status = 'rascunho')
       order by p.id limit 1), true);
update public.perfis set tipo_veiculo = 'carreta', comissao_alim_carreta = null, comissao_alim_rodotrem = null
 where id = current_setting('p23.a')::uuid;
select set_config('request.jwt.claims', json_build_object('sub', current_setting('p23.a'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
declare
  r_cent record;
  r_fmt  record;
  r_lixo record;
  r_col  record;
  v_cent jsonb;
begin
  select jsonb_agg(jsonb_build_object('valor', '0,10')) into v_cent from generate_series(1, 100);
  insert into public.fichas_viagem (id, motorista, status, dados_completos)
  values ('x', 'teste', 'rascunho', jsonb_build_object('adiantamentos', v_cent))
  returning * into r_cent;
  update public.fichas_viagem set dados_completos = '{"adiantamentos": [{"valor": "1.234,56"}, {"valor": "0,44"}]}'
   where id = r_cent.id returning * into r_fmt;
  update public.fichas_viagem
     set dados_completos = '{"adiantamentos": [{"valor": ""}, {"valor": "abc"}, "500,00", 7, {"valor": "1.000,00"}, {"outro": "1,00"}, {"valor": 200}]}'
   where id = r_cent.id returning * into r_lixo;
  update public.fichas_viagem
     set valor_adiantamento = 9999,
         dados_completos = '{"valorAdiantamento": "9.999,00", "adiantamentos": [{"valor": "100,00"}, {"valor": "200,00"}],
                             "fretes": [{"data": "01/10/2026", "cliente": "shopee", "origem": "A", "destino": "B", "valor": "10.000,00"}]}'
   where id = r_cent.id returning * into r_col;
  raise exception 'RESULTADO (nada foi salvo): centavos=% linhas % | formatos=% | lixo_fica_de_fora=% linhas % (%) | coluna_diferente=% | saldo=%',
    jsonb_array_length(r_cent.dados_completos -> 'adiantamentos'), r_cent.valor_adiantamento::numeric(14,2),
    r_fmt.dados_completos ->> 'valorAdiantamento',
    jsonb_array_length(r_lixo.dados_completos -> 'adiantamentos'), r_lixo.dados_completos ->> 'valorAdiantamento',
    (select string_agg(a ->> 'valor', ' + ' order by i)
       from jsonb_array_elements(r_lixo.dados_completos -> 'adiantamentos') with ordinality as t(a, i)),
    r_col.valor_adiantamento::numeric(14,2), r_col.saldo_comissao::numeric(14,2);
end $$;
rollback;

-- 8.4 Fichas no formato de antes continuam válidas (esperado: fichas_com_mais_de_100=0 | so_valor_unico=500.00 lista=0 | saldo=600.00 | status=pendente | so_coluna=700.00 lista=0)
--     Envio direto da página antiga (só valorAdiantamento, sem lista) e rascunho só com a coluna:
--     passam pelo trigger do motorista do mesmo jeito de antes; nenhuma ficha gravada passa do teto.
begin;
create or replace function public.reservar_numero_ficha() returns text language sql as $$ select 'AJB-TESTE-P23'::text $$;
-- contagem feita antes do set role (a RLS do motorista esconderia as fichas dos outros)
select set_config('p23.mais_de_100', (select count(*)::text from public.fichas_viagem
         where jsonb_typeof(dados_completos -> 'adiantamentos') = 'array'
           and jsonb_array_length(dados_completos -> 'adiantamentos') > 100), true);
select set_config('p23.a', (select p.id::text from public.perfis p where p.role = 'motorista'
         and not exists (select 1 from public.fichas_viagem f where f.motorista_id = p.id and f.status = 'rascunho')
       order by p.id limit 1), true);
update public.perfis set tipo_veiculo = 'carreta', comissao_alim_carreta = null, comissao_alim_rodotrem = null
 where id = current_setting('p23.a')::uuid;
select set_config('request.jwt.claims', json_build_object('sub', current_setting('p23.a'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
declare
  r_env  record;
  r_rasc record;
begin
  insert into public.fichas_viagem (id, motorista, status, placas, data_saida, data_chegada, dados_completos)
  values ('x', 'teste', 'pendente', 'ABC1D23', '2026-10-01', '2026-10-05',
          '{"kmSaida": "100000", "kmEntrada": "101500", "valorAdiantamento": "500,00",
            "fretes": [{"data": "01/10/2026", "cliente": "shopee", "origem": "A", "destino": "B", "valor": "10.000,00"}]}')
  returning * into r_env;
  insert into public.fichas_viagem (id, motorista, status, valor_adiantamento, dados_completos)
  values ('x', 'teste', 'rascunho', 700, '{}')
  returning * into r_rasc;
  raise exception 'RESULTADO (nada foi salvo): fichas_com_mais_de_100=% | so_valor_unico=% lista=% | saldo=% | status=% | so_coluna=% lista=%',
    current_setting('p23.mais_de_100'),
    r_env.valor_adiantamento::numeric(14,2), jsonb_array_length(r_env.dados_completos -> 'adiantamentos'),
    r_env.saldo_comissao::numeric(14,2), r_env.status,
    r_rasc.valor_adiantamento::numeric(14,2), jsonb_array_length(r_rasc.dados_completos -> 'adiantamentos');
end $$;
rollback;

-- 8.5 Motorista só mexe na própria ficha (esperado: b_ve_fichas_de_a=0 | b_altera_rascunho_de_a=bloqueado | a_altera_enviada=bloqueado | rascunho_de_a=2 linhas 500.00 | enviada_de_a=2 linhas 300.00)
--     A cria um rascunho (200 + 300) e envia outra ficha (100 + 200); B tenta ler e alterar o
--     rascunho de A; A tenta alterar a enviada. "bloqueado" vem com o motivo entre parênteses.
begin;
create or replace function public.reservar_numero_ficha() returns text language sql as $$ select 'AJB-TESTE-P23'::text $$;
select set_config('p23.a', (select p.id::text from public.perfis p where p.role = 'motorista'
         and not exists (select 1 from public.fichas_viagem f where f.motorista_id = p.id and f.status = 'rascunho')
       order by p.id limit 1), true);
-- motorista B escolhido aqui (antes do set role: depois dele a RLS pode esconder o perfil de B)
select set_config('p23.b', coalesce((select p.id::text from public.perfis p where p.role = 'motorista'
                                       and p.id::text <> current_setting('p23.a') order by p.id limit 1),
                                    current_setting('p23.a')), true);
update public.perfis set tipo_veiculo = 'carreta', comissao_alim_carreta = null, comissao_alim_rodotrem = null
 where id = current_setting('p23.a')::uuid;
-- motorista A
select set_config('request.jwt.claims', json_build_object('sub', current_setting('p23.a'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
declare v_id text;
begin
  insert into public.fichas_viagem (id, motorista, status, dados_completos)
  values ('x', 'teste', 'rascunho', '{"adiantamentos": [{"valor": "200,00"}, {"valor": "300,00"}]}')
  returning id into v_id;
  perform set_config('p23.rascunho', v_id, true);
  insert into public.fichas_viagem (id, motorista, status, placas, data_saida, data_chegada, dados_completos)
  values ('x', 'teste', 'pendente', 'ABC1D23', '2026-10-01', '2026-10-05',
          '{"kmSaida": "100000", "kmEntrada": "101500", "adiantamentos": [{"valor": "100,00"}, {"valor": "200,00"}]}')
  returning id into v_id;
  perform set_config('p23.enviada', v_id, true);
end $$;
reset role;
-- motorista B lê e tenta alterar o rascunho de A
select set_config('request.jwt.claims', json_build_object('sub', current_setting('p23.b'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
declare v_linhas bigint;
begin
  perform set_config('p23.b_ve', (select count(*)::text from public.fichas_viagem
                                    where id in (current_setting('p23.rascunho'), current_setting('p23.enviada'))), true);
  begin
    update public.fichas_viagem set dados_completos = '{"adiantamentos": [{"valor": "9.999,00"}]}'
     where id = current_setting('p23.rascunho');
    get diagnostics v_linhas = row_count;
    perform set_config('p23.b_altera', case when v_linhas = 0 then 'bloqueado (0 linhas)' else 'LIBERADO' end, true);
  exception when others then perform set_config('p23.b_altera', 'bloqueado (' || sqlerrm || ')', true);
  end;
end $$;
reset role;
-- motorista A tenta alterar a ficha já enviada
select set_config('request.jwt.claims', json_build_object('sub', current_setting('p23.a'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
declare v_linhas bigint;
begin
  begin
    update public.fichas_viagem set dados_completos = '{"adiantamentos": [{"valor": "9.999,00"}]}'
     where id = current_setting('p23.enviada');
    get diagnostics v_linhas = row_count;
    perform set_config('p23.a_altera', case when v_linhas = 0 then 'bloqueado (0 linhas)' else 'LIBERADO' end, true);
  exception when others then perform set_config('p23.a_altera', 'bloqueado (' || sqlerrm || ')', true);
  end;
end $$;
reset role;
do $$
begin
  raise exception 'RESULTADO (nada foi salvo): b_ve_fichas_de_a=% | b_altera_rascunho_de_a=% | a_altera_enviada=% | rascunho_de_a=% linhas % | enviada_de_a=% linhas %',
    case when current_setting('p23.b') = current_setting('p23.a') then 'SEM SEGUNDO MOTORISTA' else current_setting('p23.b_ve') end,
    current_setting('p23.b_altera'), current_setting('p23.a_altera'),
    (select jsonb_array_length(dados_completos -> 'adiantamentos') from public.fichas_viagem where id = current_setting('p23.rascunho')),
    (select valor_adiantamento::numeric(14,2) from public.fichas_viagem where id = current_setting('p23.rascunho')),
    (select jsonb_array_length(dados_completos -> 'adiantamentos') from public.fichas_viagem where id = current_setting('p23.enviada')),
    (select valor_adiantamento::numeric(14,2) from public.fichas_viagem where id = current_setting('p23.enviada'));
end $$;
rollback;

-- 8.6 As duas funções do passo 23 e a gestão (esperado: trigger=definer:true search_path="" ligado:O | limpar=imutavel:i search_path="" | gestao_grava_como_veio=3 linhas 999.00)
--     A gestão continua livre (não passa pela _limpar_adiantamentos nem pela soma).
begin;
select set_config('request.jwt.claims',
         (select json_build_object('sub', id, 'role', 'authenticated',
                                   'app_metadata', json_build_object('role', 'admin'))::text
            from public.perfis where role = 'admin' order by id limit 1), true);
set local role authenticated;
do $$
declare r record;
begin
  insert into public.fichas_viagem (id, motorista, status, valor_adiantamento, dados_completos)
  values ('AJB-TESTE-P23-GESTAO', 'teste', 'pendente', 999,
          '{"adiantamentos": [{"valor": "1,00"}, {"valor": "2,00"}, {"valor": "3,00"}]}')
  returning * into r;
  perform set_config('p23.gestao', format('%s linhas %s', jsonb_array_length(r.dados_completos -> 'adiantamentos'),
                                          r.valor_adiantamento::numeric(14,2)), true);
end $$;
reset role;
do $$
begin
  raise exception 'RESULTADO (nada foi salvo): trigger=definer:% % ligado:% | limpar=imutavel:% % | gestao_grava_como_veio=%',
    (select p.prosecdef::text from pg_proc p where p.oid = 'public.proteger_colunas_admin_fichas()'::regprocedure),
    (select coalesce(array_to_string(p.proconfig, ','), 'SEM search_path') from pg_proc p
      where p.oid = 'public.proteger_colunas_admin_fichas()'::regprocedure),
    (select coalesce(string_agg(t.tgenabled::text, ','), 'SEM TRIGGER') from pg_trigger t
      where t.tgrelid = 'public.fichas_viagem'::regclass
        and t.tgfoid = 'public.proteger_colunas_admin_fichas()'::regprocedure),
    (select p.provolatile::text from pg_proc p where p.oid = 'public._limpar_adiantamentos(jsonb)'::regprocedure),
    (select coalesce(array_to_string(p.proconfig, ','), 'SEM search_path') from pg_proc p
      where p.oid = 'public._limpar_adiantamentos(jsonb)'::regprocedure),
    current_setting('p23.gestao');
end $$;
rollback;

-- 8.7 Nada mais mudou no public (esperado: o mesmo retrato_public e itens do item 0)
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
     and p.proname not in ('_limpar_adiantamentos', 'proteger_colunas_admin_fichas')
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
