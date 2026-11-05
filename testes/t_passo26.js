// supabase/sql/passo26_anotacoes.sql num Postgres em WASM (PGlite), depois do passo25, com auth.jwt(), is_admin() e a
// RLS de leitura simulados como no Supabase e cadastros INVENTADOS. Dois cenários: banco SEM o passo 25b (o que a
// gestão decidiu não usar) e banco COM o 25b e um cadastro já avaliado. Em cada um, roda como no SQL Editor: item 0,
// principal (duas vezes), conferências 7.1 a 7.5 (cada RESULTADO comparado com o "esperado"; N e M = números do item 0),
// 7.6 (tem que dar igual ao item 0) e a consulta só de leitura do item 9 (quantos têm avaliação). Confere também que o
// arquivo não tem update/delete/truncate/drop fora das conferências e que o "Salvar dados" do dashboard (update
// direto de dados/nome/celular) continua funcionando sem mexer na anotação.
// Uso: node testes/t_passo26.js
const fs = require('fs');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');

const RAIZ = process.env.RAIZ || path.resolve(__dirname, '..');
const ADMIN = '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated","email":"admin@teste.local","app_metadata":{"role":"admin"}}';
const NOVAS = "array['anotacoes', 'anotado_por', 'anotado_em']";
const ler = (a) => fs.readFileSync(path.join(RAIZ, a), 'utf8');

async function cenario(com25b) {
  const db = new PGlite();
  await db.exec(`
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$
      select (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid $$;
    create function auth.jwt() returns jsonb language sql stable as $$
      select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb) $$;
    create role authenticated; create role anon; create role service_role;
    grant usage on schema public, auth to anon, authenticated;
    grant execute on all functions in schema auth to anon, authenticated;
    create function public.is_admin() returns boolean language sql stable security definer as $$
      select coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') in ('admin', 'diretoria') $$;
    create schema storage;
    create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text);
    insert into storage.objects (bucket_id, name) values
      ('documentos-cadastro', 'terceiros/x/cnh_1_a.pdf'), ('documentos-cadastro', 'terceiros/y/cnh_1_b.pdf');
    create table public.cadastros_agregados (
      id uuid primary key default gen_random_uuid(), user_id uuid, tipo text, status text, nome text, cpf text,
      email text, celular text, sem_carreta boolean, dados jsonb, documentos jsonb, etapas jsonb default '{}',
      motivo_recusa text, analisado_por text, analisado_em timestamptz, criado_em timestamptz default now());
    insert into public.cadastros_agregados (tipo, status, nome, cpf, celular, sem_carreta, dados, documentos, criado_em) values
      ('pf', 'aprovado', 'Beltrano de Teste', '00000000191', '(11) 90000-0001', true, '{"a": 1}', '[{"campo": "cnh", "path": "terceiros/x/cnh_1_a.pdf"}]', now() - interval '3 days'),
      ('pj', 'recusado', 'Ciclano de Teste',  '00000000272', '11900000002', false, '{"cnpj": "11.222.333/0001-81"}', '[]', now() - interval '1 day');
    alter table public.cadastros_agregados enable row level security;
    create policy gestao_le_cadastros on public.cadastros_agregados for select to authenticated using (public.is_admin());
    create policy gestao_altera_cadastros on public.cadastros_agregados for update to authenticated using (public.is_admin());
    grant select, update on public.cadastros_agregados to authenticated;
  `);
  await db.exec(ler('supabase/sql/passo25_cadastro_unico.sql').match(/^begin;\n[\s\S]*?^commit;/m)[0]);
  if (com25b) {
    await db.exec(ler('supabase/sql/passo25b_avaliacao.sql').match(/^begin;\n[\s\S]*?^commit;/m)[0]);
    // um cadastro já avaliado "inapto" com motivo (a anotação antiga que o dashboard mostra só para leitura)
    await db.exec(`begin; select set_config('request.jwt.claims', '${ADMIN}', true);
      update public.cadastros_agregados set avaliacao = 'inapto', avaliacao_motivo = 'Placa divergente' where nome = 'Beltrano de Teste'; commit;`);
  }

  const sql = ler('supabase/sql/passo26_anotacoes.sql');
  const r = { erros: [] };
  const codigo = sql.replace(/--.*$/gm, '').replace(/'(?:[^']|'')*'/g, "''");
  const item0 = sql.match(/^-- -+\n-- 0\. ANTES[\s\S]*?(?=^begin;)/m)[0];
  const principal = sql.match(/^begin;\n[\s\S]*?^commit;/m)[0];
  const principalCodigo = principal.replace(/--.*$/gm, '').replace(/'(?:[^']|'')*'/g, "''");
  r.semApagar = !/\b(truncate|delete|drop)\b/i.test(codigo);
  // O único update do principal é o da RPC, que grava só a anotação
  const updates = principalCodigo.replace(/before insert or update/gi, '').match(/\bupdate\b[^;]*;/gi) || [];
  r.semUpdateForaDaRpc = updates.length === 1 && /^update public\.cadastros_agregados\s+set anotacoes = v_texto\s+where id = p_id\s+returning/i.test(updates[0]);
  r.semPolicyNova = !/create\s+policy/i.test(codigo);
  r.conferenciasTerminamEmRollback = sql.split(/^-- 7\.[2-5] /m).slice(1).every((b) => /\nrollback;\s*(\n|$)/.test(b.split(/^-- (7\.\d|=+)/m)[0]));

  const conferencias = sql.split(/^(?=-- 7\.\d )/m).filter((b) => /^-- 7\.\d /.test(b)).map(b => b.split(/^-- =+$/m)[0]);
  const item9 = sql.slice(sql.indexOf('select (select count(*) from information_schema.columns'));
  const linhas = async (bloco) => { const res = await db.exec(bloco); const u = res[res.length - 1]; return u && u.rows ? u.rows : []; };
  const fotoSemNovas = async () => JSON.stringify((await db.query(`select (to_jsonb(c) - ${NOVAS}) j from public.cadastros_agregados c order by id`)).rows);
  const fotoArquivos = async () => JSON.stringify((await db.query('select * from storage.objects order by id')).rows);

  const semNovasAntes = await fotoSemNovas();
  const arquivosAntes = await fotoArquivos();
  const antes = (await linhas(item0))[0];
  r.item0 = antes;

  await db.exec(principal);
  await db.exec(principal);
  r.principalReexecutavel = true;
  r.existentesIguaisForaColunasNovas = (await fotoSemNovas()) === semNovasAntes;
  r.existentesSemAnotacao = Number((await db.query('select count(*) n from public.cadastros_agregados where anotacoes is not null or anotado_por is not null or anotado_em is not null')).rows[0].n) === 0;
  const depoisDoPrincipal = await fotoSemNovas();

  const pares = (texto) => Object.fromEntries(texto.split(' | ').map((p) => { const i = p.indexOf('='); return [p.slice(0, i).trim(), p.slice(i + 1).trim()]; }));
  r.conferencias = {};
  for (const bloco of conferencias) {
    const titulo = bloco.split('\n')[0].replace(/^-- /, '');
    const chave = titulo.slice(0, 3);
    const esperado = (titulo.match(/\(esperado: (.*)\)\s*$/) || [])[1];
    try {
      const rows = await linhas(bloco);
      r.conferencias[chave] = rows;
      if (chave === '7.6') r.item76IgualAoItem0 = JSON.stringify(rows[0]) === JSON.stringify(antes);
      else r.erros.push(`${chave}: não deu RESULTADO`);
    } catch (e) {
      await db.exec('rollback').catch(() => {});
      await db.exec('reset role').catch(() => {});
      const msg = e.message;
      r.conferencias[chave] = msg;
      if (!/^RESULTADO/.test(msg)) { r.erros.push(`${chave}: ${msg}`); continue; }
      const obtido = pares(msg.replace(/^RESULTADO( \([^)]*\))?: /, ''));
      for (const [k, v] of Object.entries(pares(esperado))) {
        const alvo = v === 'N' ? String(antes.cadastros) : v === 'M' ? String(antes.arquivos) : v;
        if (obtido[k] !== alvo) r.erros.push(`${chave} ${k}: ${obtido[k]} (esperado ${alvo})`);
      }
    }
  }
  r.depoisDasConferenciasIgual = (await fotoSemNovas()) === depoisDoPrincipal;
  r.arquivosIguais = (await fotoArquivos()) === arquivosAntes;
  r.item9 = (await db.query(item9)).rows[0];

  // "Salvar dados" do dashboard (update direto de dados/nome/celular pela gestão) continua igual e não mexe
  // na anotação; a anotação pela RPC fica com o texto e as quebras de linha; tudo desfeito no fim
  await db.exec('begin');
  await db.query(`select set_config('request.jwt.claims', $1, true)`, [ADMIN]);
  await db.exec('set local role authenticated');
  const id = (await db.query(`select id from public.cadastros_agregados where status = 'aprovado' limit 1`)).rows[0].id;
  r.dashboard = {};
  r.dashboard.anotar = (await db.query(`select public.anotar_cadastro($1, E'<script>x</script>\nlinha 2') j`, [id])).rows[0].j;
  await db.query(`update public.cadastros_agregados set dados = '{"a": 2}', nome = 'Beltrano de Teste 2' where id = $1`, [id]);
  r.dashboard.salvarDadosNaoMexeNaAnotacao = (await db.query('select anotacoes, anotado_por from public.cadastros_agregados where id = $1', [id])).rows[0];
  await db.exec('reset role');
  await db.exec('rollback');
  r.linhasIguaisNoFim = (await fotoSemNovas()) === depoisDoPrincipal;

  const ok = !r.erros.length && r.semApagar && r.semUpdateForaDaRpc && r.semPolicyNova && r.conferenciasTerminamEmRollback &&
    r.existentesIguaisForaColunasNovas && r.existentesSemAnotacao && r.item76IgualAoItem0 && r.depoisDasConferenciasIgual &&
    r.arquivosIguais && r.linhasIguaisNoFim && r.dashboard.anotar.anotacoes === '<script>x</script>\nlinha 2' &&
    r.dashboard.salvarDadosNaoMexeNaAnotacao.anotacoes === '<script>x</script>\nlinha 2' &&
    r.dashboard.salvarDadosNaoMexeNaAnotacao.anotado_por === 'admin@teste.local' &&
    Number(r.item9.colunas_do_25b) === (com25b ? 2 : 0) && Number(r.item9.com_avaliacao_ou_motivo) === (com25b ? 1 : 0);
  return { r, ok };
}

(async () => {
  let tudoOk = true;
  for (const com25b of [false, true]) {
    const { r, ok } = await cenario(com25b);
    console.log(`\n===== ${com25b ? 'COM' : 'SEM'} o passo 25b =====`);
    console.log(JSON.stringify(r, null, 2));
    console.log(ok ? 'OK' : 'FALHOU');
    tudoOk = tudoOk && ok;
  }
  console.log(tudoOk ? '\nOK' : '\nFALHOU');
  process.exit(tudoOk ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
