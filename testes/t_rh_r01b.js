// Roda supabase/sql/rh/R01b_admin.sql num Postgres em WASM (PGlite), em cima do R01, com o mesmo
// schema auth simulado do t_rh_r01.js. O bloco principal do R01b roda duas vezes (tem que poder ser
// reexecutado); depois as conferências R.1 a R.6, bloco a bloco, comparando cada RESULTADO com o
// "esperado" do título. O retrato do public é tirado antes do R01, entre o R01 e o R01b e no fim
// (os três têm que ser iguais). Por fim repete as conferências do R01: só o "admin" do R.3 muda.
// Uso: node testes/t_rh_r01b.js
const fs = require('fs');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');

const RAIZ = process.env.RAIZ || path.resolve(__dirname, '..');
const ler = (arq) => fs.readFileSync(path.join(RAIZ, 'supabase/sql/rh', arq), 'utf8');

function partes(sql) {
  const inicio = sql.indexOf('\nbegin;\n');
  const fim = sql.indexOf('\ncommit;\n') + '\ncommit;\n'.length;
  const blocos = sql.slice(fim).split(/^(?=-- R\.\d+ )/m).filter(b => /^-- R\.\d+ /.test(b));
  // O R.0 (retrato antes) fica antes do bloco principal
  const r0 = sql.slice(0, inicio).split(/^(?=-- R\.\d+ )/m).find(b => b.startsWith('-- R.0 '));
  return { principal: sql.slice(inicio, fim), blocos, r0 };
}

const r01 = partes(ler('R01_estrutura.sql'));
const r01b = partes(ler('R01b_admin.sql'));
const retratoR01 = r01.blocos.find(b => b.startsWith('-- R.9 '));
const retratoR01b = r01b.blocos[r01b.blocos.length - 1];

(async () => {
  const db = new PGlite();
  await db.exec(`
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$
      select (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid $$;
    create function auth.jwt() returns jsonb language sql stable as $$
      select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb) $$;
    create role authenticated;
    create role anon;
    create role service_role;
    grant usage on schema auth to anon, authenticated, service_role;
    grant execute on all functions in schema auth to anon, authenticated, service_role;
    -- Um pouco de public, para o retrato ter o que comparar (is_admin vale para admin E diretoria)
    create table public.perfis (id uuid primary key, nome text, role text);
    create function public.is_admin() returns boolean language sql stable security definer as $$
      select coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') in ('admin', 'diretoria') $$;
    grant usage on schema public to anon, authenticated;
    grant select on public.perfis to authenticated;
  `);

  let falhas = 0;
  const tirarRetrato = async (bloco) => {
    const res = await db.exec(bloco);
    const linha = res.find(x => x.rows.length).rows[0];
    return `${linha.retrato_public} (${linha.itens} itens)`;
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
  const mostrar = (titulo, conf, aceitarDiferenca = () => false) => {
    console.log(`\n=== ${titulo} ===`);
    for (const [nome, c] of Object.entries(conf)) {
      const aceito = !c.bate && aceitarDiferenca(nome);
      if (!c.bate && !aceito) falhas++;
      console.log(`\n[${c.bate ? 'OK' : (aceito ? 'MUDOU (esperado)' : 'DIFERENTE')}] ${nome}`);
      console.log(`  RESULTADO: ${c.obtido}`);
      console.log(`  esperado:  ${c.esperado}`);
    }
  };

  const retratoAntes = await tirarRetrato(retratoR01);
  await db.exec(r01.principal);
  const retratoDepoisR01 = await tirarRetrato(retratoR01);

  // R.0 do R01b (antes de rodar o R01b)
  const retratoR0 = await tirarRetrato(r01b.r0);

  await db.exec(r01b.principal);
  await db.exec(r01b.principal);
  console.log('Bloco principal do R01b: ok (2x, sem erro)');

  mostrar('Conferências do R01b', await conferir(r01b.blocos.slice(0, -1)));

  const retratoR7 = await tirarRetrato(retratoR01b);
  console.log('\n=== Retrato do public ===');
  console.log(`  antes do R01:          ${retratoAntes}`);
  console.log(`  depois do R01:         ${retratoDepoisR01}`);
  console.log(`  R.0 do R01b (antes):   ${retratoR0}`);
  console.log(`  R.7 do R01b (depois):  ${retratoR7}`);
  const retratosIguais = new Set([retratoAntes, retratoDepoisR01, retratoR0, retratoR7]).size === 1;
  console.log(`  [${retratosIguais ? 'OK' : 'DIFERENTE'}] os quatro iguais`);
  if (!retratosIguais) falhas++;

  // Conferências do R01 de novo, agora com o R01b aplicado: tudo igual, menos o admin do R.3
  const confR01 = await conferir(r01.blocos.filter(b => !b.startsWith('-- R.9 ')));
  mostrar('Conferências do R01 depois do R01b', confR01, (nome) => nome.startsWith('R.3 '));
  const r3 = Object.entries(confR01).find(([n]) => n.startsWith('R.3 '))[1].obtido;
  const r3Esperado = 'motorista=linhas_lidas:0 gravar:bloqueado | admin=linhas_lidas:27 gravar:LIBERADO | diretoria=linhas_lidas:0 gravar:bloqueado | linhas_no_banco>0=true';
  console.log(`\n  R.3 do R01 com admin liberado: ${r3 === r3Esperado ? 'OK' : 'DIFERENTE'}`);
  console.log(`    RESULTADO: ${r3}`);
  console.log(`    esperado:  ${r3Esperado}`);
  if (r3 !== r3Esperado) falhas++;

  // Nada das conferências ficou salvo
  const sobrou = (await db.query(`select (select count(*) from rh.colaboradores) colaboradores,
    (select count(*) from rh.observacoes) observacoes, (select count(*) from rh.auditoria) auditoria,
    (select count(*) from rh.modelo_etapas) modelo_etapas`)).rows[0];
  const limpo = Number(sobrou.colaboradores) + Number(sobrou.observacoes) + Number(sobrou.auditoria) === 0
    && Number(sobrou.modelo_etapas) === 18;
  console.log(`\nNada ficou salvo: ${limpo ? 'OK' : 'DIFERENTE'} ${JSON.stringify(sobrou)}`);
  if (!limpo) falhas++;

  console.log(falhas ? `\n${falhas} FALHA(S)` : '\nTUDO OK');
  process.exit(falhas ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
