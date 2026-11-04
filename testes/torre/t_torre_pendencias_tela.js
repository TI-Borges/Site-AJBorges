// Pendências da passagem de turno (T03) na tela da Torre, com a IA SIMULADA e o banco num PGlite com
// T01 + T02 + T03 (cada consulta/RPC roda como authenticated com o JWT do usuário: quem decide é a RLS).
// Infraestrutura igual à do t_torre_passagem_tela.js. Confere: cada item de "PENDÊNCIAS PARA O PRÓXIMO
// TURNO" vira pendência aberta ligada à passagem e ao turno; o turno seguinte vê as herdadas e só publica
// depois de fechar cada uma (Resolvida/Continua + "Como foi resolvido"); o que foi marcado sobrevive a
// trocar de aba; "Continua" passa para o próximo turno; tela "Histórico de pendências" com busca por
// texto (também na resolução), turno, data e status; aviso das sugestões de tratativa no "Gerar";
// motorista não entra; 1366/390 px; escapeHtml. Print em testes/capturas/torre_pendencias_herdadas_390.png.
// Uso: node testes/torre/t_torre_pendencias_tela.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');
const { PGlite } = require('@electric-sql/pglite');

const RAIZ = path.resolve(__dirname, '..', '..');
const TORRE = '/torre-de-controle-shoppe/HTML/index.html';
const SUBS = {
  admin: '00000000-0000-0000-0000-0000000000c3',
  diretoria: '00000000-0000-0000-0000-0000000000d4',
  motorista: '11111111-1111-1111-1111-111111111111'
};
const XSS = '<img src=x onerror="window.__xss=1">';
let falhas = 0;
const ok = (cond, msg, extra) => { console.log(`${cond ? 'OK  ' : 'FALHA'} ${msg}${extra !== undefined ? ` (${typeof extra === 'string' ? extra : JSON.stringify(extra)})` : ''}`); if (!cond) falhas++; };
const esperar = (ms) => new Promise(r => setTimeout(r, ms));
const ateCommit = (sql) => sql.slice(0, sql.indexOf('\ncommit;\n') + '\ncommit;\n'.length);

const SUPABASE_FALSO = `
window.supabase = { createClient: () => {
  const SUBS = ${JSON.stringify(SUBS)};
  const papel = () => localStorage.getItem('teste_papel');
  function consulta(tabela) {
    const pedido = { tabela, op: 'select', valores: null, filtros: [], ordem: null, limite: null };
    const q = {
      select() { return q; },
      insert(v) { pedido.op = 'insert'; pedido.valores = v; return q; },
      update(v) { pedido.op = 'update'; pedido.valores = v; return q; },
      eq(coluna, valor) { pedido.filtros.push([coluna, valor]); return q; },
      order(coluna, opcoes) { pedido.ordem = [coluna, !(opcoes && opcoes.ascending === false)]; return q; },
      limit(n) { pedido.limite = n; return q; },
      then(ok, erro) { return window.__torreBanco(papel(), pedido).then(ok, erro); }
    };
    return q;
  }
  return {
    auth: {
      getUser: async () => {
        const p = papel();
        return p ? { data: { user: { id: SUBS[p], email: p + '@teste.local', app_metadata: { role: p }, user_metadata: {} } }, error: null }
                 : { data: { user: null }, error: { message: 'sem sessão' } };
      },
      getSession: async () => ({ data: { session: papel() ? { access_token: 'token-' + papel() } : null } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      signOut: async () => ({})
    },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }),
    schema: (nome) => nome === 'torre' ? {
      from: consulta,
      rpc: (funcao, args) => ({ then(ok, erro) { return window.__torreBanco(papel(), { op: 'rpc', funcao, args }).then(ok, erro); } })
    } : null
  };
} };`;

async function criarBanco() {
  const db = new PGlite();
  await db.exec(`
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$
      select (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid $$;
    create function auth.jwt() returns jsonb language sql stable as $$
      select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb) $$;
    create role authenticated; create role anon; create role service_role;
    grant usage on schema auth to anon, authenticated, service_role;
    grant execute on all functions in schema auth to anon, authenticated, service_role;
    create function public.is_admin() returns boolean language sql stable security definer as $$
      select coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') in ('admin', 'diretoria') $$;
  `);
  for (const arq of ['T01_copia_planilha.sql', 'T02_passagem_turno.sql', 'T03_pendencias.sql', 'T04_nome_operador.sql']) {
    const sql = ateCommit(fs.readFileSync(path.join(RAIZ, 'supabase/sql/torre', arq), 'utf8'));
    await db.exec(sql.slice(sql.indexOf('\nbegin;\n')));
  }
  return db;
}

// PostgREST mínimo: select/eq/order/limit, insert(...).select(), update(...).eq().select()
function montarSql(pedido) {
  const nome = /^[a-z_]+$/;
  // RPCs do T03 (PostgREST: argumentos por nome)
  if (pedido.op === 'rpc') {
    const a = pedido.args || {};
    if (pedido.funcao === 'publicar_passagem') {
      return ['select torre.publicar_passagem($1, $2::date, $3, $4, $5, $6::jsonb, $7)::json as j',
        [a.p_turno, a.p_data, a.p_texto_original, a.p_texto_ia, a.p_texto_final, JSON.stringify(a.p_fechamentos ?? []), a.p_operador_nome]];
    }
    if (pedido.funcao === 'buscar_pendencias') {
      return [`select coalesce(json_agg(x), '[]'::json) as j from torre.buscar_pendencias($1, $2, $3::date, $4) x`,
        [a.p_texto, a.p_turno, a.p_data, a.p_status]];
    }
    throw new Error('rpc desconhecida');
  }
  if (!nome.test(pedido.tabela)) throw new Error('tabela inválida');
  const t = `torre.${pedido.tabela}`;
  const params = [];
  const onde = pedido.filtros.map(([c, v]) => {
    if (!nome.test(c)) throw new Error('coluna inválida');
    params.push(v);
    return `${c}::text = $${params.length}`;
  });
  const where = onde.length ? `where ${onde.join(' and ')}` : '';
  if (pedido.op === 'select') {
    const ordem = pedido.ordem && nome.test(pedido.ordem[0]) ? `order by ${pedido.ordem[0]} ${pedido.ordem[1] ? 'asc' : 'desc'}` : '';
    const limite = Number.isInteger(pedido.limite) ? `limit ${pedido.limite}` : '';
    return [`select coalesce(json_agg(x), '[]'::json) as j from (select * from ${t} ${where} ${ordem} ${limite}) x`, params];
  }
  const linhas = Array.isArray(pedido.valores) ? pedido.valores : [pedido.valores];
  const cols = [...new Set(linhas.flatMap(Object.keys))];
  if (!cols.every(c => nome.test(c))) throw new Error('coluna inválida');
  if (pedido.op === 'insert') {
    return [`with r as (insert into ${t} (${cols}) select ${cols} from json_populate_recordset(null::${t}, $1::json) returning *)
             select coalesce(json_agg(r), '[]'::json) as j from r`, [JSON.stringify(linhas)]];
  }
  const p2 = [JSON.stringify(linhas[0]), ...params];
  const where2 = pedido.filtros.map(([c], i) => `alvo.${c}::text = $${i + 2}`).join(' and ');
  return [`with r as (update ${t} as alvo set ${cols.map(c => `${c} = s.${c}`)} from json_populate_record(null::${t}, $1::json) s
           ${where2 ? `where ${where2}` : ''} returning alvo.*) select coalesce(json_agg(r), '[]'::json) as j from r`, p2];
}

function servidor() {
  const tipos = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
  return new Promise(res => {
    const srv = http.createServer((req, resp) => {
      const arq = path.join(RAIZ, decodeURIComponent(req.url.split('?')[0]));
      fs.readFile(arq, (err, dados) => {
        if (err) { resp.writeHead(404); return resp.end(); }
        resp.writeHead(200, { 'Content-Type': tipos[path.extname(arq).toLowerCase()] || 'application/octet-stream' });
        resp.end(dados);
      });
    });
    srv.listen(0, () => res(srv));
  });
}

(async () => {
  const db = await criarBanco();
  const srv = await servidor();
  const base = `http://127.0.0.1:${srv.address().port}`;
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: true, args: ['--no-sandbox']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1366, height: 900 });
  const erros = [];
  page.on('pageerror', e => erros.push(String(e)));
  page.on('dialog', d => d.accept());

  // IA simulada: o teste escolhe a resposta da edge function
  const ia = { pedidos: [], externos: [], resposta: { status: 200, corpo: {} } };
  await page.setRequestInterception(true);
  page.on('request', r => {
    const u = r.url();
    if (u.includes('@supabase/supabase-js')) return r.respond({ status: 200, contentType: 'text/javascript', body: SUPABASE_FALSO });
    if (u.endsWith('/functions/v1/torre-passagem-turno')) {
      if (r.method() === 'OPTIONS') return r.respond({ status: 200, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' }, body: 'ok' });
      ia.pedidos.push({ headers: r.headers(), corpo: JSON.parse(r.postData() || '{}') });
      return r.respond({ status: ia.resposta.status, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(ia.resposta.corpo) });
    }
    if (!u.startsWith(base)) { ia.externos.push(u); return r.respond({ status: 200, contentType: 'text/css', body: '' }); }
    r.continue();
  });

  let pendentes = 0;
  await page.exposeFunction('__torreBanco', async (papel, pedido) => {
    pendentes++;
    try {
      const claims = JSON.stringify({ sub: SUBS[papel], role: 'authenticated', email: `${papel}@teste.local`, app_metadata: { role: papel } });
      const data = await db.transaction(async (tx) => {
        await tx.query(`select set_config('request.jwt.claims', $1, true)`, [claims]);
        await tx.query('set local role authenticated');
        const [sql, params] = montarSql(pedido);
        return (await tx.query(sql, params)).rows[0].j;
      });
      return { data, error: null };
    } catch (e) {
      return { data: null, error: { message: e.message, code: e.code || '' } };
    } finally {
      pendentes--;
    }
  });
  const ocioso = async () => {
    for (let i = 0; i < 200; i++) {
      await esperar(60);
      if (pendentes === 0) { await esperar(150); if (pendentes === 0) return; }
    }
  };
  const entrar = async (papel, hash = '#passagem') => {
    await page.goto(`${base}/HTML/Login.html`).catch(() => { });
    await page.evaluate(p => { localStorage.clear(); localStorage.setItem('teste_papel', p); localStorage.setItem('torre_operador_nome', { admin: 'Ana Operadora', diretoria: 'Bruno Diretoria' }[p] || ''); }, papel);
    await page.goto(`${base}${TORRE}${hash}`, { waitUntil: 'load' });
    await ocioso();
  };
  const valor = (sel, v) => page.$eval(sel, (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }, v);
  const tela = () => page.evaluate(() => {
    const vis = (id) => { const el = document.getElementById(id); return !!el && getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().height > 0; };
    return {
      passagem: vis('torre-passagem'), tabela: vis('torre-area-principal'), busca: vis('torre-busca-wrapper'), contadores: vis('torre-painel-contadores'),
      titulo: document.getElementById('torre-aba-titulo').textContent,
      ativo: document.querySelector('.sidebar-nav .nav-link.active')?.getAttribute('data-aba'),
      status: document.getElementById('passagem-status').textContent,
      rolagem: document.documentElement.scrollWidth > window.innerWidth
    };
  });

  const ativo = () => page.evaluate(() => document.querySelector('.sidebar-nav .nav-link.active')?.getAttribute('data-aba'));
  const visivel = (id) => page.evaluate((i) => { const el = document.getElementById(i); return !!el && getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().height > 0; }, id);
  const statusTxt = () => page.$eval('#passagem-status', el => el.textContent);
  const publicarComo = async (turno, original, final) => {
    await page.select('#passagem-turno', turno);
    await valor('#passagem-original', original);
    await valor('#passagem-final', final);
    await page.click('#btn-publicar-passagem');
    await ocioso();
  };
  const herdadas = () => page.$$eval('#passagem-herdadas .pendencia-herdada', fs => fs.map(f => ({
    texto: f.querySelector('legend').textContent, meta: f.querySelector('.passagem-meta').textContent,
    incompleta: f.classList.contains('pendencia-incompleta') })));

  // 1. Turno 1 publica com 3 pendências (uma com <img> para conferir o escape)
  console.log('\n--- Pendências viram itens rastreáveis ---');
  await entrar('admin');
  ok(!(await visivel('passagem-herdadas')), 'sem pendência aberta: o bloco "Pendências herdadas" não aparece');
  const FINAL1 = `URGENTE\n- não informado\n\nPENDÊNCIAS PARA O PRÓXIMO TURNO\n- Conferir os canhotos do CD Cajamar\n- Ligar para a transportadora Rápido Sul ${XSS}\n- Cobrar o CTe da LH 123\n\nAVISOS\n- não informado`;
  await publicarComo('T1', 'turno 1 escrito à mão', FINAL1);
  let st = await statusTxt();
  ok(/^Passagem publicada\. 3 nova\(s\) pendência\(s\) para o próximo turno\.$/.test(st), 'publicar cria 3 pendências (status mostra)', st);
  const banco1 = (await db.query(`select texto, status, turno, data::text = current_date::text as hoje from torre.passagem_pendencias order by criado_em`)).rows;
  ok(banco1.length === 3 && banco1.every(p => p.status === 'aberta' && p.turno === 'T1' && p.hoje) && banco1[1].texto.includes('<img'),
    'no banco: 3 abertas, ligadas à passagem e ao turno T1 (texto guardado como veio)', banco1.map(p => p.texto.slice(0, 20)));

  // 2. Turno 2: as 3 aparecem como herdadas; publicar sem fechar = recusado na tela (nada gravado)
  console.log('\n--- Turno seguinte fecha as herdadas ---');
  await entrar('diretoria');
  let h = await herdadas();
  ok(h.length === 3 && h[0].texto === 'Conferir os canhotos do CD Cajamar' && /^Da passagem do T1 de \d{2}\/\d{2}\/\d{4}$/.test(h[0].meta),
    'turno seguinte vê as 3 herdadas, mais antigas primeiro, com turno e data', h.map(x => x.texto.slice(0, 25)));
  ok(await page.$$eval('#passagem-herdadas img', i => i.length) === 0, 'escapeHtml: <img> da pendência aparece como texto');
  await publicarComo('T2', 'turno 2', 'AVISOS\n- tudo certo');
  st = await statusTxt();
  h = await herdadas();
  const foco = await page.evaluate(() => document.activeElement?.closest('.pendencia-herdada')?.querySelector('legend')?.textContent);
  ok(/Feche cada pendência herdada/.test(st) && h.every(x => x.incompleta) && foco === 'Conferir os canhotos do CD Cajamar'
    && Number((await db.query('select count(*) n from torre.passagens_turno')).rows[0].n) === 1,
    'sem fechar: recusado, as 3 marcadas, foco na primeira e nada publicado', st);

  // Só o status não basta: "Como foi resolvido" é obrigatório
  const caixas = await page.$$('#passagem-herdadas .pendencia-herdada');
  await (await caixas[0].$('input[value="resolvida"]')).click();
  await (await caixas[1].$('input[value="continua"]')).click();
  await (await caixas[2].$('input[value="resolvida"]')).click();
  await page.click('#btn-publicar-passagem');
  await ocioso();
  st = await statusTxt();
  ok(/Feche cada pendência herdada/.test(st) && await page.evaluate(() => document.activeElement?.getAttribute('data-fechar-resolucao') !== null),
    'sem "Como foi resolvido": recusado e foco no campo', st);

  // Escreve as resoluções; troca de aba e volta: o que foi preenchido continua
  const resolucao = async (i, txt) => page.evaluate((i, txt) => {
    const el = document.querySelectorAll('#passagem-herdadas [data-fechar-resolucao]')[i];
    el.value = txt; el.dispatchEvent(new Event('input', { bubbles: true }));
  }, i, txt);
  await resolucao(0, 'Canhotos conferidos com o CD Cajamar por e-mail.');
  await resolucao(1, 'Liguei 2x e ninguém atendeu.');
  await resolucao(2, 'CTe recebido às 10h.');
  await page.click('#nav-link-matriz');
  await ocioso();
  await page.click('#nav-link-passagem');
  await ocioso();
  const mantido = await page.evaluate(() => Array.from(document.querySelectorAll('#passagem-herdadas .pendencia-herdada')).map(f =>
    `${f.querySelector('input:checked')?.value}:${f.querySelector('textarea').value.slice(0, 10)}`));
  ok(mantido.join('|') === 'resolvida:Canhotos c|continua:Liguei 2x |resolvida:CTe recebi', 'trocar de aba e voltar mantém o que foi marcado e escrito', mantido.join('|'));

  // Publica: fecha 2, 1 continua e vira pendência da passagem nova (junto com a nova do texto)
  await valor('#passagem-final', 'PENDÊNCIAS PARA O PRÓXIMO TURNO\n- Pedir a foto do lacre da LH 456');
  await page.click('#btn-publicar-passagem');
  await ocioso();
  st = await statusTxt();
  ok(st === 'Passagem publicada. 3 pendência(s) herdada(s) fechada(s), 1 continua(m) no próximo turno, 1 nova(s) pendência(s) para o próximo turno.', 'publicou fechando as 3', st);
  const banco2 = (await db.query(`select p.texto, p.status, p.resolucao, p.resolvido_email, p.turno, (p.origem_id is not null) as continua_de,
      (select turno from torre.passagens_turno f where f.id = p.fechada_na_passagem) as fechada_em
      from torre.passagem_pendencias p order by p.criado_em`)).rows;
  ok(banco2[0].status === 'resolvida' && banco2[0].resolvido_email === 'diretoria@teste.local' && banco2[0].fechada_em === 'T2'
    && banco2[1].status === 'continua' && banco2[2].resolucao === 'CTe recebido às 10h.',
    'no banco: resolvida/continua com "como foi resolvido", quem fechou e em qual passagem', banco2.slice(0, 3).map(p => `${p.status}/${p.fechada_em}`));
  const abertas = banco2.filter(p => p.status === 'aberta');
  ok(abertas.length === 2 && abertas.every(p => p.turno === 'T2') && abertas.some(p => p.continua_de && p.texto.startsWith('Ligar para a transportadora'))
    && abertas.some(p => p.texto === 'Pedir a foto do lacre da LH 456'), '"Continua" passou para o próximo turno (ligada à passagem nova)', abertas.map(p => p.texto.slice(0, 25)));
  h = await herdadas();
  ok(h.length === 2 && h.some(x => /já veio de um turno anterior/.test(x.meta)), 'a tela já mostra as 2 herdadas do próximo turno', h.map(x => x.texto.slice(0, 25)));

  // 3. Histórico de pendências
  console.log('\n--- Histórico de pendências ---');
  await page.click('#nav-link-pendencias');
  await ocioso();
  ok(await ativo() === 'pendencias' && await visivel('torre-pendencias') && !(await visivel('torre-passagem')) && !(await visivel('torre-area-principal')) && !(await visivel('torre-busca-wrapper'))
    && await page.$eval('#torre-aba-titulo', el => el.textContent) === 'Histórico de pendências', 'item "Histórico de pendências" abre a tela (tabela, busca e passagem escondidas)');
  const lista = () => page.$$eval('#pendencias-lista .pendencia-item', els => els.map(e => `${e.querySelector('.pendencia-status').textContent}|${e.querySelector('.pendencia-texto').textContent.slice(0, 22)}`));
  let l = await lista();
  ok(l.length === 5 && await page.$eval('#pendencias-resumo', el => el.textContent) === '5 pendência(s)', 'lista todas (5)', l);
  ok(await page.$$eval('#pendencias-lista img', i => i.length) === 0, 'escapeHtml no histórico');
  const resolvida = await page.$$eval('#pendencias-lista .pendencia-resolvida', els => els.map(e => e.textContent.replace(/\s+/g, ' ').trim()).find(t => /Canhotos conferidos/.test(t)) || '');
  ok(/Como foi resolvido Canhotos conferidos com o CD Cajamar por e-mail\. Resolvida por Bruno Diretoria em \d{2}\/\d{2}\/\d{4} \d{2}:\d{2} · na passagem do T2 de/.test(resolvida),
    'resolvida mostra como, quem, quando e em qual passagem', resolvida.slice(0, 160));
  await valor('#pendencias-texto', 'cajamar');
  await esperar(400); await ocioso();
  l = await lista();
  ok(l.length === 1 && /^Resolvida\|Conferir os canhotos/.test(l[0]), 'busca por texto', l);
  await valor('#pendencias-texto', 'ninguém atendeu');
  await esperar(400); await ocioso();
  l = await lista();
  ok(l.length === 1 && /^Continua\|Ligar para/.test(l[0]), 'busca também em "como foi resolvido"', l);
  await valor('#pendencias-texto', '');
  await esperar(400);
  await page.select('#pendencias-status', 'aberta');
  await ocioso();
  l = await lista();
  ok(l.length === 2 && l.every(x => x.startsWith('Aberta|')), 'filtro por status (abertas)', l);
  await page.select('#pendencias-status', '');
  await page.select('#pendencias-turno', 'T1');
  await ocioso();
  ok((await lista()).length === 3, 'filtro por turno (T1 = 3)');
  await page.select('#pendencias-turno', '');
  await valor('#pendencias-data', '2000-01-01');
  await ocioso();
  ok(await page.$eval('#pendencias-lista', el => /Nenhuma pendência com esses filtros/.test(el.textContent)), 'filtro por data sem resultado: aviso');
  await valor('#pendencias-data', (await db.query('select current_date::text d')).rows[0].d);
  await ocioso();
  ok((await lista()).length === 5, 'filtro por data de hoje (5)');
  await valor('#pendencias-texto', '100%_');
  await esperar(400); await ocioso();
  ok((await lista()).length === 0, '% e _ na busca são texto, não curinga');

  // 4. Sugestões de tratativa no "Gerar" (IA simulada)
  console.log('\n--- Sugestões de tratativa ---');
  await page.click('#nav-link-passagem');
  await ocioso();
  ia.resposta = { status: 200, corpo: { texto_ia: 'AVISOS\n- não informado\n\nSUGESTÕES DE TRATATIVA\n- Pedir ao CD o reenvio por e-mail. (como resolvido na passagem do T2 de 04/11/2026)', removidos: { cpf: 0 },
    sugestoes: [{ texto: 'Pedir ao CD o reenvio por e-mail.', passagem: { id: 'x', turno: 'T2', data: '2026-11-04' } }] } };
  await page.select('#passagem-turno', 'T3');
  await valor('#passagem-original', 'canhotos do CD Cajamar de novo');
  await page.click('#btn-gerar-passagem');
  await ocioso(); await esperar(200);
  st = await statusTxt();
  ok(/Inclui 1 sugestão\(ões\) de tratativa tirada\(s\) de passagens anteriores/.test(st) && /SUGESTÕES DE TRATATIVA/.test(await page.$eval('#passagem-final', el => el.value)),
    'com sugestão: aviso no status e a seção no texto para revisar', st);
  ia.resposta = { status: 200, corpo: { texto_ia: 'AVISOS\n- não informado', removidos: { cpf: 0 }, sugestoes: [] } };
  await valor('#passagem-final', '');
  await page.click('#btn-gerar-passagem');
  await ocioso(); await esperar(200);
  ok(!/sugestão/.test(await statusTxt()), 'sem sugestão: nada de aviso');

  // 5. Acesso e tamanhos
  console.log('\n--- Acesso e tamanhos ---');
  await entrar('motorista', '#pendencias');
  ok(/\/HTML\/Login\.html/.test(page.url()), 'motorista não entra (login)', page.url());
  await entrar('admin', '#pendencias');
  for (const w of [1366, 390]) {
    await page.setViewport({ width: w, height: 900 });
    await esperar(250);
    const r = await page.evaluate(() => ({
      rolagem: document.documentElement.scrollWidth > window.innerWidth,
      dentro: Array.from(document.querySelectorAll('#torre-pendencias input, #torre-pendencias select, .pendencia-item'))
        .filter(el => el.offsetParent).every(el => { const b = el.getBoundingClientRect(); return b.left >= 0 && b.right <= window.innerWidth + 1; })
    }));
    ok(!r.rolagem && r.dentro, `${w}px: histórico sem rolagem lateral, tudo dentro da tela`);
  }
  await page.setViewport({ width: 390, height: 900 });
  await entrar('admin', '#passagem');
  const r390 = await page.evaluate(() => ({
    rolagem: document.documentElement.scrollWidth > window.innerWidth,
    dentro: Array.from(document.querySelectorAll('#passagem-herdadas textarea, #passagem-herdadas input')).filter(el => el.offsetParent)
      .every(el => { const b = el.getBoundingClientRect(); return b.left >= 0 && b.right <= window.innerWidth + 1; })
  }));
  ok(!r390.rolagem && r390.dentro, '390px: herdadas sem rolagem lateral');
  await page.screenshot({ path: path.join(RAIZ, 'testes/capturas/torre_pendencias_herdadas_390.png'), fullPage: false });
  await page.setViewport({ width: 1366, height: 900 });

  ok(!(await page.evaluate(() => window.__xss)), 'escapeHtml: nenhum <img onerror> executou');
  const errosJs = erros.filter(e => !/Failed to fetch|Swiper/.test(e));
  ok(errosJs.length === 0, 'sem erros de JS', errosJs.join(' | '));
  console.log(falhas ? `\n${falhas} FALHA(S)` : '\nTUDO OK');
  await browser.close(); srv.close(); await db.close();
  process.exit(falhas ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
