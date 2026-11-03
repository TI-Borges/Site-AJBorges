// Roda supabase/sql/rh/R01_estrutura.sql num Postgres em WASM (PGlite), com o schema auth simulado
// (auth.uid() e auth.jwt() lendo request.jwt.claims, como no Supabase) e os papéis anon,
// authenticated e service_role. O bloco principal roda duas vezes (tem que poder ser reexecutado);
// depois as conferências R.1 a R.8, bloco a bloco, como no SQL Editor; cada RESULTADO é comparado
// com o "esperado" do título. O retrato do public (R.0 / R.9) é tirado antes e depois.
// Uso: node testes/t_rh_r01.js
const fs = require('fs');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');

const RAIZ = process.env.RAIZ || path.resolve(__dirname, '..');
const sql = fs.readFileSync(path.join(RAIZ, 'supabase/sql/rh/R01_estrutura.sql'), 'utf8');

const inicioPrincipal = sql.indexOf('\nbegin;\n');
const fimPrincipal = sql.indexOf('\ncommit;\n') + '\ncommit;\n'.length;
const principal = sql.slice(inicioPrincipal, fimPrincipal);
const resto = sql.slice(fimPrincipal);
const blocos = resto.split(/^(?=-- R\.\d+ )/m).filter(b => /^-- R\.\d+ /.test(b));
const retrato = blocos.find(b => b.startsWith('-- R.9 '));

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
    -- Um pouco de public, para o retrato ter o que comparar
    create table public.perfis (id uuid primary key, nome text, role text);
    create function public.is_admin() returns boolean language sql stable security definer as $$
      select coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') in ('admin', 'diretoria') $$;
    grant usage on schema public to anon, authenticated;
    grant select on public.perfis to authenticated;
  `);

  const r = {};
  const tirarRetrato = async () => {
    const res = await db.exec(retrato);
    const linha = res.find(x => x.rows.length).rows[0];
    return `${linha.retrato_public} (${linha.itens} itens)`;
  };
  r.retratoAntes = await tirarRetrato();

  await db.exec(principal);
  await db.exec(principal);
  r.blocoPrincipal = 'ok (2x, sem erro)';

  r.conferencias = {};
  let falhas = 0;
  for (const b of blocos.filter(x => !x.startsWith('-- R.9 '))) {
    const l = b.split('\n')[0];
    const titulo = l.replace(/^-- /, '').replace(/ \(esperado:.*$/, '');
    const esperado = (l.match(/\(esperado: (.*)\)$/) || [])[1] || '';
    let obtido;
    try { await db.exec(b); obtido = '(sem erro e sem RESULTADO)'; }
    catch (e) { obtido = e.message; await db.exec('rollback').catch(() => {}); }
    const limpo = obtido.replace(/^RESULTADO( \(nada foi salvo\))?: /, '');
    const bate = limpo === esperado;
    if (!bate) falhas++;
    r.conferencias[titulo] = { bate: bate ? 'ok' : 'DIFERENTE', esperado, obtido: limpo };
  }

  r.retratoDepois = await tirarRetrato();
  r.retratoIgual = r.retratoAntes === r.retratoDepois;
  if (!r.retratoIgual) falhas++;

  // Nada das conferências ficou salvo
  r.sobrou = (await db.query(`select (select count(*) from rh.colaboradores) colaboradores,
    (select count(*) from rh.observacoes) observacoes, (select count(*) from rh.auditoria) auditoria`)).rows[0];
  if (Object.values(r.sobrou).some(n => Number(n) !== 0)) falhas++;

  console.log(JSON.stringify(r, null, 2));
  console.log(falhas ? `\n${falhas} FALHA(S)` : '\nTUDO OK');
  process.exit(falhas ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
