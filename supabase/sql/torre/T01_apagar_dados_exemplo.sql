-- =============================================================================
-- TORRE T01 - Apaga os dados de EXEMPLO (T01_dados_exemplo.sql)
-- AJBorges Transporte & Logística
--
-- Apaga só as abas marcadas com extras.exemplo = true e a linha
-- 'DADOS DE EXEMPLO' de torre.sincronizacao. Dados reais da planilha não são
-- tocados. Pode rodar de novo (sem exemplo, não faz nada).
-- Rodar inteiro no SQL Editor.
-- =============================================================================

begin;

delete from torre.planilha_linhas
 where aba in (select aba from torre.planilha_abas where extras ->> 'exemplo' = 'true');
delete from torre.planilha_abas where extras ->> 'exemplo' = 'true';
delete from torre.sincronizacao where erro = 'DADOS DE EXEMPLO';

commit;

-- Resumo (esperado: nenhuma aba com exemplo = true)
select aba, linhas, coalesce(extras ->> 'exemplo', 'não') as exemplo from torre.planilha_abas order by aba;
