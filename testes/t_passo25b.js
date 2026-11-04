// supabase/sql/passo25b_avaliacao.sql num Postgres em WASM (PGlite), depois do passo25, com auth.jwt(),
// is_admin() e a RLS de leitura simulados como no Supabase e cadastros INVENTADOS. Roda como no SQL Editor:
// item 0, principal (duas vezes), conferências 7.x (cada RESULTADO comparado com o "esperado") e 7.6,
// que tem que dar igual ao item 0. Confere também que os existentes não mudam e ficam "Sem avaliação"
// e que o "Salvar dados" do dashboard (update direto de dados/nome/celular) continua funcionando.
// Uso: node testes/t_passo25b.js
const fs = require('fs');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');

const RAIZ = process.env.RAIZ || path.resolve(__dirname, '..');
const ADMIN = '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated","email":"admin@teste.local","app_metadata":{"role":"admin"}}';
const MOTORISTA = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated","app_metadata":{"role":"motorista"}}';
const NOVAS = "array['avaliacao', 'avaliacao_motivo', 'avaliado_por', 'avaliado_em']";

(async () => {
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
      ('pf', 'pendente', 'Beltrano de Teste', '00000000191', '11900000001', true, '{"a": 1}', '[{"campo": "cnh", "path": "terceiros/x/cnh_1_a.pdf"}]', now() - interval '3 days'),
      ('pf', 'analise',  'Beltrano de Teste', '00000000191', '11900000001', true, '{}', '[]', now() - interval '2 days'),
      ('pj', 'recusado', 'Ciclano de Teste',  '00000000272', '11900000002', false, '{"cnpj": "11.222.333/0001-81"}', '[]', now() - interval '1 day');
    -- RLS de hoje (simulada): só a gestão lê; o dashboard faz update direto de dados/nome/celular
    alter table public.cadastros_agregados enable row level security;
    create policy gestao_le_cadastros on public.cadastros_agregados for select to authenticated using (public.is_admin());
    create policy gestao_altera_cadastros on public.cadastros_agregados for update to authenticated using (public.is_admin());
    grant select, update on public.cadastros_agregados to authenticated;
  `);

  const sql25 = fs.readFileSync(path.join(RAIZ, 'supabase/sql/passo25_cadastro_unico.sql'), 'utf8');
  await db.exec(sql25.match(/^begin;\n[\s\S]*?^commit;/m)[0]);

  const sql = fs.readFileSync(path.join(RAIZ, 'supabase/sql/passo25b_avaliacao.sql'), 'utf8');
  const r = { erros: [] };
  const codigo = sql.replace(/--.*$/gm, '').replace(/'(?:[^']|'')*'/g, "''");
  const foraDosTestes = codigo.split('do $$')[0];
  r.semApagar = !/\b(truncate|delete)\b/i.test(codigo);
  // O único update fora das conferências é o da RPC, que grava só as colunas da avaliação
  const updates = foraDosTestes.replace(/before insert or update/i, '').match(/\bupdate\b[^;]*;/gi) || [];
  r.semUpdateForaDasConferencias = updates.length === 1 &&
    /^update public\.cadastros_agregados\s+set avaliacao = v_avaliacao,\s+avaliacao_motivo = [^,]*\s+where id = p_id\s+returning/i.test(updates[0]);
  r.semPolicyNova = !/create\s+policy/i.test(codigo);
  r.conferenciasTerminamEmRollback = sql.split(/^-- 7\.[2-5] /m).slice(1).every((b) => /\nrollback;\s*(\n|$)/.test(b));

  const item0 = sql.match(/^-- -+\n-- 0\. ANTES[\s\S]*?(?=^begin;)/m)[0];
  const principal = sql.match(/^begin;\n[\s\S]*?^commit;/m)[0];
  const conferencias = sql.split(/^(?=-- 7\.\d )/m).filter((b) => /^-- 7\.\d /.test(b));
  const linhas = async (bloco) => { const res = await db.exec(bloco); const u = res[res.length - 1]; return u && u.rows ? u.rows : []; };
  const foto = async () => JSON.stringify((await db.query('select * from public.cadastros_agregados order by id')).rows);
  const fotoSemNovas = async () => JSON.stringify((await db.query(`select (to_jsonb(c) - ${NOVAS}) j from public.cadastros_agregados c order by id`)).rows);
  const fotoArquivos = async () => JSON.stringify((await db.query('select * from storage.objects order by id')).rows);

  const linhasAntes = await foto();
  const semNovasAntes = await fotoSemNovas();
  const arquivosAntes = await fotoArquivos();
  const antes = (await linhas(item0))[0];
  r.item0 = antes;

  await db.exec(principal);
  await db.exec(principal);
  r.principalReexecutavel = true;
  r.existentesIguaisForaColunasNovas = (await fotoSemNovas()) === semNovasAntes;
  r.existentesSemAvaliacao = Number((await db.query('select count(*) n from public.cadastros_agregados where avaliacao is not null or avaliacao_motivo is not null or avaliado_por is not null or avaliado_em is not null')).rows[0].n) === 0;
  const depoisDoPrincipal = await fotoSemNovas();

  const pares = (texto) => Object.fromEntries(texto.split(' | ').map((p) => { const i = p.indexOf('='); return [p.slice(0, i).trim(), p.slice(i + 1).trim()]; }));
  r.conferencias = {};
  for (const bloco of conferencias) {
    const titulo = bloco.split('\n')[0].replace(/^-- /, '');
    const esperado = (titulo.match(/\(esperado: (.*)\)\s*$/) || [])[1];
    try {
      const rows = await linhas(bloco);
      r.conferencias[titulo.slice(0, 4)] = rows.map((l) => Object.values(l).join(' | '));
      if (titulo.startsWith('7.6')) r.item76IgualAoItem0 = JSON.stringify(rows[0]) === JSON.stringify(antes);
      else r.erros.push(`${titulo.slice(0, 4)}: não deu RESULTADO`);
    } catch (e) {
      await db.exec('rollback').catch(() => {});
      await db.exec('reset role').catch(() => {});
      const msg = e.message;
      r.conferencias[titulo.slice(0, 4)] = msg;
      if (!/^RESULTADO/.test(msg)) { r.erros.push(`${titulo.slice(0, 4)}: ${msg}`); continue; }
      const obtido = pares(msg.replace(/^RESULTADO( \([^)]*\))?: /, ''));
      const numeros = {};
      for (const [k, v] of Object.entries(pares(esperado))) {
        if (/^[NM]$/.test(v)) {
          if (numeros[v] === undefined) numeros[v] = obtido[k];
          if (obtido[k] !== numeros[v]) r.erros.push(`${titulo.slice(0, 4)} ${k}: ${obtido[k]} (esperado o mesmo ${v})`);
        } else if (obtido[k] !== v) {
          r.erros.push(`${titulo.slice(0, 4)} ${k}: ${obtido[k]} (esperado ${v})`);
        }
      }
    }
  }
  r.depoisDasConferenciasIgual = (await fotoSemNovas()) === depoisDoPrincipal &&
    Number((await db.query('select count(*) n from public.cadastros_agregados where avaliacao is not null or avaliado_por is not null')).rows[0].n) === 0;
  r.arquivosIguais = (await fotoArquivos()) === arquivosAntes;

  // O "Salvar dados" do dashboard (update direto de dados/nome/celular pelo admin) continua igual,
  // e a avaliação feita pela RPC fica; tudo desfeito no fim
  await db.exec('begin');
  await db.query(`select set_config('request.jwt.claims', $1, true)`, [ADMIN]);
  await db.exec('set local role authenticated');
  const id = (await db.query(`select id from public.cadastros_agregados where status = 'pendente' limit 1`)).rows[0].id;
  r.dashboard = {};
  r.dashboard.avaliar = (await db.query(`select public.avaliar_cadastro($1, 'inapto', '<script>x</script>') j`, [id])).rows[0].j;
  await db.query(`update public.cadastros_agregados set dados = '{"a": 2}', nome = 'Beltrano de Teste 2' where id = $1`, [id]);
  r.dashboard.salvarDadosNaoMexeNaAvaliacao = (await db.query('select avaliacao, avaliacao_motivo, avaliado_por from public.cadastros_agregados where id = $1', [id])).rows[0];
  await db.exec('reset role');
  await db.exec('rollback');
  r.linhasIguaisNoFim = (await fotoSemNovas()) === depoisDoPrincipal;

  console.log(JSON.stringify(r, null, 2));
  const ok = !r.erros.length && r.semApagar && r.semUpdateForaDasConferencias && r.semPolicyNova && r.conferenciasTerminamEmRollback &&
    r.existentesIguaisForaColunasNovas && r.existentesSemAvaliacao && r.item76IgualAoItem0 && r.depoisDasConferenciasIgual &&
    r.arquivosIguais && r.linhasIguaisNoFim && r.dashboard.avaliar.avaliacao === 'inapto' &&
    r.dashboard.salvarDadosNaoMexeNaAvaliacao.avaliacao === 'inapto' && r.dashboard.salvarDadosNaoMexeNaAvaliacao.avaliado_por === 'admin@teste.local';
  console.log(ok ? 'OK' : 'FALHOU');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
