// supabase/sql/torre/T03_pendencias.sql num Postgres em WASM (PGlite), em cima do T01 + T02, com
// auth.uid()/auth.jwt(), is_admin(), os papéis do Supabase e um public de mentira para o retrato.
// Confere: tudo que o T03 cria/altera é no schema torre (grep); roda 2x (reexecutável);
// conferências 7.1 a 7.6 comparando com o "esperado" de cada uma, com e sem uma pendência aberta
// "de verdade" já no banco; 7.7 igual ao item 0; as conferências do T02 de novo (sem pendência
// aberta continuam iguais); nada das conferências ficou salvo.
// Uso: node testes/torre/t_torre_t03.js
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
  const t03 = ler('supabase/sql/torre/T03_pendencias.sql');
  const item0 = t03.slice(0, t03.indexOf('\nbegin;\n'));
  const instalacao = ateCommit(t03);

  // --- Só o schema torre (grep) ---
  const ddl = [...instalacao.slice(instalacao.indexOf('\nbegin;\n')).matchAll(/^\s*(create|alter|grant|revoke|drop|insert|update|delete|truncate|comment)\b[^;]*/gim)].map(m => m[0]);
  const fora = ddl.filter(s => !/torre\./i.test(s));
  ok(fora.length === 0, 'instalação: todo create/alter/grant/revoke/drop é no schema torre', fora.join(' || ') || `${ddl.length} comandos`);
  const usosPublic = [...new Set([...t03.matchAll(/public\.[a-z_]+/gi)].map(m => m[0]))];
  ok(usosPublic.join() === 'public.is_admin', 'do public só cita is_admin() (num comentário; é chamado via torre.eh_operador)', usosPublic.join());

  const db = await novoBanco();
  await db.exec(ateCommit(t01));
  await db.exec(ateCommit(t02).slice(ateCommit(t02).indexOf('\nbegin;\n')));
  const retrato = async (bloco) => JSON.stringify((await db.query(bloco.replace(/^[\s\S]*?(?=select md5)/, ''))).rows[0]);
  const antes = await retrato(item0);

  const principal = instalacao.slice(instalacao.indexOf('\nbegin;\n'));
  await db.exec(principal);
  await db.exec(principal);
  ok(true, 'bloco principal do T03 rodou 2x sem erro');

  const rodar = async (bloco) => {
    try { await db.exec(bloco); return '(sem erro e sem RESULTADO)'; }
    catch (e) { await db.exec('rollback').catch(() => {}); return e.message.replace(/^RESULTADO( \(nada foi salvo\))?: /, ''); }
  };
  const blocos = conferencias(t03, 7);
  const conferir = async (rotulo) => {
    console.log(`\n=== Conferências do T03 (${rotulo}) ===`);
    for (const b of blocos) {
      const l = b.split('\n')[0];
      if (/^-- 7\.7 /.test(l)) continue;
      const esperado = (l.match(/\(esperado: (.*)\)$/) || [])[1];
      const obtido = await rodar(b);
      ok(obtido === esperado, l.replace(/ \(esperado:.*$/, '').replace(/^-- /, ''), obtido === esperado ? undefined : `\n   obtido:   ${obtido}\n   esperado: ${esperado}`);
    }
  };
  await conferir('banco sem pendência');

  // Banco "de verdade" com uma passagem já publicada e uma pendência aberta: as conferências
  // fecham a pendência só dentro da transação (desfeito no rollback) e dão o mesmo resultado
  await db.exec(`begin;
    select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000c3","role":"authenticated","email":"admin@teste.local","app_metadata":{"role":"admin"}}', true);
    select torre.publicar_passagem('T3', current_date - 3, 'antiga', null, E'PENDÊNCIAS PARA O PRÓXIMO TURNO\n- Pendência real aberta', '[]');
    commit;`);
  const real = (await db.query(`select count(*)::int n from torre.passagem_pendencias where status = 'aberta'`)).rows[0].n;
  ok(real === 1, 'banco com 1 pendência aberta de verdade', real);
  await conferir('com 1 pendência aberta de verdade');
  const aindaAberta = (await db.query(`select count(*)::int n from torre.passagem_pendencias where status = 'aberta' and texto = 'Pendência real aberta'`)).rows[0].n;
  ok(aindaAberta === 1, 'a pendência de verdade continua aberta depois das conferências (rollback)', aindaAberta);

  const depois = await retrato(blocos.find(b => b.startsWith('-- 7.7 ')));
  ok(antes === depois, '7.7 igual ao item 0 (public não mudou)', `${antes} / ${depois}`);

  // Conferências do T02 de novo (sem pendência aberta; a de verdade é fechada só na transação de teste)
  console.log('\n=== Conferências do T02 depois do T03 ===');
  await db.exec(`begin; set local session_replication_role = replica;
    update torre.passagem_pendencias set status = 'resolvida', resolucao = 'fechada para o teste', resolvido_em = now(),
      fechada_na_passagem = passagem_id where status = 'aberta'; commit;`);
  for (const b of conferencias(t02, 7)) {
    const l = b.split('\n')[0];
    if (/^-- 7\.7 /.test(l)) continue;
    let esperado = (l.match(/\(esperado: (.*)\)$/) || [])[1];
    // Depois do T03 o truncate de passagens_turno para antes, no FK das pendências (continua bloqueado)
    if (/^-- 7\.5 /.test(l)) esperado = 'cannot truncate a table referenced in a foreign key constraint';
    const obtido = await rodar(b);
    ok(obtido === esperado, 'T02 ' + l.replace(/ \(esperado:.*$/, '').replace(/^-- /, ''), obtido === esperado ? undefined : `\n   obtido:   ${obtido}\n   esperado: ${esperado}`);
  }

  const sobrou = (await db.query(`select (select count(*)::int from torre.passagens_turno) p,
    (select count(*)::int from torre.passagem_pendencias) n, (select count(*)::int from torre.ia_chamadas) c`)).rows[0];
  ok(sobrou.p === 1 && sobrou.n === 1 && sobrou.c === 0, 'nada das conferências ficou salvo (só a passagem e a pendência "de verdade")', JSON.stringify(sobrou));
  await db.close();
  console.log(falhas ? `\n${falhas} FALHA(S)` : '\nTUDO OK');
  process.exit(falhas ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
