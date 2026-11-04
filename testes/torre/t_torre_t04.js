// supabase/sql/torre/T04_nome_operador.sql num Postgres em WASM (PGlite), em cima do T01 + T02 + T03, com
// auth.uid()/auth.jwt(), is_admin(), os papéis do Supabase e um public de mentira para o retrato.
// Confere: tudo que o T04 cria/altera é no schema torre (grep) e sem update/delete novo; roda 2x
// (reexecutável); passagem e pendências de ANTES do T04 ficam iguais, com o nome vazio; conferências
// 7.1 a 7.5 comparando com o "esperado" de cada uma, com e sem uma pendência aberta "de verdade";
// 7.6 igual ao item 0; nada das conferências ficou salvo.
// Uso: node testes/torre/t_torre_t04.js
const fs = require('fs');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');

const RAIZ = process.env.RAIZ || path.resolve(__dirname, '..', '..');
const ler = (a) => fs.readFileSync(path.join(RAIZ, a), 'utf8');
const ateCommit = (sql) => sql.slice(0, sql.indexOf('\ncommit;\n') + '\ncommit;\n'.length);
const principal = (sql) => ateCommit(sql).slice(ateCommit(sql).indexOf('\nbegin;\n'));
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

const ADMIN = `select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000c3","role":"authenticated","email":"admin@teste.local","app_metadata":{"role":"admin"}}', true);`;

(async () => {
  const t04 = ler('supabase/sql/torre/T04_nome_operador.sql');
  const item0 = t04.slice(0, t04.indexOf('\nbegin;\n'));
  const instalacao = ateCommit(t04);

  // --- Só o schema torre; nada de update/delete novo (grep) ---
  const corpoPrincipal = instalacao.slice(instalacao.indexOf('\nbegin;\n'));
  const ddl = [...corpoPrincipal.matchAll(/^\s*(create|alter|grant|revoke|drop|insert|update|delete|truncate|comment)\b[^;]*/gim)].map(m => m[0]);
  const fora = ddl.filter(s => !/torre\./i.test(s));
  ok(fora.length === 0, 'instalação: todo create/alter/grant/revoke/drop é no schema torre', fora.join(' || ') || `${ddl.length} comandos`);
  const usosPublic = [...new Set([...t04.matchAll(/public\.[a-z_]+/gi)].map(m => m[0]))];
  ok(usosPublic.join() === 'public.is_admin', 'do public só cita is_admin() (num comentário; é chamado via torre.eh_operador)', usosPublic.join());
  const grantsNovos = [...corpoPrincipal.matchAll(/^\s*grant\b[^;]*/gim)].map(m => m[0].replace(/\s+/g, ' '));
  ok(grantsNovos.every(g => /^ ?grant execute on function/i.test(g)), 'só grant de execute (nenhum grant novo de update/delete/insert)', grantsNovos.join(' || '));
  const updatesDeletes = [...corpoPrincipal.replace(/\$\$[\s\S]*?\$\$/g, '').matchAll(/^\s*(update|delete|truncate)\b[^;]*/gim)].map(m => m[0]);
  ok(updatesDeletes.length === 0, 'nenhum update/delete/truncate solto no bloco principal (linhas antigas não mudam)', updatesDeletes.join(' || '));

  const db = await novoBanco();
  await db.exec(ateCommit(ler('supabase/sql/torre/T01_copia_planilha.sql')));
  await db.exec(principal(ler('supabase/sql/torre/T02_passagem_turno.sql')));
  await db.exec(principal(ler('supabase/sql/torre/T03_pendencias.sql')));

  // Passagens e pendência de ANTES do T04 (a pendência da 1ª é fechada na 2ª)
  await db.exec(`begin; ${ADMIN}
    select torre.publicar_passagem('T1', current_date - 2, 'antiga 1', null, E'PENDÊNCIAS PARA O PRÓXIMO TURNO\n- Pendência antiga resolvida', '[]');
    select torre.publicar_passagem('T2', current_date - 2, 'antiga 2', null, E'AVISOS\n- ok',
      (select jsonb_agg(jsonb_build_object('id', id, 'status', 'resolvida', 'resolucao', 'Resolvida antes do T04')) from torre.passagem_pendencias where status = 'aberta'));
    commit;`);
  const fotoAntigas = async () => JSON.stringify((await db.query(`select
      (select json_agg(json_build_object('id', id, 'texto', texto_final, 'autor', autor_email, 'em', criado_em) order by criado_em) from torre.passagens_turno) p,
      (select json_agg(json_build_object('id', id, 'texto', texto, 'status', status, 'res', resolucao, 'por', resolvido_email, 'em', resolvido_em) order by ordem) from torre.passagem_pendencias) n`)).rows[0]);
  const antigasAntes = await fotoAntigas();

  const retrato = async (bloco) => JSON.stringify((await db.query(bloco.replace(/^[\s\S]*?(?=select md5)/, ''))).rows[0]);
  const antes = await retrato(item0);

  await db.exec(corpoPrincipal);
  await db.exec(corpoPrincipal);
  ok(true, 'bloco principal do T04 rodou 2x sem erro');

  ok(await fotoAntigas() === antigasAntes, 'passagens e pendências de antes do T04 continuam iguais');
  const nomesAntigos = (await db.query(`select (select count(*)::int from torre.passagens_turno where operador_nome is null) p,
    (select count(*)::int from torre.passagem_pendencias where resolvido_nome is null) n`)).rows[0];
  ok(nomesAntigos.p === 2 && nomesAntigos.n === 1, 'as antigas ficam com o nome vazio (passagens e pendências)', JSON.stringify(nomesAntigos));
  const histAntiga = await db.transaction(async (tx) => {
    await tx.query(ADMIN); await tx.query('set local role authenticated');
    return (await tx.query(`select j from torre.buscar_pendencias('Pendência antiga', null, null, null) j`)).rows[0].j;
  });
  ok(histAntiga && histAntiga.criado_nome === null && histAntiga.resolvido_nome === null && histAntiga.resolvido_email === 'admin@teste.local',
    'histórico da pendência antiga: criado_nome e resolvido_nome vazios (a tela mostra "não informado")', JSON.stringify(histAntiga && { c: histAntiga.criado_nome, r: histAntiga.resolvido_nome }));

  const rodar = async (bloco) => {
    try { await db.exec(bloco); return '(sem erro e sem RESULTADO)'; }
    catch (e) { await db.exec('rollback').catch(() => {}); return e.message.replace(/^RESULTADO( \(nada foi salvo\))?: /, ''); }
  };
  const blocos = conferencias(t04, 7);
  ok(blocos.length === 6, '6 conferências (7.1 a 7.6)', blocos.length);
  const conferir = async (rotulo) => {
    console.log(`\n=== Conferências do T04 (${rotulo}) ===`);
    for (const b of blocos) {
      const l = b.split('\n')[0];
      if (/^-- 7\.6 /.test(l)) continue;
      const esperado = (l.match(/\(esperado: (.*)\)$/) || [])[1];
      const obtido = await rodar(b);
      ok(obtido === esperado, l.replace(/ \(esperado:.*$/, '').replace(/^-- /, ''), obtido === esperado ? undefined : `\n   obtido:   ${obtido}\n   esperado: ${esperado}`);
    }
  };
  await conferir('banco sem pendência aberta');

  // Banco "de verdade" com uma pendência aberta (de uma passagem já com nome)
  await db.exec(`begin; ${ADMIN}
    select torre.publicar_passagem('T3', current_date - 1, 'real', null, E'PENDÊNCIAS PARA O PRÓXIMO TURNO\n- Pendência real aberta', '[]', 'Operador Real');
    commit;`);
  const real = (await db.query(`select count(*)::int n from torre.passagem_pendencias where status = 'aberta'`)).rows[0].n;
  ok(real === 1, 'banco com 1 pendência aberta de verdade', real);
  await conferir('com 1 pendência aberta de verdade');
  const aindaAberta = (await db.query(`select count(*)::int n from torre.passagem_pendencias where status = 'aberta' and texto = 'Pendência real aberta' and resolvido_nome is null`)).rows[0].n;
  ok(aindaAberta === 1, 'a pendência de verdade continua aberta depois das conferências (rollback)', aindaAberta);

  const depois = await retrato(blocos.find(b => b.startsWith('-- 7.6 ')));
  ok(antes === depois, '7.6 igual ao item 0 (public não mudou)', `${antes} / ${depois}`);

  const sobrou = (await db.query(`select (select count(*)::int from torre.passagens_turno) p,
    (select count(*)::int from torre.passagem_pendencias) n, (select count(*)::int from torre.ia_chamadas) c`)).rows[0];
  ok(sobrou.p === 3 && sobrou.n === 2 && sobrou.c === 0, 'nada das conferências ficou salvo (2 passagens antigas + 1 de verdade; 1 pendência antiga + 1 aberta)', JSON.stringify(sobrou));
  ok(await fotoAntigas().then(f => f.startsWith(antigasAntes.slice(0, antigasAntes.indexOf(']')))), 'as 2 passagens antigas continuam iguais no fim');
  await db.close();
  console.log(falhas ? `\n${falhas} FALHA(S)` : '\nTUDO OK');
  process.exit(falhas ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
