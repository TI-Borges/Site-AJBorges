// supabase/sql/torre/T02_passagem_turno.sql num Postgres em WASM (PGlite), em cima do T01, com
// auth.jwt(), is_admin(), os papéis do Supabase e um public de mentira para o retrato.
// Confere: tudo que o T02 cria/altera é no schema torre (grep); roda 2x (reexecutável);
// conferências 7.1 a 7.6 comparando com o "esperado" de cada uma; 7.7 igual ao item 0; as
// conferências 8.x do T01 de novo (só a 8.1 muda, pelas tabelas novas); nada ficou salvo.
// Uso: node testes/torre/t_torre_t02.js
const fs = require('fs');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');

const RAIZ = process.env.RAIZ || path.resolve(__dirname, '..', '..');
const ler = (a) => fs.readFileSync(path.join(RAIZ, a), 'utf8');
const ateCommit = (sql) => sql.slice(0, sql.indexOf('\ncommit;\n') + '\ncommit;\n'.length);
let falhas = 0;
const ok = (cond, msg, extra) => { console.log(`${cond ? 'OK  ' : 'FALHA'} ${msg}${extra !== undefined ? ' -> ' + extra : ''}`); if (!cond) falhas++; };

// Blocos "-- N.x título (esperado: ...)" até o próximo do mesmo item
function conferencias(sql, item) {
  const resto = sql.slice(ateCommit(sql).length);
  return resto.split(new RegExp(`^(?=-- ${item}\\.\\d+ )`, 'm')).filter(b => b.startsWith(`-- ${item}.`));
}

async function novoBanco() {
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
    create function public.is_admin() returns boolean language sql stable security definer as $$
      select coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') in ('admin', 'diretoria') $$;
    create table public.perfis (id uuid primary key, nome text, role text);
    insert into public.perfis values ('11111111-1111-1111-1111-111111111111', 'Motorista Teste', 'motorista'),
                                     ('22222222-2222-2222-2222-222222222222', 'Gestão', 'admin');
    alter table public.perfis enable row level security;
    create policy perfis_proprio on public.perfis for select to authenticated using (id = auth.uid() or public.is_admin());
    grant usage on schema public to anon, authenticated;
    grant select on public.perfis to authenticated;
  `);
  return db;
}

(async () => {
  const t01 = ler('supabase/sql/torre/T01_copia_planilha.sql');
  const t02 = ler('supabase/sql/torre/T02_passagem_turno.sql');
  const item0 = t02.slice(0, t02.indexOf('\nbegin;\n'));
  const instalacao = ateCommit(t02);

  // --- Só o schema torre (grep) ---
  const ddl = [...instalacao.slice(instalacao.indexOf('\nbegin;\n')).matchAll(/^\s*(create|alter|grant|revoke|drop|insert|update|delete|truncate|comment)\b[^;]*/gim)].map(m => m[0]);
  const fora = ddl.filter(s => !/torre\./i.test(s));
  ok(fora.length === 0, 'instalação: todo create/alter/grant/revoke/insert é no schema torre', fora.join(' || ') || `${ddl.length} comandos`);
  const usosPublic = [...new Set([...t02.matchAll(/public\.[a-z_]+/gi)].map(m => m[0]))];
  ok(usosPublic.join() === 'public.is_admin', 'do public só cita is_admin() (num comentário; é chamado via torre.eh_operador)', usosPublic.join());

  const db = await novoBanco();
  await db.exec(ateCommit(t01));
  const retrato = async (bloco) => JSON.stringify((await db.query(bloco.replace(/^[\s\S]*?(?=select md5)/, ''))).rows[0]);
  const antes = await retrato(item0);

  await db.exec(instalacao.slice(instalacao.indexOf('\nbegin;\n')));
  await db.exec(instalacao.slice(instalacao.indexOf('\nbegin;\n')));
  ok(true, 'bloco principal do T02 rodou 2x sem erro');

  const rodar = async (bloco) => {
    try { await db.exec(bloco); return '(sem erro e sem RESULTADO)'; }
    catch (e) { await db.exec('rollback').catch(() => {}); return e.message.replace(/^RESULTADO( \(nada foi salvo\))?: /, ''); }
  };

  console.log('\n=== Conferências do T02 ===');
  for (const b of conferencias(t02, 7)) {
    const l = b.split('\n')[0];
    if (/^-- 7\.7 /.test(l)) continue;
    const esperado = (l.match(/\(esperado: (.*)\)$/) || [])[1];
    const obtido = await rodar(b);
    ok(obtido === esperado, l.replace(/ \(esperado:.*$/, '').replace(/^-- /, ''), obtido === esperado ? undefined : `\n   obtido:   ${obtido}\n   esperado: ${esperado}`);
  }
  const depois = await retrato(conferencias(t02, 7).find(b => b.startsWith('-- 7.7 ')));
  ok(antes === depois, '7.7 igual ao item 0 (public não mudou)', `${antes} / ${depois}`);

  // Conferências do T01 de novo: a 8.1 muda pelas tabelas e grants novos do T02
  console.log('\n=== Conferências do T01 depois do T02 ===');
  for (const b of conferencias(t01, 8)) {
    const l = b.split('\n')[0];
    if (/^-- 8\.8 /.test(l)) continue;
    let esperado = (l.match(/\(esperado: (.*)\)$/) || [])[1];
    const obtido = await rodar(b);
    if (/^-- 8\.1 /.test(l)) {
      esperado = esperado
        .replace('tabelas_rls=colunas:true, planilha_abas:true, planilha_linhas:true, sincronizacao:true',
                 'tabelas_rls=colunas:true, ia_chamadas:true, passagens_turno:true, planilha_abas:true, planilha_linhas:true, sincronizacao:true, turnos:true')
        .replace('policies=4 (só select)', 'policies=8 (TEM ESCRITA)')
        .replace('authenticated_escrita=0', 'authenticated_escrita=1');
    }
    ok(obtido === esperado, l.replace(/ \(esperado:.*$/, '').replace(/^-- /, '') + (/^-- 8\.1 /.test(l) ? ' (esperado trocado pelo T02)' : ''),
      obtido === esperado ? undefined : `\n   obtido:   ${obtido}\n   esperado: ${esperado}`);
  }

  const sobrou = (await db.query(`select (select count(*)::int from torre.passagens_turno) p, (select count(*)::int from torre.ia_chamadas) c,
    (select count(*)::int from torre.turnos where inicio is null and fim is null) t`)).rows[0];
  ok(sobrou.p === 0 && sobrou.c === 0 && sobrou.t === 3, 'nada das conferências ficou salvo; turnos continuam sem horário', JSON.stringify(sobrou));
  await db.close();
  console.log(falhas ? `\n${falhas} FALHA(S)` : '\nTUDO OK');
  process.exit(falhas ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
