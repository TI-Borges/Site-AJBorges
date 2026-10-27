// supabase/sql/passo20_cadastro_docs.sql num Postgres em WASM (PGlite), com uma cadastros_agregados
// simulada (colunas que a edge function usa) e dois cadastros INVENTADOS no formato de hoje. Roda os
// blocos como no SQL Editor e confere que os existentes ficam iguais e que nada foi gravado.
const fs = require('fs');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');

const RAIZ = process.env.RAIZ || path.resolve(__dirname, '..');

(async () => {
  const db = new PGlite();
  await db.exec(`
    create schema storage;
    create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text);
    insert into storage.objects (bucket_id, name) values ('documentos-cadastro', 'terceiros/y/cnh_1_a.pdf');
    create table public.cadastros_agregados (
      id uuid primary key default gen_random_uuid(), user_id uuid, tipo text, status text, nome text, cpf text,
      email text, celular text, sem_carreta boolean, dados jsonb, documentos jsonb, etapas jsonb,
      criado_em timestamptz default now());
    insert into public.cadastros_agregados (tipo, status, nome, cpf, celular, sem_carreta, dados, documentos, criado_em) values
      ('pf', 'pendente', 'Beltrano de Teste', '00000000191', '11900000001', true,
       '{"_tipologia": "Cavalo 6×2", "_sem_pdf": {"cnh": true}, "cnh-registro": "123"}',
       '[{"campo": "crlv_1", "path": "terceiros/x/crlv_1_1_a.pdf"}]', now() - interval '2 days'),
      ('pj', 'analise', 'Ciclano de Teste', '00000000272', '11900000002', false,
       '{"_tipologia": "Bitrem", "_sem_pdf": {}}',
       '[{"campo": "cnh", "path": "terceiros/y/cnh_1_a.pdf"}, {"campo": "rntrc", "path": "terceiros/y/rntrc_2_b.pdf"}]', now() - interval '1 day');
  `);
  const sql = fs.readFileSync(path.join(RAIZ, 'supabase/sql/passo20_cadastro_docs.sql'), 'utf8');
  const r = {};
  r.semMudancaNoBanco = !/^\s*(create|alter|drop|truncate|grant|revoke)\b/im.test(sql) &&
    !/^\s*(update|delete|insert)\b/im.test(sql.replace(/do \$\$[\s\S]*?end \$\$;/g, ''));
  const blocos = sql.split(/^(?=-- \d\. )/m).filter((b) => /^-- \d\. /.test(b));
  const fotografia = async () => JSON.stringify((await db.query('select id, nome, status, dados, documentos from public.cadastros_agregados order by criado_em')).rows);
  const antes = await fotografia();
  r.blocos = {};
  for (const b of blocos) {
    const titulo = b.split('\n')[0].replace(/^-- /, '');
    try {
      const res = await db.exec(b);
      const ultimo = res[res.length - 1];
      r.blocos[titulo] = ultimo && ultimo.rows ? ultimo.rows.map((l) => Object.values(l).join(' | ')) : '(sem linhas)';
    } catch (e) {
      r.blocos[titulo] = e.message;
      await db.exec('rollback').catch(() => {});
    }
  }
  r.existentesIguais = (await fotografia()) === antes;
  r.linhasNoFim = Number((await db.query('select count(*) n from public.cadastros_agregados')).rows[0].n);
  console.log(JSON.stringify(r, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
