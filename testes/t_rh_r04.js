// Roda supabase/sql/rh/R04_limpeza_testes.sql num Postgres em WASM (PGlite), em cima do R01 + R01b +
// R03, com o schema auth e o storage simulados (testes/rh_storage_simulado.js).
// Dados: 2 colaboradores de verdade (um com nome parecido) e 3 de teste (2 homônimos), com processos,
// etapas, observações, anexos (e arquivo sem registro), exames, férias, contrato PJ e auditoria.
// Confere: lista não preenchida, nome errado e modo inválido dão erro sem mudar nada; a PRÉVIA mostra
// as contagens certas e não muda nada; o modo apagar se recusa enquanto houver arquivo no bucket;
// depois de apagar as pastas ("painel"), apaga só os de teste, conferência OK, retratos iguais aos da
// PRÉVIA, 22 triggers de bloqueio ligados; delete/truncate continuam barrados; rodar de novo não apaga.
// O que NÃO dá para testar aqui: o painel do Storage e se o SQL Editor guarda as tabelas temporárias.
// Uso: node testes/t_rh_r04.js
const fs = require('fs');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');
const { AUTH_SIMULADO, storageSimulado } = require('./rh_storage_simulado');

const RAIZ = process.env.RAIZ || path.resolve(__dirname, '..');

const ler = (arq) => fs.readFileSync(path.join(RAIZ, 'supabase/sql/rh', arq), 'utf8');
const principal = (sql) => sql.slice(sql.indexOf('\nbegin;\n'), sql.indexOf('\ncommit;\n') + '\ncommit;\n'.length);
const R04 = ler('R04_limpeza_testes.sql');

let falhas = 0;
const ok = (c, m) => { console.log(`${c ? 'OK   ' : 'FALHA'} ${m}`); if (!c) falhas++; };

function r04(nomes, modo) {
  const lista = nomes.map(n => `  ('${n.replace(/'/g, "''")}')`).join(',\n');
  let s = R04;
  if (nomes) s = s.replace("  ('COLOQUE AQUI O NOME 1'),\n  ('COLOQUE AQUI O NOME 2');", lista + ';');
  if (modo) s = s.replace("set_config('r04.modo', 'previa', true)", `set_config('r04.modo', '${modo}', true)`);
  return s;
}

(async () => {
  const db = new PGlite();
  await db.exec(AUTH_SIMULADO + storageSimulado() + `
    create table public.perfis (id uuid primary key, nome text, role text);
    grant usage on schema public to anon, authenticated;
    grant select on public.perfis to authenticated;`);
  await db.exec(principal(ler('R01_estrutura.sql')));
  await db.exec(principal(ler('R01b_admin.sql')));
  await db.exec(principal(ler('R03_anexos.sql')));

  // Dados: 2 de verdade (um homônimo parcial "Ana Souza") e 2 de teste com tudo
  await db.exec(`
    select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","email":"rh@x","app_metadata":{"role":"rh"}}', false);
    create function pg_temp.pessoa(p_nome text, p_vinc text) returns void language plpgsql as $$
    declare c uuid; p uuid; e uuid; cam text;
    begin
      insert into rh.colaboradores (nome, vinculo) values (p_nome, p_vinc) returning id into c;
      update rh.colaboradores set cargo = 'Analista' where id = c;          -- gera auditoria
      insert into rh.processos (colaborador_id, modelo_id, modelo_nome)
        select c, id, nome from rh.modelos where chave = 'rescisao_clt' returning id into p;
      insert into rh.etapas (processo_id, ordem, nome, anexos) values (p, 1, 'Assinaturas', array['antigo.pdf']) returning id into e;
      update rh.etapas set concluida = true where id = e;                    -- gera auditoria
      insert into rh.etapas (processo_id, ordem, nome) values (p, 2, 'Pagamento');
      insert into rh.observacoes (etapa_id, texto) values (e, 'obs de ' || p_nome);
      cam := p || '/' || e || '/' || gen_random_uuid() || '.pdf';
      insert into storage.objects (bucket_id, name, metadata) values ('rh-anexos', cam, '{"size":10,"mimetype":"application/pdf"}');
      insert into rh.anexos (etapa_id, caminho, nome_original, tipo, tamanho) values (e, cam, 'a.pdf', 'application/pdf', 10);
      -- arquivo enviado sem registro em rh.anexos (upload ok, insert falhou)
      insert into storage.objects (bucket_id, name, metadata)
        values ('rh-anexos', p || '/' || e || '/' || gen_random_uuid() || '.png', '{"size":5,"mimetype":"image/png"}');
      insert into rh.exames (colaborador_id, tipo, data_realizacao) values (c, 'periodico', '2026-01-10');
      insert into rh.ferias (colaborador_id, aquisitivo_inicio, saldo_dias) values (c, '2025-01-01', 30);
      if p_vinc = 'PJ' then
        insert into rh.contratos_pj (colaborador_id, inicio, fim, valor, aviso_dias) values (c, '2026-01-01', '2026-12-31', 1000, 30);
      end if;
    end $$;
    select pg_temp.pessoa('Ana Souza', 'CLT');
    select pg_temp.pessoa('Carlos Real', 'PJ');
    select pg_temp.pessoa('Teste Ana', 'CLT');
    select pg_temp.pessoa('Teste Bruno PJ', 'PJ');
    select pg_temp.pessoa('Teste Bruno PJ', 'CLT');   -- mesmo nome 2x
    insert into storage.objects (bucket_id, name, metadata) values ('comprovantes', 'm1/recibo.jpg', '{}');
    select set_config('request.jwt.claims', '', false);
  `);

  const foto = async () => JSON.stringify((await db.query(`select
      (select json_agg(t order by t.id) from rh.colaboradores t) c, (select json_agg(t order by t.id) from rh.processos t) p,
      (select json_agg(t order by t.id) from rh.etapas t) e, (select json_agg(t order by t.id) from rh.observacoes t) o,
      (select json_agg(t order by t.id) from rh.anexos t) a, (select json_agg(t order by t.id) from rh.exames t) x,
      (select json_agg(t order by t.id) from rh.ferias t) f, (select json_agg(t order by t.id) from rh.contratos_pj t) pj,
      (select json_agg(t order by t.id) from rh.auditoria t) au, (select json_agg(t order by t.id) from rh.modelos t) m,
      (select json_agg(t order by t.id) from rh.modelo_etapas t) me,
      (select json_agg(t order by t.name) from storage.objects t) so,
      (select string_agg(c.relname||'.'||t.tgname||':'||t.tgenabled::text, ',' order by 1) from pg_trigger t join pg_class c on c.oid=t.tgrelid
        where c.relnamespace='rh'::regnamespace and not t.tgisinternal) trg`)).rows[0]);
  const erro = async (sql) => {
    try { const r = await db.exec(sql); return { linhas: r }; }
    catch (e) { await db.exec('rollback').catch(() => {}); return { erro: e.message }; }
  };
  const contar = async () => (await db.query(`select
      (select count(*)::int from rh.colaboradores) c, (select count(*)::int from rh.processos) p,
      (select count(*)::int from rh.etapas) e, (select count(*)::int from rh.observacoes) o,
      (select count(*)::int from rh.anexos) a, (select count(*)::int from rh.exames) x,
      (select count(*)::int from rh.ferias) f, (select count(*)::int from rh.contratos_pj) pj,
      (select count(*)::int from rh.auditoria) au,
      (select count(*)::int from storage.objects where bucket_id='rh-anexos') so`)).rows[0];
  console.log('Contagens iniciais:', JSON.stringify(await contar()));

  const inicial = await foto();
  const NOMES = ['  teste   ANA ', 'Teste Bruno PJ'];

  // A. Lista não preenchida
  let r = await erro(R04);
  console.log('\nA.', r.erro);
  ok(/nome\(s\) da lista sem nenhum colaborador: COLOQUE AQUI/.test(r.erro || ''), 'A. lista não preenchida dá erro');
  ok(await foto() === inicial, 'A. nada mudou');

  // B. Prévia
  r = await erro(r04(NOMES));
  console.log('\nB.', r.erro);
  ok(/^PRÉVIA \(nada foi apagado\)/.test(r.erro || ''), 'B. prévia sai como PRÉVIA');
  ok((r.erro || '').includes('vai_sair: colaboradores=3 processos=3 etapas=6 observacoes=3 anexos=3 exames=3 ferias=3 contratos_pj=1 auditoria=6 arquivos_no_bucket=6'),
     'B. contagens por tabela certas');
  ok(/Teste Bruno PJ: Teste Bruno PJ \(PJ, .*\); Teste Bruno PJ \(CLT/.test(r.erro || ''), 'B. mostra os 2 homônimos de teste');
  const previaRetrato = (r.erro || '').match(/retrato_public=(.*?) \| retrato_rh=(.*?) \| outros_rh=(.*)$/);
  ok(await foto() === inicial, 'B. nada mudou (dados, arquivos e triggers)');

  // C. Apagar com arquivos ainda no bucket
  r = await erro(r04(NOMES, 'apagar'));
  console.log('\nC.', r.erro);
  ok(/ainda há 6 arquivo\(s\).*as pastas: /.test(r.erro || ''), 'C. recusa enquanto houver arquivo no bucket');
  ok(await foto() === inicial, 'C. nada mudou');

  // D. Modo inválido e nome errado
  r = await erro(r04(NOMES, 'sim'));
  ok(/o modo tem que ser/.test(r.erro || ''), 'D. modo inválido dá erro');
  r = await erro(r04([...NOMES, 'Teste Inexistente']));
  ok(/sem nenhum colaborador: Teste Inexistente/.test(r.erro || ''), 'D. nome que não acha ninguém dá erro');
  ok(await foto() === inicial, 'D. nada mudou');

  // E. "Painel": apaga as pastas listadas (como a service_role pelo Storage)
  const pastas = (await db.query(`select distinct split_part(o.name,'/',1) p from storage.objects o
     join rh.processos pr on pr.id::text = split_part(o.name,'/',1) join rh.colaboradores c on c.id = pr.colaborador_id
     where o.bucket_id='rh-anexos' and c.nome like 'Teste %'`)).rows.map(x => x.p);
  ok(pastas.length === 3, 'E. 3 pastas de teste no bucket');
  await db.query(`delete from storage.objects where bucket_id='rh-anexos' and split_part(name,'/',1) = any($1)`, [pastas]);

  const reais = async () => JSON.stringify((await db.query(`select
      (select json_agg(t order by t.id) from rh.colaboradores t where nome not like 'Teste %') c,
      (select json_agg(t order by t.id) from rh.processos t join rh.colaboradores c on c.id=t.colaborador_id and c.nome not like 'Teste %') p,
      (select count(*) from storage.objects where bucket_id='comprovantes') comp,
      (select json_agg(t order by t.id) from rh.modelos t) m`)).rows[0]);
  const reaisAntes = await reais();

  // F. Apagar de verdade
  r = await erro(r04(NOMES, 'apagar'));
  ok(!r.erro, `F. modo apagar roda sem erro ${r.erro || ''}`);
  const linha = r.linhas && r.linhas[r.linhas.length - 1].rows[0];
  console.log('\nF. conferência depois:'); for (const [k, v] of Object.entries(linha || {})) console.log(`   ${k}: ${v}`);
  ok(linha && linha.conferencia === 'OK', 'F. conferencia = OK');
  ok(linha && linha.restam_desses_nomes === 'colaboradores=0 processos=0 etapas=0 observacoes=0 anexos=0 exames=0 ferias=0 contratos_pj=0 auditoria=0 arquivos_no_bucket=0',
     'F. restam 0 em todas as tabelas');
  ok(linha && linha.triggers_bloqueio === 'O=22', 'F. 22 triggers de bloqueio ligados (O)');
  ok(linha && previaRetrato && linha.retrato_public_depois === previaRetrato[1] && linha.retrato_rh_depois === previaRetrato[2]
     && linha.outros_rh_depois === previaRetrato[3],
     'F. retratos depois = os da PRÉVIA');
  const cont = await contar();
  console.log('   contagens depois:', JSON.stringify(cont));
  ok(JSON.stringify(cont) === JSON.stringify({ c: 2, p: 2, e: 4, o: 2, a: 2, x: 2, f: 2, pj: 1, au: 4, so: 4 }), 'F. ficaram só os 2 de verdade');
  ok(await reais() === reaisAntes, 'F. registros de verdade, modelos e comprovantes intactos');

  // G. Bloqueio de delete/truncate continua valendo
  r = await erro(`delete from rh.colaboradores`);
  ok(/não é permitido/.test(r.erro || ''), 'G. delete em rh.colaboradores continua barrado');
  r = await erro(`truncate rh.auditoria`);
  ok(/não é permitido/.test(r.erro || ''), 'G. truncate em rh.auditoria continua barrado');
  r = await erro(`delete from rh.anexos`);
  ok(/não é permitido/.test(r.erro || ''), 'G. delete em rh.anexos continua barrado');

  // H. Rodar de novo não apaga nada
  const depois = await foto();
  r = await erro(r04(NOMES, 'apagar'));
  ok(/sem nenhum colaborador/.test(r.erro || ''), 'H. rodar de novo dá erro de nome');
  ok(await foto() === depois, 'H. nada mudou');

  await db.close();
  console.log(falhas ? `\n${falhas} FALHA(S)` : '\nTUDO OK');
  process.exit(falhas ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
