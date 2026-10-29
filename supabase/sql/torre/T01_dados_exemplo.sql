-- =============================================================================
-- TORRE T01 - Dados de EXEMPLO (inventados) para montar as telas antes de ligar a planilha
-- AJBorges Transporte & Logística
--
-- Grava as 9 abas com dados fictícios ("Motorista Exemplo 01", placas EXE…,
-- telefone (00) 00000-0000, links exemplo.invalid) e cores variadas, usando os
-- títulos de torre.colunas (os mesmos que as views procuram).
--   - Recusa rodar se já houver dados reais da planilha (nada é gravado).
--   - As abas ficam marcadas com extras.exemplo = true. A primeira cópia real
--     da planilha substitui cada aba de exemplo sem a trava dos 50%.
--   - v_status mostra ultimo_erro = 'DADOS DE EXEMPLO'.
--   - Pode rodar de novo (recomeça o exemplo). Para tirar:
--     T01_apagar_dados_exemplo.sql.
--
-- Pré-requisito: T01_copia_planilha.sql. Rodar inteiro no SQL Editor.
-- =============================================================================

begin;

do $$
begin
  if exists (select 1 from torre.planilha_abas where coalesce(extras ->> 'exemplo', '') <> 'true')
     or exists (select 1 from torre.planilha_linhas l
                 where not exists (select 1 from torre.planilha_abas a
                                    where a.aba = l.aba and a.extras ->> 'exemplo' = 'true')) then
    raise exception 'Já há dados reais da planilha na Torre: os dados de exemplo NÃO foram gravados.';
  end if;
end $$;

-- Recomeça o exemplo (só o que é exemplo)
delete from torre.planilha_linhas
 where aba in (select aba from torre.planilha_abas where extras ->> 'exemplo' = 'true');
delete from torre.planilha_abas where extras ->> 'exemplo' = 'true';
delete from torre.sincronizacao where erro = 'DADOS DE EXEMPLO';

do $$
declare
  -- uma cor de cada família (CORES.md) + uma sem cor
  c_paleta constant jsonb := '[{"v": "ATRASADO", "bg": "#f4cccc"}, {"v": "NO PRAZO", "bg": "#d9ead3"},
    {"v": "FORA DO CD", "bg": "#fff2cc"}, {"v": "Em trânsito", "bg": "#fce5cd"}, {"v": "Descarregando", "bg": "#cfe2f3"},
    {"v": "PRIORIDADE", "bg": "#000000", "fg": "#ffffff"}, {"v": "Aguardando"}]';
  v_agora timestamp := now() at time zone 'America/Sao_Paulo';
  a       record;
  c       record;
  i       int;
  v_base  text;
  v_etapa text;
  v_valor text;
  v_cor   jsonb;
  v_cel   jsonb;
  v_cels  jsonb;
  v_extra jsonb;
  v_etapas text[] := '{}';
  v_total int := 0;
begin
  for a in select * from (values
      ('MATRIZ', 7, 16), ('VALIDAÇÕES PRÉ CARREGAMENTO', 4, 8), ('ORIGEM', 2, 8), ('CARREGAMENTOS', 2, 6),
      ('TRÂNSITO', 2, 12), ('DESCARGAS', 2, 6), ('FATURAMENTO', 2, 8), ('LINKS / TREINAMENTOS', 2, 6),
      ('ENDEREÇOS', 2, 5)) x(aba, primeira, n)
  loop
    for i in 1 .. a.n loop
      v_cels := '[]';
      v_etapa := (array['origem', 'carregamento', 'transito', 'descarga'])[1 + i % 4];
      if a.aba = 'MATRIZ' then
        v_etapas := v_etapas || v_etapa;
      end if;
      for c in select * from torre.colunas where aba = a.aba order by ordem loop
        -- MATRIZ: cada linha só tem o bloco da sua etapa preenchido
        continue when a.aba = 'MATRIZ' and cardinality(c.grupos) > 0 and c.coluna not like v_etapa || '\_%';
        v_base := case when cardinality(c.grupos) > 0
                       then regexp_replace(c.coluna, '^(origem|carregamento|transito|descarga)_', '') else c.coluna end;
        v_valor := case
          when v_base = 'lh'        then 'LT0EXEMPLO' || lpad(i::text, 3, '0')
          when v_base = 'motorista' then 'Motorista Exemplo ' || lpad(i::text, 2, '0')
          when v_base = 'contato'   then '(00) 00000-0000'
          when v_base = 'cavalo'    then 'EXE' || (i % 10) || 'A' || lpad((i % 100)::text, 2, '0')
          when v_base = 'carreta'   then 'CRT' || (i % 10) || 'B' || lpad((i % 100)::text, 2, '0')
          when v_base = 'vinculo'   then (array['FROTA', 'AGREGADO', 'TERCEIRO'])[1 + i % 3]
          when v_base = 'origem'    then 'CD Exemplo Origem ' || (1 + i % 3)
          when v_base = 'destino'   then 'CD Exemplo Destino ' || (1 + i % 4)
          when v_base = 'carga'     then 'Carga Exemplo ' || i
          when v_base in ('posicao_atual', 'localizacao') then 'Rodovia Exemplo, km ' || (i * 37)
          when v_base in ('km', 'km_h', 'kh') then (i * 13)::text
          when v_base in ('timer', 't_parada', 'total_parada', 'parada', 'tt_restante', 't_chegada')
            then lpad((i % 5)::text, 2, '0') || ':' || lpad(((i * 7) % 60)::text, 2, '0')
          when v_base in ('pct', 'progressao_viagem') then ((i * 9) % 100) || '%'
          when v_base in ('valor', 'faturamento') then 'R$ ' || (1 + i / 3) || '.' || lpad(((i * 137) % 1000)::text, 3, '0') || ',00'
          when v_base = 'macro'     then 'Macro Exemplo ' || (1 + i % 5)
          when v_base = 'sm'        then 'SM' || lpad((1000 + i)::text, 6, '0')
          when v_base = 'cte'       then 'CTE ' || (5000 + i)
          when v_base = 'observacao' then case when i % 3 = 0 then 'Observação de exemplo' end
          when v_base = 'titulo'    then 'Treinamento Exemplo ' || lpad(i::text, 2, '0')
          when v_base = 'link'      then 'Abrir'
          when v_base = 'link_2'    then case when i % 2 = 1 then 'Material extra' end
          when v_base = 'nome'      then 'CD Exemplo ' || lpad(i::text, 2, '0')
          when v_base = 'endereco'  then 'Rua Exemplo, ' || (i * 100)
          when v_base = 'cidade'    then 'Cidade Exemplo'
          when v_base = 'uf'        then 'SP'
          when v_base = 'cep'       then '00000-000'
          when v_base = 'horario'   then '08:00 às 18:00'
          when v_base = 'mapa'      then 'Ver no mapa'
          else to_char(v_agora + make_interval(hours => i + c.ordem % 5), 'DD/MM/YYYY HH24:MI')
        end;
        continue when v_valor is null;
        v_cor := '{}';
        if c.situacao and v_base ~ '^(status|timer|cpt|cpt_origem|cpt_realizado|eta|eta_destino|checklist|gr|ciot_vpo|faturamento|parada|t_parada|total_parada|progressao_viagem|rastreador)$' then
          v_cor := c_paleta -> ((i + c.ordem) % 7);
          if v_base ~ '^(status|checklist|gr|ciot_vpo|rastreador)$' then
            v_valor := v_cor ->> 'v';
          end if;
          v_cor := v_cor - 'v';
        end if;
        v_cel := jsonb_build_object('c', c.titulos[1], 'v', v_valor) || v_cor;
        if cardinality(c.grupos) > 0 then
          v_cel := v_cel || jsonb_build_object('g', c.grupos[1]);
        end if;
        if c.com_url then
          v_cel := v_cel || jsonb_build_object('url', 'https://exemplo.invalid/' || c.coluna || '/' || i);
        end if;
        v_cels := v_cels || jsonb_build_array(v_cel);
      end loop;
      insert into torre.planilha_linhas (aba, linha, celulas) values (a.aba, a.primeira + i - 1, v_cels);
    end loop;

    v_extra := jsonb_build_object('exemplo', true);
    if a.aba in ('MATRIZ', 'VALIDAÇÕES PRÉ CARREGAMENTO') then
      v_extra := v_extra || jsonb_build_object('ultima_atualizacao', to_char(v_agora, 'DD/MM/YYYY HH24:MI:SS'));
    end if;
    if a.aba = 'MATRIZ' then
      v_extra := v_extra || jsonb_build_object('topo', jsonb_build_array(
        jsonb_build_array('ROTAS ATIVAS', 'Pendentes Chegada', 'Carregamentos', 'Trânsito', 'Atrasos', 'Descarga'),
        jsonb_build_array(a.n::text,
          (select count(*) from unnest(v_etapas) e where e = 'origem')::text,
          (select count(*) from unnest(v_etapas) e where e = 'carregamento')::text,
          (select count(*) from unnest(v_etapas) e where e = 'transito')::text,
          '3',
          (select count(*) from unnest(v_etapas) e where e = 'descarga')::text)));
    end if;
    insert into torre.planilha_abas (aba, cabecalho, extras, copiado_em, linhas)
    select a.aba,
           coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('c', c2.titulos[1], 'g', c2.grupos[1])) order by c2.ordem), '[]'::jsonb),
           v_extra, now(), a.n
      from torre.colunas c2 where c2.aba = a.aba;
    v_total := v_total + a.n;
  end loop;

  insert into torre.sincronizacao (iniciado_em, terminado_em, abas, linhas, erro)
  values (now(), now(), 9, v_total, 'DADOS DE EXEMPLO');
end $$;

commit;

-- Resumo (o que ficou gravado)
select aba, linhas, extras ->> 'exemplo' as exemplo from torre.planilha_abas order by aba;
