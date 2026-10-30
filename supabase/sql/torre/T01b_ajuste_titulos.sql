-- =============================================================================
-- TORRE T01b - Ajuste dos títulos e colunas das views conforme a planilha real
-- AJBorges Transporte & Logística
--
-- Ajusta torre.colunas e recria as views do contrato (drop + create, com
-- security_invoker = true) para bater com os títulos reais da planilha
-- "TORRE DE CONTROLE SHOPEE" levantados na 1ª cópia (titulos.csv):
--   1. Remove as colunas do contrato que não existem na planilha.
--   2. Cria uma coluna (snake_case, sem acento, com <col>_situacao) para cada
--      título real sem coluna, mantendo ordem e as colunas que já batem.
--   3. Mapeia os sinônimos de VALIDAÇÕES PRÉ CARREGAMENTO:
--      "0RIGEM" -> origem; "STATUS ATUAL" -> status.
--   4. Ignora títulos de uma letra só (U em ORIGEM, L em VALIDAÇÕES).
--   5. Mantém grants e RLS iguais (leitura só para torre.eh_operador()).
--   6. Não altera nem cria nada fora do schema torre.
--
-- Como rodar (SQL Editor do Supabase):
--   a) rode o item 0 sozinho e anote o retrato_public (antes);
--   b) rode do "begin;" até o "commit;" (transação única);
--   c) rode cada conferência do item 4 separadamente (tudo termina em rollback
--      e mostra "RESULTADO ...").
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 0. Retrato do public ANTES (rode e anote; a conferência 4.5 repete e compara)
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
    from pg_default_acl d where d.defaclnamespace not in (select oid from pg_namespace where nspname = 'torre')
) s;


begin;

-- Guarda na sessão o retrato do public antes da mudança (para a conferência 4.5 comparar na mesma sessão)
select set_config('torre.retrato_public_antes', (
  select md5(string_agg(x, E'\n' order by x)) || ' (' || count(*) || ' itens)'
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
      from pg_default_acl d where d.defaclnamespace not in (select oid from pg_namespace where nspname = 'torre')
  ) s
), false);


-- -----------------------------------------------------------------------------
-- 1. Atualiza o mapa título da planilha -> coluna das views (torre.colunas)
-- -----------------------------------------------------------------------------
delete from torre.colunas;

insert into torre.colunas (aba, coluna, ordem, titulos, grupos, situacao, com_url)
select m.aba, m.coluna, row_number() over ()::int, m.titulos, m.grupos, m.situacao, m.com_url
from (values
  -- MATRIZ (linha 6 = títulos, linha 5 = blocos)
  ('MATRIZ', 'lh',                         array['LH', 'LT'],                                       '{}'::text[],                        true,  false),
  ('MATRIZ', 'cavalo',                     array['CAVALO', 'PLACA', 'PLACA CAVALO'],                '{}',                                true,  false),
  ('MATRIZ', 'rota',                       array['ROTA'],                                           '{}',                                true,  false),
  ('MATRIZ', 'validador_origem',           array['VALIDADOR ORIGEM'],                               '{}',                                true,  false),
  ('MATRIZ', 'origem_eta',                 array['ETA', 'ETA ORIGEM'],                              array['ORIGEM'],                     true,  false),
  ('MATRIZ', 'origem_localizacao',         array['LOCALIZAÇÃO', 'POSIÇÃO ATUAL', 'POSIÇÃO'],        array['ORIGEM'],                     true,  true),
  ('MATRIZ', 'origem_km',                  array['KM', 'KM RESTANTE', 'DISTÂNCIA'],                 array['ORIGEM'],                     true,  false),
  ('MATRIZ', 'origem_timer',               array['TIMER'],                                          array['ORIGEM'],                     true,  false),
  ('MATRIZ', 'carregamento_cpt',           array['CPT'],                                            array['CARREGAMENTO', 'CARREGAMENTOS'], true, false),
  ('MATRIZ', 'carregamento_timer',         array['TIMER'],                                          array['CARREGAMENTO', 'CARREGAMENTOS'], true, false),
  ('MATRIZ', 'carregamento_status',        array['STATUS'],                                         array['CARREGAMENTO', 'CARREGAMENTOS'], true, false),
  ('MATRIZ', 'transito_previsao_chegada',  array['PREVISÃO DE CHEGADA', 'PREVISÃO CHEGADA', 'PREVISÃO'], array['TRÂNSITO'],             true,  false),
  ('MATRIZ', 'transito_cpt',               array['CPT'],                                            array['TRÂNSITO'],                   true,  false),
  ('MATRIZ', 'transito_eta_destino',       array['ETA DESTINO', 'ETA'],                             array['TRÂNSITO'],                   true,  false),
  ('MATRIZ', 'transito_status',            array['STATUS'],                                         array['TRÂNSITO'],                   true,  false),
  ('MATRIZ', 'transito_parada',            array['PARADA', 'T PARADA', 'TEMPO PARADO'],             array['TRÂNSITO'],                   true,  false),
  ('MATRIZ', 'transito_kh',                array['KM/H', 'K/H', 'KH'],                              array['TRÂNSITO'],                   true,  false),
  ('MATRIZ', 'transito_tt_restante',       array['TT RESTANTE', 'TEMPO RESTANTE', 'TT'],            array['TRÂNSITO'],                   true,  false),
  ('MATRIZ', 'transito_delta_tt',          array['DELTA TT'],                                       array['TRÂNSITO'],                   true,  false),
  ('MATRIZ', 'descarga_chegada',           array['CHEGADA'],                                        array['DESCARGAS', 'DESCARGA'],      true,  false),
  ('MATRIZ', 'descarga_timer',             array['TIMER'],                                          array['DESCARGAS', 'DESCARGA'],      true,  false),
  ('MATRIZ', 'descarga_status',            array['STATUS'],                                         array['DESCARGAS', 'DESCARGA'],      true,  false),
  -- VALIDAÇÕES PRÉ CARREGAMENTO (títulos na linha 3; "0RIGEM" -> origem, "STATUS ATUAL" -> status; L ignorado)
  ('VALIDAÇÕES PRÉ CARREGAMENTO', 'lh',            array['LH', 'LT'],                               '{}',                                true,  false),
  ('VALIDAÇÕES PRÉ CARREGAMENTO', 'motorista',     array['MOTORISTA'],                              '{}',                                true,  false),
  ('VALIDAÇÕES PRÉ CARREGAMENTO', 'cavalo',        array['CAVALO', 'PLACA', 'PLACA CAVALO'],        '{}',                                true,  false),
  ('VALIDAÇÕES PRÉ CARREGAMENTO', 'origem',        array['0RIGEM', 'ORIGEM'],                       '{}',                                true,  false),
  ('VALIDAÇÕES PRÉ CARREGAMENTO', 'checklist',     array['CHECKLIST', 'CHECK LIST'],                '{}',                                true,  false),
  ('VALIDAÇÕES PRÉ CARREGAMENTO', 'sm',            array['SM'],                                     '{}',                                true,  false),
  ('VALIDAÇÕES PRÉ CARREGAMENTO', 'status',        array['STATUS ATUAL', 'STATUS'],                 '{}',                                true,  false),
  ('VALIDAÇÕES PRÉ CARREGAMENTO', 'espelhamento',  array['ESPELHAMENTO'],                           '{}',                                true,  false),
  ('VALIDAÇÕES PRÉ CARREGAMENTO', 'etapa',         array['ETAPA'],                                  '{}',                                true,  false),
  ('VALIDAÇÕES PRÉ CARREGAMENTO', 'timer',         array['TIMER'],                                  '{}',                                true,  false),
  -- ORIGEM (U ignorado)
  ('ORIGEM', 'lh',                  array['LH', 'LT'],                                              '{}', true, false),
  ('ORIGEM', 'motorista',           array['MOTORISTA'],                                             '{}', true, false),
  ('ORIGEM', 'contato',             array['CONTATO DO MOTORISTA', 'CONTATO', 'TELEFONE'],           '{}', true, false),
  ('ORIGEM', 'cavalo',              array['CAVALO', 'PLACA', 'PLACA CAVALO'],                       '{}', true, false),
  ('ORIGEM', 'carreta',             array['CARRETA', 'PLACA CARRETA'],                              '{}', true, false),
  ('ORIGEM', 'vinculo',             array['VÍNCULO'],                                               '{}', true, false),
  ('ORIGEM', 'origem',              array['ORIGEM'],                                                '{}', true, false),
  ('ORIGEM', 'posicao_atual',       array['POSIÇÃO ATUAL', 'LOCALIZAÇÃO', 'POSIÇÃO'],               '{}', true, true),
  ('ORIGEM', 'eta',                 array['ETA', 'ETA ORIGEM', 'PREVISÃO DE CHEGADA'],              '{}', true, false),
  ('ORIGEM', 'status',              array['STATUS'],                                                '{}', true, false),
  ('ORIGEM', 'checklist',           array['CHECKLIST'],                                             '{}', true, false),
  ('ORIGEM', 'chega_a_tempo',       array['CHEGA A TEMPO?'],                                        '{}', true, false),
  ('ORIGEM', 'espelhamento',        array['ESPELHAMENTO'],                                          '{}', true, false),
  ('ORIGEM', 'km_faltante',         array['KM FALTANTE'],                                           '{}', true, false),
  ('ORIGEM', 'km_h',                array['KM/H'],                                                  '{}', true, false),
  ('ORIGEM', 'macro',               array['MACRO'],                                                 '{}', true, false),
  ('ORIGEM', 'sm',                  array['SM'],                                                    '{}', true, false),
  ('ORIGEM', 'tag',                 array['TAG'],                                                   '{}', true, false),
  ('ORIGEM', 'tempo_para_bipagem',  array['TEMPO PARA BIPAGEM'],                                    '{}', true, false),
  ('ORIGEM', 'ultima_atualizacao',  array['ULTIMA ATUALIZAÇÃO'],                                    '{}', true, false),
  -- CARREGAMENTOS
  ('CARREGAMENTOS', 'lh',                  array['LH', 'LT'],                                       '{}', true, false),
  ('CARREGAMENTOS', 'motorista',           array['MOTORISTA'],                                      '{}', true, false),
  ('CARREGAMENTOS', 'contato',             array['CONTATO DO MOTORISTA', 'CONTATO', 'TELEFONE'],    '{}', true, false),
  ('CARREGAMENTOS', 'cavalo',              array['CAVALO', 'PLACA', 'PLACA CAVALO'],                '{}', true, false),
  ('CARREGAMENTOS', 'carreta',             array['CARRETA', 'PLACA CARRETA'],                       '{}', true, false),
  ('CARREGAMENTOS', 'vinculo',             array['VÍNCULO'],                                        '{}', true, false),
  ('CARREGAMENTOS', 'origem',              array['ORIGEM'],                                         '{}', true, false),
  ('CARREGAMENTOS', 'destino',             array['DESTINO'],                                        '{}', true, false),
  ('CARREGAMENTOS', 'cpt',                 array['CPT', 'CPT ORIGEM'],                              '{}', true, false),
  ('CARREGAMENTOS', 'status',              array['STATUS'],                                         '{}', true, false),
  ('CARREGAMENTOS', 'checklist',           array['CHECKLIST'],                                      '{}', true, false),
  ('CARREGAMENTOS', 'macro',               array['MACRO'],                                          '{}', true, false),
  ('CARREGAMENTOS', 'sm',                  array['SM'],                                             '{}', true, false),
  ('CARREGAMENTOS', 'status_cpt',          array['STATUS CPT'],                                     '{}', true, false),
  ('CARREGAMENTOS', 'tag',                 array['TAG'],                                            '{}', true, false),
  ('CARREGAMENTOS', 'ultima_atualizacao',  array['ULTIMA ATUALIZAÇÃO'],                             '{}', true, false),
  -- TRÂNSITO
  ('TRÂNSITO', 'lh',                 array['LH'],                                                   '{}', true, false),
  ('TRÂNSITO', 'motorista',          array['MOTORISTA'],                                            '{}', true, false),
  ('TRÂNSITO', 'carga',              array['CARGA'],                                                '{}', true, false),
  ('TRÂNSITO', 'contato',            array['CONTATO DO MOTORISTA', 'CONTATO'],                      '{}', true, false),
  ('TRÂNSITO', 'cavalo',             array['CAVALO'],                                               '{}', true, false),
  ('TRÂNSITO', 'carreta',            array['CARRETA'],                                              '{}', true, false),
  ('TRÂNSITO', 'vinculo',            array['VÍNCULO'],                                              '{}', true, false),
  ('TRÂNSITO', 'origem',             array['ORIGEM'],                                               '{}', true, false),
  ('TRÂNSITO', 'destino',            array['DESTINO'],                                              '{}', true, false),
  ('TRÂNSITO', 'posicao_atual',      array['POSIÇÃO ATUAL'],                                        '{}', true, true),
  ('TRÂNSITO', 'cpt_origem',         array['CPT ORIGEM'],                                           '{}', true, false),
  ('TRÂNSITO', 'cpt_realizado',      array['CPT REALIZADO'],                                        '{}', true, false),
  ('TRÂNSITO', 'pct',                array['PCT'],                                                  '{}', true, false),
  ('TRÂNSITO', 'km_h',               array['KM/H'],                                                 '{}', true, false),
  ('TRÂNSITO', 't_parada',           array['T PARADA'],                                             '{}', true, false),
  ('TRÂNSITO', 'total_parada',       array['TOTAL PARADA'],                                         '{}', true, false),
  ('TRÂNSITO', 'macro',              array['MACRO'],                                                '{}', true, false),
  ('TRÂNSITO', 'atualizacao',        array['ATUALIZAÇÃO'],                                          '{}', true, false),
  ('TRÂNSITO', 'previsao_chegada',   array['PREVISÃO DE CHEGADA'],                                  '{}', true, false),
  ('TRÂNSITO', 'eta_destino',        array['ETA DESTINO'],                                          '{}', true, false),
  ('TRÂNSITO', 't_chegada',          array['T CHEGADA'],                                            '{}', true, false),
  ('TRÂNSITO', 'status',             array['STATUS'],                                               '{}', true, false),
  ('TRÂNSITO', 'progressao_viagem',  array['PROGRESSÃO VIAGEM', 'PROGRESSÃO DA VIAGEM'],            '{}', true, false),
  ('TRÂNSITO', 'faturamento',        array['FATURAMENTO'],                                          '{}', true, false),
  ('TRÂNSITO', 'ciot_vpo',           array['CIOT / VPO'],                                           '{}', true, false),
  ('TRÂNSITO', 'sm',                 array['SM'],                                                   '{}', true, false),
  ('TRÂNSITO', 'diferenca_do_cpt',   array['DIFERENÇA DO CPT'],                                     '{}', true, false),
  ('TRÂNSITO', 'limite_de_parada',   array['LIMITE DE PARADA'],                                     '{}', true, false),
  -- DESCARGAS
  ('DESCARGAS', 'lh',               array['LH', 'LT'],                                              '{}', true, false),
  ('DESCARGAS', 'motorista',        array['MOTORISTA'],                                             '{}', true, false),
  ('DESCARGAS', 'contato',          array['CONTATO DO MOTORISTA', 'CONTATO', 'TELEFONE'],           '{}', true, false),
  ('DESCARGAS', 'cavalo',           array['CAVALO', 'PLACA', 'PLACA CAVALO'],                       '{}', true, false),
  ('DESCARGAS', 'carreta',          array['CARRETA', 'PLACA CARRETA'],                              '{}', true, false),
  ('DESCARGAS', 'vinculo',          array['VÍNCULO'],                                               '{}', true, false),
  ('DESCARGAS', 'status',           array['STATUS'],                                                '{}', true, false),
  ('DESCARGAS', 'bipagem',          array['BIPAGEM'],                                               '{}', true, false),
  ('DESCARGAS', 'cd_de_descarga',   array['CD DE DESCARGA'],                                        '{}', true, false),
  ('DESCARGAS', 'eta_destino',      array['ETA DESTINO'],                                           '{}', true, false),
  ('DESCARGAS', 'macro',            array['MACRO'],                                                 '{}', true, false),
  ('DESCARGAS', 'tempo_de_espera',  array['TEMPO DE ESPERA'],                                       '{}', true, false),
  -- FATURAMENTO
  ('FATURAMENTO', 'lh',              array['LH', 'LT'],                                             '{}', true, false),
  ('FATURAMENTO', 'motorista',       array['MOTORISTA'],                                            '{}', true, false),
  ('FATURAMENTO', 'cavalo',          array['CAVALO', 'PLACA', 'PLACA CAVALO'],                      '{}', true, false),
  ('FATURAMENTO', 'carreta',         array['CARRETA', 'PLACA CARRETA'],                             '{}', true, false),
  ('FATURAMENTO', 'vinculo',         array['VÍNCULO'],                                              '{}', true, false),
  ('FATURAMENTO', 'origem',          array['ORIGEM'],                                               '{}', true, false),
  ('FATURAMENTO', 'destino',         array['DESTINO'],                                              '{}', true, false),
  ('FATURAMENTO', 'valor',           array['VALOR', 'VALOR FRETE', 'FRETE'],                        '{}', true, false),
  ('FATURAMENTO', 'ciot_vpo',        array['CIOT / VPO', 'CIOT', 'VPO'],                            '{}', true, false),
  ('FATURAMENTO', 'valor_da_carga',  array['VALOR DA CARGA'],                                       '{}', true, false),
  -- LINKS / TREINAMENTOS (sem cabeçalho: o script usa a letra da coluna)
  ('LINKS / TREINAMENTOS', 'titulo',  array['B'], '{}', false, false),
  ('LINKS / TREINAMENTOS', 'link',    array['C'], '{}', false, true),
  ('LINKS / TREINAMENTOS', 'link_2',  array['D'], '{}', false, true),
  -- ENDEREÇOS
  ('ENDEREÇOS', 'nome',        array['NOME', 'LOCAL', 'UNIDADE', 'CD', 'HUB'],                      '{}', false, false),
  ('ENDEREÇOS', 'endereco',    array['ENDEREÇO', 'ENDEREÇO COMPLETO'],                              '{}', false, false),
  ('ENDEREÇOS', 'uf',          array['UF', 'ESTADO'],                                               '{}', false, false),
  ('ENDEREÇOS', 'cep',         array['CEP'],                                                        '{}', false, false),
  ('ENDEREÇOS', 'cnpj',        array['CNPJ'],                                                       '{}', true,  false),
  ('ENDEREÇOS', 'id_station',  array['ID STATION'],                                                 '{}', true,  false),
  ('ENDEREÇOS', 'sigla',       array['SIGLA'],                                                      '{}', true,  false),
  ('ENDEREÇOS', 'tipo',        array['TIPO'],                                                       '{}', true,  false)
) as m(aba, coluna, titulos, grupos, situacao, com_url)
on conflict (aba, coluna) do update
  set ordem = excluded.ordem, titulos = excluded.titulos, grupos = excluded.grupos,
      situacao = excluded.situacao, com_url = excluded.com_url;


-- -----------------------------------------------------------------------------
-- 2. Recria as views do contrato (drop + create, security_invoker = true)
-- -----------------------------------------------------------------------------
drop view if exists
  torre.v_matriz,
  torre.v_validacoes,
  torre.v_origem,
  torre.v_carregamentos,
  torre.v_transito,
  torre.v_descargas,
  torre.v_faturamento,
  torre.v_links,
  torre.v_enderecos;

do $$
declare
  v       record;
  v_cels  text;
  v_cols  text;
  v_etapa text;
begin
  for v in select * from (values
      ('v_matriz', 'MATRIZ'), ('v_validacoes', 'VALIDAÇÕES PRÉ CARREGAMENTO'), ('v_origem', 'ORIGEM'),
      ('v_carregamentos', 'CARREGAMENTOS'), ('v_transito', 'TRÂNSITO'), ('v_descargas', 'DESCARGAS'),
      ('v_faturamento', 'FATURAMENTO'), ('v_links', 'LINKS / TREINAMENTOS'), ('v_enderecos', 'ENDEREÇOS')) x(visao, aba)
  loop
    select string_agg(format('torre.celula(x.m, t.t -> %L) as %I', c.coluna, c.coluna), E',\n         ' order by c.ordem),
           string_agg(format('torre.valor(k.%I) as %I', c.coluna, c.coluna)
                      || case when c.com_url then format(E',\n       torre.url(k.%I) as %I', c.coluna, c.coluna || '_url') else '' end
                      || case when c.situacao then format(E',\n       torre.situacao(k.%I) as %I', c.coluna, c.coluna || '_situacao') else '' end,
                      E',\n       ' order by c.ordem)
      into v_cels, v_cols
      from torre.colunas c
     where c.aba = v.aba;
    if v_cels is null then
      raise exception 'torre.colunas não tem colunas para a aba %', v.aba;
    end if;

    v_etapa := '';
    if v.aba = 'MATRIZ' then
      select E'\n       case ' || string_agg(format('when coalesce(%s) is not null then %L', e.cols, e.etapa), ' ' order by e.prio)
             || E' end as etapa,'
        into v_etapa
        from (select p.prio, p.etapa,
                     string_agg(format('torre.valor(k.%I)', c.coluna), ', ' order by c.ordem) as cols
                from (values (1, 'descarga_', 'descarga'), (2, 'transito_', 'transito'),
                             (3, 'carregamento_', 'carregamento'), (4, 'origem_', 'origem')) p(prio, prefixo, etapa)
                join torre.colunas c on c.aba = 'MATRIZ' and c.coluna like p.prefixo || '%' and cardinality(c.grupos) > 0
               group by p.prio, p.etapa) e;
    end if;

    execute format($v$
create view torre.%I with (security_invoker = true) as
select l.linha as ordem,%s
       %s
from torre.planilha_linhas l
cross join (select torre.titulos(%L) as t offset 0) t
cross join lateral (select torre.mapa(l.celulas) as m offset 0) x
cross join lateral (select %s offset 0) k
where l.aba = %L$v$, v.visao, v_etapa, v_cols, v.aba, v_cels, v.aba);
  end loop;
end $$;


-- -----------------------------------------------------------------------------
-- 3. Acesso: RLS e grants iguais aos de hoje (só torre.eh_operador())
-- -----------------------------------------------------------------------------
alter table torre.planilha_abas   enable row level security;
alter table torre.planilha_linhas enable row level security;
alter table torre.sincronizacao   enable row level security;
alter table torre.colunas         enable row level security;

drop policy if exists torre_operador_le on torre.planilha_abas;
drop policy if exists torre_operador_le on torre.planilha_linhas;
drop policy if exists torre_operador_le on torre.sincronizacao;
drop policy if exists torre_operador_le on torre.colunas;
create policy torre_operador_le on torre.planilha_abas   for select to authenticated using (torre.eh_operador());
create policy torre_operador_le on torre.planilha_linhas for select to authenticated using (torre.eh_operador());
create policy torre_operador_le on torre.sincronizacao   for select to authenticated using (torre.eh_operador());
create policy torre_operador_le on torre.colunas         for select to authenticated using (torre.eh_operador());

revoke all on all tables in schema torre from public, anon, authenticated, service_role;
revoke all on all sequences in schema torre from public, anon, authenticated, service_role;
grant select on all tables in schema torre to authenticated;

alter default privileges in schema torre revoke all on tables from public, anon, authenticated, service_role;
alter default privileges in schema torre revoke all on sequences from public, anon, authenticated, service_role;
alter default privileges in schema torre revoke execute on functions from public, anon, authenticated, service_role;


commit;


-- =============================================================================
-- 4. Conferências (depois do commit; rode cada bloco separadamente)
--    O resultado aparece como erro "RESULTADO ..." e tudo é desfeito (rollback).
-- =============================================================================

-- 4.1 Consulta de títulos do CONTRATO_DADOS.md volta vazia fora U/L (esperado: divergencias_fora_u_l=0 (vazia) | views_invoker=11 de 11)
begin;
do $$
declare
  v_div text;
  v_qtd int;
  v_inv int;
  v_tot int;
begin
  with cab as (
    select a.aba, torre.chave(e ->> 'g') || '|' || torre.chave(e ->> 'c') as k,
           coalesce((e ->> 'g') || ' / ', '') || (e ->> 'c') as titulo
      from torre.planilha_abas a, jsonb_array_elements(a.cabecalho) e
  ), usados as (
    select c.aba, c.coluna, k.k
      from torre.colunas c, jsonb_array_elements_text(torre.titulos(c.aba) -> c.coluna) k(k)
  ), dif as (
    select 'título da planilha sem coluna' as tipo, cab.aba, cab.titulo as item
      from cab
     where length(torre.chave(cab.titulo)) > 1
       and not exists (select 1 from usados u where u.aba = cab.aba and u.k = cab.k)
    union all
    select 'coluna sem título na planilha', c.aba, c.coluna
      from torre.colunas c
     where exists (select 1 from torre.planilha_abas a where a.aba = c.aba)
       and not exists (select 1 from usados u join cab on cab.aba = u.aba and cab.k = u.k
                        where u.aba = c.aba and u.coluna = c.coluna)
  )
  select count(*), coalesce(string_agg(tipo || ':' || aba || ':' || item, ', ' order by tipo, aba, item), 'vazia')
    into v_qtd, v_div
    from dif;

  select count(*) filter (where 'security_invoker=true' = any(c.reloptions)), count(*)
    into v_inv, v_tot
    from pg_class c
   where c.relnamespace = 'torre'::regnamespace and c.relkind = 'v';

  raise exception 'RESULTADO (nada foi salvo): divergencias_fora_u_l=% (%) | views_invoker=% de %',
    v_qtd, v_div, v_inv, v_tot;
end $$;
rollback;

-- 4.2 Anon lê 0 linhas / bloqueado em tudo (esperado: leu=nada | bloqueados=13 de 13 | rpc=bloqueada)
begin;
insert into torre.planilha_linhas (aba, linha, celulas)
values ('TRÂNSITO', 999999, '[{"c": "LH", "v": "LT0TESTE"}, {"c": "STATUS", "v": "ATRASADO", "bg": "#f4cccc"}]');
set local role anon;
do $$
declare
  o text;
  v_n bigint;
  v_leu text := '';
  v_bloq int := 0;
  v_rpc text := 'LIBERADA';
begin
  foreach o in array array['v_matriz', 'v_validacoes', 'v_origem', 'v_carregamentos', 'v_transito', 'v_descargas',
                           'v_faturamento', 'v_links', 'v_enderecos', 'v_matriz_contadores', 'v_status',
                           'planilha_linhas', 'planilha_abas'] loop
    begin
      execute format('select count(*) from torre.%I', o) into v_n;
      v_leu := v_leu || o || '=' || v_n || ' ';
    exception when insufficient_privilege then
      v_bloq := v_bloq + 1;
    end;
  end loop;
  begin
    perform torre.aplicar_planilha('{"abas": []}'::jsonb);
  exception when insufficient_privilege then
    v_rpc := 'bloqueada';
  end;
  raise exception 'RESULTADO (nada foi salvo): leu=% | bloqueados=% de 13 | rpc=%', coalesce(nullif(btrim(v_leu), ''), 'nada'), v_bloq, v_rpc;
end $$;
rollback;

-- 4.3 Motorista lê 0 linhas (esperado: linhas_vistas=0 | rpc=bloqueada | eh_operador=f)
begin;
insert into torre.planilha_linhas (aba, linha, celulas)
values ('TRÂNSITO', 999999, '[{"c": "LH", "v": "LT0TESTE"}, {"c": "STATUS", "v": "ATRASADO", "bg": "#f4cccc"}]');
select set_config('request.jwt.claims',
         json_build_object('sub', coalesce((select id from public.perfis where role = 'motorista' order by id limit 1), gen_random_uuid()),
                           'role', 'authenticated')::text, true);
set local role authenticated;
do $$
declare
  o text;
  v_n bigint;
  v_total bigint := 0;
  v_rpc text := 'LIBERADA';
begin
  foreach o in array array['v_matriz', 'v_validacoes', 'v_origem', 'v_carregamentos', 'v_transito', 'v_descargas',
                           'v_faturamento', 'v_links', 'v_enderecos', 'v_matriz_contadores', 'v_status',
                           'planilha_linhas', 'planilha_abas', 'sincronizacao', 'colunas'] loop
    execute format('select count(*) from torre.%I', o) into v_n;
    v_total := v_total + v_n;
  end loop;
  begin
    perform torre.aplicar_planilha('{"abas": []}'::jsonb);
  exception when insufficient_privilege then
    v_rpc := 'bloqueada';
  end;
  raise exception 'RESULTADO (nada foi salvo): linhas_vistas=% | rpc=% | eh_operador=%', v_total, v_rpc, torre.eh_operador();
end $$;
rollback;

-- 4.4 Admin lê as views recriadas, sinônimos e colunas novas (esperado: val_origem=SP-CD | val_status=OK | val_status_situacao=ok | orig_chega_a_tempo=SIM | orig_km_faltante=42 | mat_rota=SP-RJ | mat_delta_tt=00:15 | tran_dif_cpt=00:10 | end_sigla=SPSP1 | end_sigla_situacao=info)
begin;
insert into torre.planilha_linhas (aba, linha, celulas) values
  ('VALIDAÇÕES PRÉ CARREGAMENTO', 999999, '[{"c": "LH", "v": "LT0TESTE"}, {"c": "0RIGEM", "v": "SP-CD"}, {"c": "STATUS ATUAL", "v": "OK", "bg": "#d9ead3"}, {"c": "TIMER", "v": "00:12"}]'),
  ('ORIGEM', 999999, '[{"c": "LH", "v": "LT0TESTE"}, {"c": "Chega a tempo?", "v": "SIM"}, {"c": "KM FALTANTE", "v": "42"}]'),
  ('MATRIZ', 999999, '[{"c": "LH", "v": "LT0TESTE"}, {"c": "ROTA", "v": "SP-RJ"}, {"g": "TRÂNSITO", "c": "DELTA TT", "v": "00:15"}]'),
  ('TRÂNSITO', 999999, '[{"c": "LH", "v": "LT0TESTE"}, {"c": "DIFERENÇA DO CPT", "v": "00:10"}]'),
  ('ENDEREÇOS', 999999, '[{"c": "SIGLA", "v": "SPSP1", "bg": "#cfe2f3"}]');
select set_config('request.jwt.claims',
         json_build_object('sub', gen_random_uuid(), 'role', 'authenticated',
                           'app_metadata', json_build_object('role', 'admin'))::text, true);
set local role authenticated;
do $$
declare
  v record;
  o record;
  m record;
  t record;
  e record;
begin
  select * into v from torre.v_validacoes where ordem = 999999;
  select * into o from torre.v_origem where ordem = 999999;
  select * into m from torre.v_matriz where ordem = 999999;
  select * into t from torre.v_transito where ordem = 999999;
  select * into e from torre.v_enderecos where ordem = 999999;
  raise exception 'RESULTADO (nada foi salvo): val_origem=% | val_status=% | val_status_situacao=% | orig_chega_a_tempo=% | orig_km_faltante=% | mat_rota=% | mat_delta_tt=% | tran_dif_cpt=% | end_sigla=% | end_sigla_situacao=%',
    v.origem, v.status, v.status_situacao, o.chega_a_tempo, o.km_faltante, m.rota, m.transito_delta_tt, t.diferenca_do_cpt, e.sigla, e.sigla_situacao;
end $$;
rollback;

-- 4.5 Retrato md5 do public antes e depois (mostra o valor antes e depois e confirma que são iguais)
begin;
do $$
declare
  v_depois text;
  v_antes  text;
begin
  select md5(string_agg(x, E'\n' order by x)) || ' (' || count(*) || ' itens)'
    into v_depois
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
        from pg_default_acl d where d.defaclnamespace not in (select oid from pg_namespace where nspname = 'torre')
    ) s;
  v_antes := coalesce(nullif(current_setting('torre.retrato_public_antes', true), ''), v_depois);
  raise exception 'RESULTADO (nada foi salvo): retrato_antes=% | retrato_depois=% | igual=%',
    v_antes, v_depois, (v_antes = v_depois);
end $$;
rollback;
