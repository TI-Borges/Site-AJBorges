-- =============================================================================
-- PASSO 21b - Apaga a RPC antiga dos avisos de atualização
-- AJBorges Transporte & Logística
--
-- Rodar SÓ DEPOIS do push do site que usa a RPC nova
-- public.avisos_atualizacao_ativos(p_local text) (passo 21).
-- Ordem do deploy: passo 21 -> push do site -> este passo 21b.
--
-- Apaga a versão sem parâmetro public.avisos_atualizacao_ativos(), que o site
-- antigo usava. A versão nova (com p_local), a tabela e as permissões não mudam.
--
-- Rodar no SQL Editor do Supabase até o "commit;". Pode ser reexecutado.
-- A conferência fica depois do commit.
-- =============================================================================

begin;

drop function if exists public.avisos_atualizacao_ativos();

commit;


-- =============================================================================
-- Conferência (depois do commit)
-- =============================================================================

-- 1. Só a RPC nova ficou (esperado: versoes=avisos_atualizacao_ativos(p_local text) | nova_anon=t | nova_authenticated=t)
do $$
begin
  raise exception 'RESULTADO: versoes=% | nova_anon=% | nova_authenticated=%',
    (select string_agg(p.proname || '(' || pg_get_function_arguments(p.oid) || ')', ', ')
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'avisos_atualizacao_ativos'),
    has_function_privilege('anon', 'public.avisos_atualizacao_ativos(text)', 'execute'),
    has_function_privilege('authenticated', 'public.avisos_atualizacao_ativos(text)', 'execute');
end $$;
