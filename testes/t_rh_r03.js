// Roda supabase/sql/rh/R03_anexos.sql num Postgres em WASM (PGlite), em cima do R01 + R01b, com o
// schema auth e o pedaço do banco do Storage simulados (testes/rh_storage_simulado.js).
// Roda tudo duas vezes: com o storage "normal" e com uma policy larga demais no storage.objects
// (legado_tudo, libera tudo): as policies restritivas do R03 têm que segurar o rh-anexos igual.
// Em cada rodada: anexos antigos gravados antes; R.0; bloco principal 2x (tem que poder ser
// reexecutado); conferências R.1 a R.7 comparando o RESULTADO com o "esperado" do título; R.8 igual
// ao R.0; conferências do R01b de novo (só a contagem de policies do R.1 muda); o bucket
// "comprovantes" continua funcionando; nada das conferências ficou salvo.
// O que NÃO dá para testar aqui: o serviço de Storage (limite de 10 MB, tipos, link assinado,
// upsert/delete pela API) e os triggers internos que o Supabase tenha no storage.objects.
// Uso: node testes/t_rh_r03.js
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

let falhas = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'OK  ' : 'FALHA'} ${msg}`); if (!cond) falhas++; };

async function rodada(policyLarga) {
  console.log(`\n\n######## Storage ${policyLarga ? 'COM a policy larga demais (legado_tudo)' : 'normal'} ########`);
  const db = new PGlite();
  await db.exec(AUTH_SIMULADO + storageSimulado({ policyLarga }) + `
    -- Um pouco de public, para o retrato ter o que comparar
    create table public.perfis (id uuid primary key, nome text, role text);
    create function public.is_admin() returns boolean language sql stable security definer as $$
      select coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') in ('admin', 'diretoria') $$;
    grant usage on schema public to anon, authenticated;
    grant select on public.perfis to authenticated;
  `);
  await db.exec(r01.principal);
  await db.exec(r01b.principal);

  // Anexos antigos (só nomes), gravados antes do R03: não podem sumir nem mudar
  await db.exec(`
    with c as (insert into rh.colaboradores (nome, vinculo) values ('Antigo', 'CLT') returning id),
         p as (insert into rh.processos (colaborador_id, modelo_id, modelo_nome)
               select c.id, m.id, m.nome from c, rh.modelos m where m.chave = 'rescisao_clt' returning id)
    insert into rh.etapas (processo_id, ordem, nome, anexos)
    select p.id, 1, 'Assinaturas', array['contrato-antigo.pdf', '<img src=x onerror=alert(1)>.pdf'] from p;
  `);

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
      saida[titulo] = { bate: limpo === esperado, esperado, obtido: limpo };
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
      console.log(`\n[${bate ? 'OK' : 'DIFERENTE'}] ${nome}${chave ? ' (esperado trocado pelo R03)' : ''}`);
      console.log(`  RESULTADO: ${c.obtido}`);
      console.log(`  esperado:  ${esperado}`);
    }
  };

  const antes = await retrato(r03.r0);
  await db.exec(r03.principal);
  await db.exec(r03.principal);
  console.log('Bloco principal do R03: ok (2x, sem erro)');

  mostrar('Conferências do R03', await conferir(r03.blocos.filter(b => !b.startsWith('-- R.8 '))));

  const depois = await retrato(r03.blocos.find(b => b.startsWith('-- R.8 ')));
  console.log('\n=== Retrato (public, storage fora do rh-anexos, anexos antigos) ===');
  console.log(`  R.0 (antes):  ${antes}`);
  console.log(`  R.8 (depois): ${depois}`);
  ok(antes === depois, 'R.0 e R.8 iguais');
  ok(/"anexos_antigos":"1 etapas, 2 nomes/.test(depois), 'os 2 nomes antigos continuam lá');

  // Conferências do R01b de novo: só o R.1 conta as 3 policies novas de rh.anexos
  const r1b = r01b.blocos.find(b => b.startsWith('-- R.1 ')).split('\n')[0].match(/\(esperado: (.*)\)$/)[1]
    .replace('policies=27 | com_admin=27', 'policies=30 | com_admin=30').replace('com_restrito=11', 'com_restrito=12');
  mostrar('Conferências do R01b depois do R03', await conferir(r01b.blocos.slice(0, -1)), { 'R.1 ': r1b });

  // O bucket comprovantes continua funcionando (as restritivas só valem para o rh-anexos)
  const comprovante = await db.transaction(async (tx) => {
    await tx.query(`select set_config('request.jwt.claims', $1, true)`,
      [JSON.stringify({ sub: '00000000-0000-0000-0000-0000000000e5', role: 'authenticated', app_metadata: { role: 'motorista' } })]);
    await tx.query('set local role authenticated');
    await tx.query(`insert into storage.objects (bucket_id, name, owner_id, metadata)
      values ('comprovantes', 'm1/recibo.jpg', '00000000-0000-0000-0000-0000000000e5', '{}')`);
    const n = (await tx.query(`select count(*)::int n from storage.objects where bucket_id = 'comprovantes'`)).rows[0].n;
    await tx.query(`delete from storage.objects where bucket_id = 'comprovantes'`);
    return n;
  }).catch(e => `ERRO: ${e.message}`);
  ok(comprovante === 1, `motorista ainda envia e lê no bucket comprovantes (${comprovante})`);

  // Nada das conferências ficou salvo
  const sobrou = (await db.query(`select (select count(*)::int from rh.anexos) anexos,
    (select count(*)::int from storage.objects where bucket_id = 'rh-anexos') objetos,
    (select count(*)::int from rh.auditoria) auditoria,
    (select count(*)::int from rh.colaboradores) colaboradores`)).rows[0];
  ok(sobrou.anexos === 0 && sobrou.objetos === 0 && sobrou.auditoria === 0 && sobrou.colaboradores === 1,
    `nada das conferências ficou salvo ${JSON.stringify(sobrou)}`);
  await db.close();
}

(async () => {
  await rodada(false);
  await rodada(true);
  console.log(falhas ? `\n${falhas} FALHA(S)` : '\nTUDO OK');
  process.exit(falhas ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
