-- TORRE T01c - Contadores do topo da MATRIZ
-- Na planilha, os 6 contadores estão numa célula só:
--   "ROTAS ATIVAS 96 Pendentes Chegada 27 Carregamentos 15 Trânsito 47 Atrasos 2 Descarga 8"
-- A torre.contador só achava rótulo e número em células separadas. Agora, se não achar
-- assim, procura "rótulo + número" dentro do texto da célula.
-- Mexe só nesta função (schema torre). As permissões dela continuam as mesmas.
-- Rode do begin até o commit. Depois rode a conferência no fim.

begin;

create or replace function torre.contador(p_topo jsonb, p_rotulos text[])
returns int language plpgsql immutable set search_path = '' as $$
declare
  v_alvos text[];
  v_alvo text;
  r int;
  c int;
  v_txt text;
  v_num text;
begin
  if jsonb_typeof(p_topo) is distinct from 'array' then
    return null;
  end if;
  select array_agg(torre.chave(x)) into v_alvos from unnest(p_rotulos) x;

  -- 1) rótulo numa célula e número nela, embaixo ou ao lado (como antes)
  for r in 0 .. jsonb_array_length(p_topo) - 1 loop
    continue when jsonb_typeof(p_topo -> r) is distinct from 'array';
    for c in 0 .. jsonb_array_length(p_topo -> r) - 1 loop
      v_txt := p_topo -> r ->> c;
      if torre.chave(regexp_replace(coalesce(v_txt, ''), '[0-9]', '', 'g')) = any(v_alvos) then
        return coalesce(torre.numero(v_txt), torre.numero(p_topo -> (r + 1) ->> c), torre.numero(p_topo -> r ->> (c + 1)));
      end if;
    end loop;
  end loop;

  -- 2) vários contadores na mesma célula: "ROTAS ATIVAS 96 Pendentes Chegada 27 ..."
  for r in 0 .. jsonb_array_length(p_topo) - 1 loop
    continue when jsonb_typeof(p_topo -> r) is distinct from 'array';
    for c in 0 .. jsonb_array_length(p_topo -> r) - 1 loop
      v_txt := torre.chave(p_topo -> r ->> c);
      foreach v_alvo in array v_alvos loop
        v_num := substring(v_txt from v_alvo || '([0-9]+)');
        if v_num is not null then
          return v_num::int;
        end if;
      end loop;
    end loop;
  end loop;

  return null;
end $$;

commit;


-- Conferência (só leitura). Compare com o topo da MATRIZ na planilha agora.
-- Esperado: os 6 números iguais aos da planilha (ex.: 96 | 27 | 15 | 47 | 2 | 8)
select rotas_ativas, pendentes_chegada, carregamentos, transito, atrasos, descarga, atualizado_em
  from torre.v_matriz_contadores;
