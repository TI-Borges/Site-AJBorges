// supabase/sql/passo25_cadastro_unico.sql num Postgres em WASM (PGlite), com uma cadastros_agregados
// simulada e cadastros INVENTADOS (inclusive dois CPFs e um CNPJ já duplicados, como os de hoje).
// Roda os blocos como no SQL Editor: item 0, principal, conferências 7.x (cada RESULTADO é comparado
// com o "esperado" do comentário) e 7.6, que tem que dar igual ao item 0.
// Uso: node testes/t_passo25.js
const fs = require('fs');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');

const RAIZ = process.env.RAIZ || path.resolve(__dirname, '..');

(async () => {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema storage;
    create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text);
    insert into storage.objects (bucket_id, name) values
      ('documentos-cadastro', 'terceiros/x/cnh_1_a.pdf'), ('documentos-cadastro', 'terceiros/y/cnh_1_b.pdf'),
      ('outro-bucket', 'qualquer.pdf');
    create table public.cadastros_agregados (
      id uuid primary key default gen_random_uuid(), user_id uuid, tipo text, status text, nome text, cpf text,
      email text, celular text, sem_carreta boolean, dados jsonb, documentos jsonb, etapas jsonb default '{}',
      analisado_em timestamptz, criado_em timestamptz default now());
    insert into public.cadastros_agregados (tipo, status, nome, cpf, celular, sem_carreta, dados, criado_em) values
      ('pf', 'pendente', 'Beltrano de Teste', '00000000191', '11900000001', true, '{}', now() - interval '9 days'),
      ('pf', 'analise',  'Beltrano de Teste', '00000000191', '11900000001', true, '{}', now() - interval '8 days'),
      ('pf', 'recusado', 'Beltrano de Teste', '00000000191', '11900000001', true, '{}', now() - interval '7 days'),
      ('pf', 'aprovado', 'Fulano de Teste',   '00000000272', '11900000002', true, '{}', now() - interval '6 days'),
      ('pf', 'pendente', 'Fulano de Teste',   '00000000272', '11900000002', true, '{}', now() - interval '5 days'),
      ('pf', 'recusado', 'Sicrano de Teste',  '00000000353', '11900000003', true, '{}', now() - interval '4 days'),
      ('pf', 'recusado', 'Sicrano de Teste',  '00000000353', '11900000003', true, '{}', now() - interval '4 days'),
      ('pj', 'pendente', 'Ciclano de Teste',  '00000000434', '11900000004', false, '{"cnpj": "11.222.333/0001-81"}', now() - interval '3 days'),
      ('pj', 'aprovado', 'Outro de Teste',    '00000000515', '11900000005', false, '{"cnpj": "11222333000181"}', now() - interval '2 days'),
      ('pj', 'pendente', 'Mais um de Teste',  '00000000191', '11900000006', false, '{"cnpj": ""}', now() - interval '1 day');
  `);

  const sql = fs.readFileSync(path.join(RAIZ, 'supabase/sql/passo25_cadastro_unico.sql'), 'utf8');
  const r = { erros: [] };

  // Nada de delete/truncate em lugar nenhum, nem update fora das conferências (que terminam em rollback);
  // comentários e textos entre aspas não contam
  const codigo = sql.replace(/--.*$/gm, '').replace(/'(?:[^']|'')*'/g, "''");
  const foraDosTestes = codigo.split('do $$')[0];
  r.semApagarNemAlterarLinhas = !/\b(truncate|delete)\b/i.test(codigo) && !/\bupdate\b/i.test(foraDosTestes);
  r.semIndiceUnico = !/create\s+unique\s+index/i.test(sql);
  r.conferenciasTerminamEmRollback = sql.split(/^-- 7\.[2-4] /m).slice(1).every((b) => /\nrollback;\s*(\n|$)/.test(b));

  const item0 = sql.match(/^-- 0\. ANTES[\s\S]*?(?=^-- -+\n-- 0\.1 )/m)[0];
  const item01 = sql.match(/^-- 0\.1 [\s\S]*?(?=^-- -+\n-- 0\.2 )/m)[0];
  const item02 = sql.match(/^-- 0\.2 [\s\S]*?(?=^begin;)/m)[0];
  const principal = sql.match(/^begin;\n[\s\S]*?^commit;/m)[0];
  const conferencias = sql.split(/^(?=-- 7\.\d )/m).filter((b) => /^-- 7\.\d /.test(b));

  const linhas = async (bloco) => { const res = await db.exec(bloco); const u = res[res.length - 1]; return u && u.rows ? u.rows : []; };
  const fotoLinhas = async () => JSON.stringify((await db.query('select * from public.cadastros_agregados order by id')).rows);
  const fotoArquivos = async () => JSON.stringify((await db.query('select * from storage.objects order by id')).rows);

  const linhasAntes = await fotoLinhas();
  const arquivosAntes = await fotoArquivos();
  const antes = (await linhas(item0))[0];
  r.item0 = antes;
  r.item01_gatilhos_antes = (await linhas(item01)).length;
  r.item02 = (await linhas(item02)).map((l) => Object.values(l).join(' | '));

  await db.exec(principal);
  // Reexecutar o principal não quebra (create or replace / drop if exists)
  await db.exec(principal);
  r.principalReexecutavel = true;

  // "esperado: a=b | c=d" -> { a: 'b', c: 'd' }; N e M = "o mesmo número dos dois lados"
  const pares = (texto) => Object.fromEntries(texto.split(' | ').map((p) => { const i = p.indexOf('='); return [p.slice(0, i).trim(), p.slice(i + 1).trim()]; }));
  r.conferencias = {};
  for (const bloco of conferencias) {
    const titulo = bloco.split('\n')[0].replace(/^-- /, '');
    const esperado = (titulo.match(/\(esperado: (.*)\)\s*$/) || [])[1];
    try {
      const rows = await linhas(bloco);
      r.conferencias[titulo.slice(0, 4)] = rows.map((l) => Object.values(l).join(' | '));
      if (titulo.startsWith('7.6')) {
        r.item76IgualAoItem0 = JSON.stringify(rows[0]) === JSON.stringify(antes);
      } else if (titulo.startsWith('7.5')) {
        r.item75IgualAo02Ativos = JSON.stringify(rows.map((l) => Object.values(l).join(' | '))) ===
          JSON.stringify(r.item02.filter((l) => l.startsWith('ativos ')));
      }
    } catch (e) {
      await db.exec('rollback').catch(() => {});
      const msg = e.message;
      r.conferencias[titulo.slice(0, 4)] = msg;
      if (!/^RESULTADO/.test(msg)) { r.erros.push(`${titulo.slice(0, 4)}: ${msg}`); continue; }
      if (!esperado) continue;
      const obtido = pares(msg.replace(/^RESULTADO( \([^)]*\))?: /, ''));
      const quer = pares(esperado);
      const numeros = {};
      for (const [k, v] of Object.entries(quer)) {
        if (/^[NM]$/.test(v)) {
          if (numeros[v] === undefined) numeros[v] = obtido[k];
          if (obtido[k] !== numeros[v]) r.erros.push(`${titulo.slice(0, 4)} ${k}: ${obtido[k]} (esperado o mesmo ${v} = ${numeros[v]})`);
        } else if (obtido[k] !== v) {
          r.erros.push(`${titulo.slice(0, 4)} ${k}: ${obtido[k]} (esperado ${v})`);
        }
      }
    }
  }

  r.linhasIguais = (await fotoLinhas()) === linhasAntes;
  r.arquivosIguais = (await fotoArquivos()) === arquivosAntes;

  // Fora das conferências: o trigger de verdade, como a edge function grava
  const inserir = (tipo, status, cpf, cnpj) => db.query(
    `insert into public.cadastros_agregados (tipo, status, nome, cpf, celular, sem_carreta, dados)
     values ($1, $2, 'Novo de Teste', $3, '11900000009', true, $4) returning id`, [tipo, status, cpf, JSON.stringify(cnpj ? { cnpj } : {})])
    .then(() => 'aceito', (e) => (e.code === '23505' ? `recusado: ${e.message}` : `ERRO ${e.code} ${e.message}`));
  // Cada insert num savepoint, como cada chamada da edge function é uma transação própria
  const tentar = async (...a) => {
    await db.exec('savepoint s');
    const v = await inserir(...a);
    await db.exec(v === 'aceito' ? 'release savepoint s' : 'rollback to savepoint s');
    return v;
  };
  await db.exec('begin');
  r.trigger = {
    cpf_ja_duplicado_hoje: await tentar('pf', 'pendente', '000.000.001-91'),
    cpf_so_com_recusados: await tentar('pf', 'pendente', '00000000353'),
    cpf_novo: await tentar('pf', 'pendente', '00000000604'),
    cpf_novo_de_novo: await tentar('pf', 'pendente', '000.000.006-04'),
    cnpj_ja_duplicado_hoje: await tentar('pj', 'pendente', '00000000999', '11 222 333 0001 81'),
    pj_sem_cnpj: await tentar('pj', 'pendente', '00000000999', ''),
    tipo_nulo_conta_como_pf: await tentar(null, 'pendente', '00000000604')
  };
  await db.exec('rollback');
  r.linhasIguaisNoFim = (await fotoLinhas()) === linhasAntes;

  console.log(JSON.stringify(r, null, 2));
  const ok = !r.erros.length && r.semApagarNemAlterarLinhas && r.semIndiceUnico && r.conferenciasTerminamEmRollback &&
    r.item76IgualAoItem0 && r.item75IgualAo02Ativos && r.linhasIguais && r.arquivosIguais && r.linhasIguaisNoFim &&
    r.trigger.cpf_ja_duplicado_hoje.startsWith('recusado') && r.trigger.cpf_so_com_recusados === 'aceito' &&
    r.trigger.cpf_novo === 'aceito' && r.trigger.cpf_novo_de_novo.startsWith('recusado') &&
    r.trigger.cnpj_ja_duplicado_hoje.startsWith('recusado') && r.trigger.pj_sem_cnpj === 'aceito' &&
    r.trigger.tipo_nulo_conta_como_pf.startsWith('recusado');
  console.log(ok ? 'OK' : 'FALHOU');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
