// Roda supabase/sql/rh/R05_lixeira.sql num Postgres em WASM (PGlite), em cima do R01 + R01b + R03,
// com o schema auth e o pedaço do banco do Storage simulados (testes/rh_storage_simulado.js).
// Ordem: dados de antes; R.0; bloco principal 2x (tem que poder ser reexecutado); conferências R.1 a
// R.5 comparando o RESULTADO com o "esperado" do título; R.6 igual ao R.0; conferências do R01,
// R01b e R03 de novo (as regras de antes continuam valendo); nada das conferências ficou salvo e os
// dados de antes continuam iguais (a lixeira não apaga nada).
// O que NÃO dá para testar aqui: o PostgREST chamando as RPCs (isso fica no t_rh_lixeira.js).
// Uso: node testes/t_rh_r05.js
const fs = require('fs');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');
const { AUTH_SIMULADO, storageSimulado } = require('./rh_storage_simulado');

const RAIZ = process.env.RAIZ || path.resolve(__dirname, '..');
const ler = (arq) => fs.readFileSync(path.join(RAIZ, 'supabase/sql/rh', arq), 'utf8');

function partes(sql) {
  const inicio = sql.indexOf('\nbegin;\n');
  const fim = sql.indexOf('\ncommit;\n') + '\ncommit;\n'.length;
  const blocos = sql.slice(fim).split(/^(?=-- -+\n-- R\.\d+ )/m)
    .map(b => b.replace(/^-- -+\n/, ''))
    .filter(b => /^-- R\.\d+ /.test(b));
  const r0 = sql.slice(0, inicio).split(/^(?=-- -+\n-- R\.\d+ )/m)
    .map(b => b.replace(/^-- -+\n/, '')).find(b => b.startsWith('-- R.0 '));
  return { principal: sql.slice(inicio, fim), blocos, r0 };
}

const r01 = partes(ler('R01_estrutura.sql'));
const r01b = partes(ler('R01b_admin.sql'));
const r03 = partes(ler('R03_anexos.sql'));
const r05 = partes(ler('R05_lixeira.sql'));

let falhas = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'OK  ' : 'FALHA'} ${msg}`); if (!cond) falhas++; };

(async () => {
  const db = new PGlite();
  await db.exec(AUTH_SIMULADO + storageSimulado() + `
    create table public.perfis (id uuid primary key, nome text, role text);
    create function public.is_admin() returns boolean language sql stable security definer as $$
      select coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') in ('admin', 'diretoria') $$;
    grant usage on schema public to anon, authenticated;
    grant select on public.perfis to authenticated;
  `);
  await db.exec(r01.principal);
  await db.exec(r01b.principal);
  await db.exec(r03.principal);

  // Dados de antes do R05 (não podem mudar)
  await db.exec(`
    with c as (insert into rh.colaboradores (nome, vinculo) values ('Antigo', 'CLT') returning id),
         p as (insert into rh.processos (colaborador_id, modelo_id, modelo_nome)
               select c.id, m.id, m.nome from c, rh.modelos m where m.chave = 'rescisao_clt' returning id)
    insert into rh.etapas (processo_id, ordem, nome) select p.id, 1, 'Assinaturas' from p;
  `);
  // Colaboradores sem as 3 colunas novas do R05 (conferidas à parte: têm que estar vazias)
  const fotoDados = async () => JSON.stringify((await db.query(`select
      (select json_agg(to_jsonb(t) - 'excluido_em' - 'excluido_por' - 'excluido_por_email' order by t.id) from rh.colaboradores t) c,
      (select json_agg(t order by t.id) from rh.processos t) p,
      (select json_agg(t order by t.id) from rh.etapas t) e, (select count(*) from rh.auditoria) a,
      (select count(*) from rh.anexos) x, (select count(*) from storage.objects) o`)).rows[0]);
  const dadosAntes = await fotoDados();

  const retrato = async (bloco) => {
    const res = await db.exec(bloco);
    return JSON.stringify(res.find(x => x.rows.length).rows[0]);
  };
  const conferir = async (blocos) => {
    const saida = {};
    for (const b of blocos) {
      const l = b.split('\n')[0];
      const titulo = l.replace(/^-- /, '').replace(/ \(esperado:.*$/, '');
      const esperado = (l.match(/\(esperado: (.*)\)$/) || [])[1] || '';
      let obtido;
      try { await db.exec(b); obtido = '(sem erro e sem RESULTADO)'; }
      catch (e) { obtido = e.message; await db.exec('rollback').catch(() => {}); }
      const limpo = obtido.replace(/^RESULTADO( \(nada foi salvo\))?: /, '');
      saida[titulo] = { esperado, obtido: limpo };
    }
    return saida;
  };
  const mostrar = (titulo, conf, esperadoTrocado = {}) => {
    console.log(`\n=== ${titulo} ===`);
    for (const [nome, c] of Object.entries(conf)) {
      const chave = Object.keys(esperadoTrocado).find(k => nome.startsWith(k));
      const esperado = chave ? esperadoTrocado[chave] : c.esperado;
      const bate = c.obtido === esperado;
      if (!bate) falhas++;
      console.log(`\n[${bate ? 'OK' : 'DIFERENTE'}] ${nome}${chave ? ' (esperado trocado: mudou com R01b/R03/R05)' : ''}`);
      console.log(`  RESULTADO: ${c.obtido}`);
      if (!bate) console.log(`  esperado:  ${esperado}`);
    }
  };

  const antes = await retrato(r05.r0);
  await db.exec(r05.principal);
  await db.exec(r05.principal);
  console.log('Bloco principal do R05: ok (2x, sem erro)');

  mostrar('Conferências do R05', await conferir(r05.blocos.filter(b => !b.startsWith('-- R.6 '))));

  const depois = await retrato(r05.blocos.find(b => b.startsWith('-- R.6 ')));
  console.log('\n=== Retrato do public ===');
  console.log(`  R.0 (antes):  ${antes}`);
  console.log(`  R.6 (depois): ${depois}`);
  ok(antes === depois, 'R.0 e R.6 iguais (public não mudou)');

  // As regras de antes continuam: conferências do R01, R01b e R03 de novo (sem os retratos).
  // No R01, R.1 e R.3 já mudaram com o R03 (tabela anexos) e o R01b (admin lê e grava), não com o R05.
  const semRetrato = (blocos) => blocos.filter(b => !/^-- R\.\d+ (Retrato|Nada mudou no public)/.test(b));
  const esperadoR01 = (n) => r01.blocos.find(b => b.startsWith(`-- R.${n} `)).split('\n')[0].match(/\(esperado: (.*)\)$/)[1];
  mostrar('Conferências do R01 depois do R05', await conferir(semRetrato(r01.blocos)), {
    'R.1 ': esperadoR01(1).replace('tabelas_rls=auditoria:true', 'tabelas_rls=anexos:true, auditoria:true'),
    'R.3 ': esperadoR01(3).replace('admin=linhas_lidas:0 gravar:bloqueado', 'admin=linhas_lidas:30 gravar:LIBERADO')
  });
  const r1b = r01b.blocos.find(b => b.startsWith('-- R.1 ')).split('\n')[0].match(/\(esperado: (.*)\)$/)[1]
    .replace('policies=27 | com_admin=27', 'policies=30 | com_admin=30').replace('com_restrito=11', 'com_restrito=12');
  mostrar('Conferências do R01b depois do R05', await conferir(semRetrato(r01b.blocos)), { 'R.1 ': r1b });
  mostrar('Conferências do R03 depois do R05', await conferir(semRetrato(r03.blocos)));

  // Nada das conferências ficou salvo; os dados de antes estão iguais
  const dadosDepois = await fotoDados();
  ok(dadosDepois === dadosAntes, 'dados de antes iguais e nada das conferências ficou salvo');
  if (dadosDepois !== dadosAntes) console.log(`  antes:  ${dadosAntes}\n  depois: ${dadosDepois}`);
  await db.close();
  console.log(falhas ? `\n${falhas} FALHA(S)` : '\nTUDO OK');
  process.exit(falhas ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
