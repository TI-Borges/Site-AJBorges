// supabase/sql/torre/T01_copia_planilha.sql num Postgres em WASM (PGlite), com auth.jwt(), is_admin(),
// os papéis do Supabase e um public de mentira (tabela, função, policy, trigger) para o retrato.
// Roda o T01 duas vezes (tem que poder ser reexecutado), as conferências 8.x bloco a bloco como no
// SQL Editor (comparando com o "esperado" de cada uma), confere que nada fora do schema torre é
// criado/alterado (grep + retrato do public antes/depois), o contrato (CONTRATO_DADOS.md = colunas
// das views), os dados de exemplo (gravar, recusar com dados reais, apagar) e o tempo da v_transito
// com 3.000 linhas.
// Uso: node testes/torre/t_torre_sql.js
const fs = require('fs');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');

const RAIZ = process.env.RAIZ || path.resolve(__dirname, '..', '..');
const ler = (a) => fs.readFileSync(path.join(RAIZ, a), 'utf8');
const ateCommit = (sql) => sql.slice(0, sql.indexOf('\ncommit;\n') + '\ncommit;\n'.length);
const MOTORISTA = '11111111-1111-1111-1111-111111111111';
let falhas = 0;
const ok = (cond, msg, extra) => { console.log(`${cond ? 'OK  ' : 'FALHA'} ${msg}${extra !== undefined ? ' -> ' + extra : ''}`); if (!cond) falhas++; };

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
    -- public de mentira: o T01 não pode mexer em nada disto
    create function public.is_admin() returns boolean language sql stable security definer as $$
      select coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') in ('admin', 'diretoria') $$;
    create table public.perfis (id uuid primary key, nome text, role text);
    insert into public.perfis values ('${MOTORISTA}', 'Motorista Teste', 'motorista'),
                                     ('22222222-2222-2222-2222-222222222222', 'Gestão', 'admin');
    alter table public.perfis enable row level security;
    create policy perfis_proprio on public.perfis for select to authenticated using (id = auth.uid() or public.is_admin());
    create table public.fichas_viagem (id text primary key, status text);
    create function public.marcar() returns trigger language plpgsql as $$ begin return new; end $$;
    create trigger trg_marcar before insert on public.fichas_viagem for each row execute function public.marcar();
    grant usage on schema public to anon, authenticated;
    grant select on public.perfis to authenticated;
    grant all on public.fichas_viagem to authenticated;
    alter default privileges in schema public grant select on tables to authenticated;
  `);
  return db;
}

// Executa como admin, motorista ou anon (como o PostgREST faz), sempre desfazendo no fim
async function como(db, quem, q, params = []) {
  const claims = quem === 'admin' ? { sub: '22222222-2222-2222-2222-222222222222', role: 'authenticated', app_metadata: { role: 'admin' } }
    : quem === 'diretoria' ? { sub: '22222222-2222-2222-2222-222222222222', role: 'authenticated', app_metadata: { role: 'diretoria' } }
    : { sub: MOTORISTA, role: 'authenticated' };
  const papel = quem === 'anon' ? 'anon' : quem === 'service_role' ? 'service_role' : 'authenticated';
  await db.exec(`begin; select set_config('request.jwt.claims', '${JSON.stringify(claims)}', true); set local role ${papel};`);
  try { return (await db.query(q, params)).rows; } catch (e) { return 'ERRO: ' + e.message; } finally { await db.exec('rollback'); }
}

(async () => {
  const sql = ler('supabase/sql/torre/T01_copia_planilha.sql');
  const item0 = sql.slice(0, sql.indexOf('\nbegin;\n'));
  const instalacao = ateCommit(sql);
  const conferencias = sql.slice(instalacao.length);

  // --- 1. Só o schema torre (grep) ---
  const ddl = [...instalacao.matchAll(/^\s*(create|alter|grant|revoke|drop|insert|update|delete|truncate|comment)\b[^;]*/gim)].map(m => m[0]);
  const foraDaTorre = ddl.filter(s => !/torre\.|schema (if not exists )?torre|torre_operador_le/i.test(s));
  ok(foraDaTorre.length === 0, 'instalação: todo create/alter/grant/revoke/insert/update/delete é no schema torre', foraDaTorre.join(' || ') || `${ddl.length} comandos`);
  const usosPublic = [...new Set([...sql.matchAll(/public\.[a-z_]+/gi)].map(m => m[0]))].sort();
  ok(usosPublic.join() === 'public.is_admin,public.perfis', 'do public só usa is_admin() (e lê perfis numa conferência)', usosPublic.join());
  const ddlConf = [...conferencias.matchAll(/^\s*(create|alter|grant|revoke|drop|truncate|comment)\b[^;]*/gim)].map(m => m[0]);
  ok(ddlConf.every(s => /pg_temp\./.test(s)), 'conferências só criam função temporária (pg_temp), dentro de begin/rollback', ddlConf.length);

  const db = await novoBanco();
  const retrato = async () => JSON.stringify((await db.query(item0.replace(/^[\s\S]*?(?=select md5)/, ''))).rows[0]);
  const retratoAntes = await retrato();

  // --- 2. Instalação, duas vezes ---
  await db.exec(instalacao);
  await db.exec(instalacao);
  ok(true, 'T01 roda duas vezes sem erro');
  ok((await retrato()) === retratoAntes, 'retrato do public igual antes e depois', retratoAntes);

  // --- 3. Conferências 8.x ---
  const blocos = conferencias.split(/^(?=-- 8\.\d+ )/m).filter(b => /^-- 8\.\d+ /.test(b));
  for (const b of blocos) {
    const titulo = b.split('\n')[0].replace(/^-- /, '').replace(/ \(esperado:.*$/, '');
    const esperado = (b.split('\n')[0].match(/\(esperado: (.*)\)$/) || [])[1] || '';
    if (titulo.startsWith('8.8')) {
      const r = JSON.stringify((await db.query(b.replace(/^--.*\n/gm, ''))).rows[0]);
      ok(r === retratoAntes, titulo, r);
      continue;
    }
    let obtido;
    try { await db.exec(b); obtido = '(sem RESULTADO)'; } catch (e) { obtido = e.message; await db.exec('rollback').catch(() => {}); }
    const valor = obtido.replace(/^RESULTADO( \(nada foi salvo\))?: /, '');
    ok(valor === esperado, titulo, valor === esperado ? undefined : `\n      obtido:   ${valor}\n      esperado: ${esperado}`);
  }
  ok((await retrato()) === retratoAntes, 'retrato do public igual depois das conferências');
  ok(Number((await db.query('select count(*) n from torre.planilha_linhas')).rows[0].n) === 0, 'conferências não deixaram nada gravado');

  // --- 4. Contrato: CONTRATO_DADOS.md lista exatamente as colunas das views ---
  const doc = ler('torre-de-controle-shoppe/CONTRATO_DADOS.md');
  const colsBanco = (await db.query(`select table_name, string_agg(column_name, ',' order by ordinal_position) cols
                                       from information_schema.columns where table_schema = 'torre' and table_name like 'v\\_%'
                                      group by table_name order by table_name`)).rows;
  for (const { table_name, cols } of colsBanco) {
    const sec = doc.split(/^### /m).find(s => s.startsWith('torre.' + table_name + '\n') || s.startsWith('torre.' + table_name + ' '));
    const noDoc = sec ? [...sec.matchAll(/^\| `([a-z0-9_]+)` \|/gm)].map(m => m[1]).join(',') : '(sem seção)';
    ok(noDoc === cols, `contrato ${table_name}`, noDoc === cols ? `${cols.split(',').length} colunas` : `\n      doc:   ${noDoc}\n      banco: ${cols}`);
  }

  // --- 5. Dados de exemplo ---
  const exemplo = ler('supabase/sql/torre/T01_dados_exemplo.sql');
  const apagar = ler('supabase/sql/torre/T01_apagar_dados_exemplo.sql');
  for (const [nome, s] of [['dados_exemplo', exemplo], ['apagar_dados_exemplo', apagar]]) {
    const cmds = [...s.matchAll(/^\s*(create|alter|grant|revoke|drop|insert|update|delete|truncate)\b[^;]*/gim)].map(m => m[0]);
    ok(cmds.every(c => /torre\.|pg_temp\./.test(c)), `${nome}: só mexe no schema torre`, cmds.filter(c => !/torre\.|pg_temp\./.test(c)).join(' || ') || cmds.length);
  }
  await db.exec(exemplo);
  await db.exec(exemplo);
  const contagens = await como(db, 'admin', `select 'v_matriz' v, count(*) n from torre.v_matriz union all select 'v_validacoes', count(*) from torre.v_validacoes
    union all select 'v_origem', count(*) from torre.v_origem union all select 'v_carregamentos', count(*) from torre.v_carregamentos
    union all select 'v_transito', count(*) from torre.v_transito union all select 'v_descargas', count(*) from torre.v_descargas
    union all select 'v_faturamento', count(*) from torre.v_faturamento union all select 'v_links', count(*) from torre.v_links
    union all select 'v_enderecos', count(*) from torre.v_enderecos`);
  ok(Array.isArray(contagens) && contagens.every(r => Number(r.n) > 0), 'exemplo (rodado 2x): as 9 views com linhas', JSON.stringify(contagens.map ? contagens.map(r => `${r.v}=${r.n}`) : contagens));
  const vazios = await como(db, 'admin', `select
      (select count(*) from torre.v_transito where lh is null or motorista is null or status is null) transito_sem_lh_ou_status,
      (select string_agg(distinct coalesce(status_situacao, 'null'), ',' order by coalesce(status_situacao, 'null')) from torre.v_transito) situacoes,
      (select string_agg(distinct etapa, ',' order by etapa) from torre.v_matriz) etapas,
      (select count(*) from torre.v_links where link_url like 'https://%') links_com_url,
      (select row_to_json(c)::text from torre.v_matriz_contadores c) contadores,
      (select row_to_json(s)::text from (select abas, linhas, ultimo_erro, minutos_desde from torre.v_status) s) status,
      (select count(*) from torre.v_transito where motorista !~ '^Motorista Exemplo' or contato <> '(00) 00000-0000') dados_nao_ficticios`);
  console.log('      ', JSON.stringify(vazios[0]));
  const v = vazios[0] || {};
  ok(Number(v.transito_sem_lh_ou_status) === 0, 'exemplo: TRÂNSITO com lh, motorista e status em todas as linhas');
  ok(v.situacoes === 'andamento,atencao,critico,destaque,info,null,ok', 'exemplo: as 6 situações e o sem cor (null) aparecem', v.situacoes);
  ok(v.etapas === 'carregamento,descarga,origem,transito', 'exemplo: MATRIZ com as 4 etapas', v.etapas);
  ok(Number(v.links_com_url) > 0 && /"rotas_ativas":\d+/.test(v.contadores) && /"atualizado_em":"20/.test(v.contadores), 'exemplo: links com URL e contadores da MATRIZ lidos');
  ok(Number(v.dados_nao_ficticios) === 0, 'exemplo: só nomes "Motorista Exemplo" e telefone (00) 00000-0000');
  ok(/"ultimo_erro":"DADOS DE EXEMPLO"/.test(v.status), 'exemplo: v_status mostra que são dados de exemplo');
  ok(JSON.stringify(await como(db, 'anon', 'select count(*) from torre.v_transito')).includes('permission denied') &&
     Number((await como(db, 'motorista', 'select count(*) n from torre.v_transito'))[0].n) === 0 &&
     Number((await como(db, 'diretoria', 'select count(*) n from torre.v_transito'))[0].n) > 0, 'exemplo: anon bloqueado, motorista 0 linhas, diretoria vê');

  // A primeira cópia real substitui o exemplo mesmo com bem menos linhas (sem trava)
  const real = { abas: [{ aba: 'TRÂNSITO', cabecalho: [{ c: 'LH' }], extras: { exemplo: true }, linhas: [{ linha: 2, celulas: [{ c: 'LH', v: 'LT0REAL1' }] }] }] };
  const r1 = (await db.query(`select torre.aplicar_planilha($1) r`, [real])).rows[0].r;
  ok(r1.ok && r1.abas === 1, 'cópia real substitui o exemplo da TRÂNSITO (12 -> 1 linha, sem trava)', JSON.stringify(r1));
  ok((await db.query(`select extras from torre.planilha_abas where aba = 'TRÂNSITO'`)).rows[0].extras.exemplo === undefined, 'payload não consegue se marcar como exemplo (extras.exemplo é descartado)');
  let recusou;
  try { await db.exec(exemplo); recusou = 'GRAVOU (errado)'; } catch (e) { recusou = e.message; await db.exec('rollback').catch(() => {}); }
  ok(/dados reais/.test(recusou), 'exemplo recusa rodar com dados reais', recusou);
  await db.exec(apagar);
  const sobrou = (await db.query(`select aba, linhas from torre.planilha_abas order by aba`)).rows;
  ok(sobrou.length === 1 && sobrou[0].aba === 'TRÂNSITO' && (await db.query(`select count(*) n from torre.sincronizacao where erro = 'DADOS DE EXEMPLO'`)).rows[0].n == 0,
    'apagar exemplo: tira só as abas de exemplo; a TRÂNSITO real fica', JSON.stringify(sobrou));
  ok((await retrato()) === retratoAntes, 'retrato do public igual depois dos dados de exemplo');

  // --- 6. Tempo da v_transito com 3.000 linhas e 26 colunas ---
  const titulos = ['LH', 'MOTORISTA', 'CARGA', 'CONTATO DO MOTORISTA', 'CAVALO', 'CARRETA', 'VÍNCULO', 'ORIGEM', 'DESTINO', 'POSIÇÃO ATUAL',
    'CPT ORIGEM', 'CPT REALIZADO', 'PCT', 'KM/H', 'T PARADA', 'TOTAL PARADA', 'Macro', 'ATUALIZAÇÃO', 'PREVISÃO DE CHEGADA', 'ETA DESTINO',
    'T CHEGADA', 'STATUS', 'PROGRESSÃO VIAGEM', 'FATURAMENTO', 'CIOT / VPO', 'SM'];
  const grande = { abas: [{ aba: 'TRÂNSITO', cabecalho: titulos.map(c => ({ c })), extras: {},
    linhas: Array.from({ length: 3000 }, (_, i) => ({ linha: i + 2, celulas: titulos.map((c, j) => ({ c, v: `${c} ${i}`, ...(j % 3 === 0 ? { bg: '#f4cccc' } : {}) })) })) }] };
  const r2 = (await db.query(`select torre.aplicar_planilha($1) r`, [grande])).rows[0].r;
  ok(r2.ok && r2.linhas === 3000, 'RPC aceita 3.000 linhas', JSON.stringify(r2));
  const t0 = Date.now();
  const todas = await como(db, 'admin', 'select * from torre.v_transito');
  const ms = Date.now() - t0;
  ok(Array.isArray(todas) && todas.length === 3000 && todas[2999].ciot_vpo === 'CIOT / VPO 2999' && todas[0].lh_situacao === 'critico',
    `v_transito com 3.000 linhas (${ms} ms no PGlite)`);

  console.log(`\n${falhas ? falhas + ' FALHA(S)' : 'TUDO OK'}`);
  process.exit(falhas ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
