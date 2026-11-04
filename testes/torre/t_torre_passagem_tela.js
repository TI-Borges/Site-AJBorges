// Tela "Passagem de turno" da Torre com a IA SIMULADA: o pedido à edge function torre-passagem-turno
// é interceptado e respondido pelo teste; o banco é um PGlite com T01 + T02 (cada consulta roda como
// authenticated com o JWT do usuário, então quem decide é a RLS). auth.js e supabase-client.js reais.
// Confere: item na barra lateral; turnos sem horário inventado e horário editável; "Gerar passagem"
// manda turno + texto com o token (o navegador nunca fala com a IA); o texto da IA vai para o campo
// final, editável; "Publicar" grava com autor/hora do servidor; no topo a última passagem (quem,
// quando, turno) com "Ver texto original"; histórico com filtro por data e turno; erros da IA sem
// perder o texto; trocar de aba e voltar mantém o rascunho; motorista não entra; 1366/390 px;
// escapeHtml.
// Uso: node testes/torre/t_torre_passagem_tela.js
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
  for (const arq of ['T01_copia_planilha.sql', 'T02_passagem_turno.sql', 'T03_pendencias.sql']) {
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
      return ['select torre.publicar_passagem($1, $2::date, $3, $4, $5, $6::jsonb)::json as j',
        [a.p_turno, a.p_data, a.p_texto_original, a.p_texto_ia, a.p_texto_final, JSON.stringify(a.p_fechamentos ?? [])]];
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
    await page.evaluate(p => { localStorage.clear(); localStorage.setItem('teste_papel', p); }, papel);
    await page.goto(`${base}${TORRE}${hash}`, { waitUntil: 'load' });
    await ocioso();
  };
  const valor = (sel, v) => page.$eval(sel, (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }, v);
  const tela = () => page.evaluate(() => {
    const vis = (id) => { const el = document.getElementById(id); return !!el && getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().height > 0; };
    return {
      passagem: vis('torre-passagem'), tabela: vis('torre-area-principal'), busca: vis('torre-busca-wrapper'), contadores: vis('torre-painel-contadores'),
      titulo: document.getElementById('torre-aba-titulo').textContent,
      ativo: document.querySelector('#torre-nav-list .nav-link.active')?.getAttribute('data-aba'),
      status: document.getElementById('passagem-status').textContent,
      rolagem: document.documentElement.scrollWidth > window.innerWidth
    };
  });

  // 1. Abrir a tela pela barra lateral
  console.log('\n--- Tela ---');
  await entrar('admin', '#matriz');
  await page.click('#nav-link-passagem');
  await ocioso();
  let t = await tela();
  ok(t.passagem && !t.tabela && !t.busca && !t.contadores && t.titulo === 'Passagem de turno' && t.ativo === 'passagem', 'item "Passagem de turno" abre a tela (tabela e busca escondidas)', t);
  ok(await page.$eval('#passagem-ultima', el => /Nenhuma passagem publicada ainda/.test(el.textContent)), 'sem passagem ainda: aviso no topo');
  const opcoes = await page.$$eval('#passagem-turno option', os => os.map(o => o.textContent));
  ok(opcoes.join('|') === 'Escolha o turno|T1 (horário não configurado)|T2 (horário não configurado)|T3 (horário não configurado)', 'turnos T1/T2/T3 sem horário inventado', opcoes.join('|'));

  // 2. Horários editáveis
  await page.click('#passagem-horarios summary');
  await valor('[data-horario-turno="T1"][data-horario-campo="inicio"]', '06:00');
  await valor('[data-horario-turno="T1"][data-horario-campo="fim"]', '14:00');
  await page.click('#btn-salvar-horarios');
  await ocioso();
  const op2 = await page.$$eval('#passagem-turno option', os => os.map(o => o.textContent));
  const t1 = (await db.query(`select to_char(inicio, 'HH24:MI') i, to_char(fim, 'HH24:MI') f, atualizado_por::text p from torre.turnos where turno = 'T1'`)).rows[0];
  ok(op2[1] === 'T1 (06:00 às 14:00)' && op2[2] === 'T2 (horário não configurado)' && t1.i === '06:00' && t1.f === '14:00' && t1.p === SUBS.admin,
    'horário do T1 salvo no banco (quem alterou = servidor) e mostrado no turno', `${op2[1]} | ${JSON.stringify(t1)}`);

  // 3. Gerar passagem (IA simulada)
  await page.click('#btn-gerar-passagem');
  ok((await tela()).status === 'Escolha o turno.', 'sem turno: pede o turno');
  const ORIGINAL = `carreta ABC1D23 parada em Registro ${XSS}, motorista cpf 123.456.789-09 tel (11) 98765-4321. falta conferir canhotos`;
  const IA = `URGENTE\n- Carreta ABC1D23 parada em Registro ${XSS}.\n\nEM ANDAMENTO\n- não informado\n\nPENDÊNCIAS PARA O PRÓXIMO TURNO\n- Conferir os canhotos.\n\nAVISOS\n- não informado`;
  await page.select('#passagem-turno', 'T1');
  await valor('#passagem-original', ORIGINAL);
  ok(await page.$eval('#passagem-contador', el => el.textContent) === String(ORIGINAL.length), 'contador de caracteres');
  ia.resposta = { status: 200, corpo: { texto_ia: IA, removidos: { cpf: 1, telefone: 1 } } };
  await page.click('#btn-gerar-passagem');
  await ocioso();
  await esperar(200);
  const p0 = ia.pedidos[0] || { headers: {}, corpo: {} };
  ok(p0.corpo.turno === 'T1' && p0.corpo.texto === ORIGINAL && p0.headers.authorization === 'Bearer token-admin', 'Gerar manda turno e texto à edge function com o token do operador', p0.corpo.turno);
  ok(!ia.externos.some(u => /generativelanguage|gemini/i.test(u)), 'o navegador nunca fala com a IA');
  t = await tela();
  ok(await page.$eval('#passagem-final', el => el.value) === IA && /Passagem gerada/.test(t.status) && /1 CPF e 1 telefone/.test(t.status), 'texto da IA no campo final, para revisar', t.status);

  // 4. Erros da IA não apagam o texto
  ia.resposta = { status: 502, corpo: { erro: 'A IA não respondeu. Tente de novo em instantes; o seu texto continua na tela.' } };
  await page.click('#btn-gerar-passagem');
  await ocioso();
  await esperar(200);
  t = await tela();
  ok(/A IA não respondeu/.test(t.status) && await page.$eval('#passagem-original', el => el.value) === ORIGINAL && await page.$eval('#passagem-final', el => el.value) === IA,
    'IA fora: mensagem e nada é perdido', t.status);
  ia.resposta = { status: 429, corpo: { erro: 'Limite de 5 passagens geradas por minuto. Espere um pouco e tente de novo.' } };
  await page.click('#btn-gerar-passagem');
  await ocioso();
  await esperar(200);
  ok(/Limite de 5/.test((await tela()).status), 'limite por minuto: mensagem do servidor');

  // 5. Trocar de aba e voltar mantém o rascunho
  await page.click('#nav-link-matriz');
  await ocioso();
  t = await tela();
  ok(!t.passagem && t.tabela && t.busca && t.ativo === 'matriz', 'MATRIZ: tabela volta e a passagem some', t);
  await page.click('#nav-link-passagem');
  await ocioso();
  ok(await page.$eval('#passagem-original', el => el.value) === ORIGINAL, 'voltando, o rascunho continua');

  // 6. Revisa, edita e publica
  const FINAL = IA + '\n- Revisado pelo operador.';
  await valor('#passagem-final', FINAL);
  await page.click('#btn-publicar-passagem');
  await ocioso();
  const linha = (await db.query(`select turno, data::text, texto_original, texto_ia, texto_final, autor::text, autor_email,
      abs(extract(epoch from now() - criado_em)) < 60 as agora from torre.passagens_turno`)).rows;
  ok(linha.length === 1 && linha[0].turno === 'T1' && linha[0].texto_original === ORIGINAL && linha[0].texto_ia === IA && linha[0].texto_final === FINAL
    && linha[0].autor === SUBS.admin && linha[0].autor_email === 'admin@teste.local' && linha[0].agora, 'publicou: original, IA e final; autor e hora do servidor', linha[0] && linha[0].autor_email);
  t = await tela();
  ok(/^Passagem publicada\./.test(t.status) && await page.$eval('#passagem-original', el => el.value) === '' && await page.$eval('#passagem-final', el => el.value) === '', 'formulário limpo depois de publicar', t.status);

  // 7. Topo: última passagem (quem, quando, turno) e "Ver texto original"
  const topo = await page.evaluate(() => {
    const el = document.getElementById('passagem-ultima');
    const orig = document.getElementById('passagem-ultima-original');
    return { meta: el.querySelector('.passagem-meta').textContent, texto: el.querySelector('.passagem-texto').textContent, origEscondido: orig.hidden, img: el.querySelectorAll('img').length };
  });
  ok(/^Turno T1 de \d{2}\/\d{2}\/\d{4} · por admin@teste\.local · publicada em \d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/.test(topo.meta) && topo.texto === FINAL && topo.origEscondido && topo.img === 0,
    'topo: última passagem com turno, data, quem e quando (texto como texto)', topo.meta);
  await page.click('#passagem-ultima [data-passagem-original]');
  const orig = await page.evaluate(() => ({ visivel: !document.getElementById('passagem-ultima-original').hidden, texto: document.querySelector('#passagem-ultima-original .passagem-texto').textContent, botao: document.querySelector('#passagem-ultima [data-passagem-original]').textContent }));
  ok(orig.visivel && orig.texto === ORIGINAL && orig.botao === 'Esconder texto original', '"Ver texto original" mostra o que o operador escreveu');

  // 8. Segunda passagem (diretoria, sem IA, outra data) e histórico com filtros
  console.log('\n--- Histórico ---');
  await entrar('diretoria');
  const ontem = (await db.query(`select (current_date - 1)::text d`)).rows[0].d;
  await page.select('#passagem-turno', 'T3');
  await valor('#passagem-data', ontem);
  await valor('#passagem-original', 'noite tranquila');
  await valor('#passagem-final', 'AVISOS\n- Noite sem ocorrências.');
  // T03: a pendência "Conferir os canhotos." da passagem do admin é herdada e tem que ser fechada
  await page.click('#passagem-herdadas input[value="resolvida"]');
  await valor('#passagem-herdadas [data-fechar-resolucao]', 'Canhotos conferidos.');
  await page.click('#btn-publicar-passagem');
  await ocioso();
  const sem = (await db.query(`select texto_ia, autor_email, data::text from torre.passagens_turno where turno = 'T3'`)).rows[0];
  ok(sem && sem.texto_ia === null && sem.autor_email === 'diretoria@teste.local' && sem.data === ontem, 'diretoria publica sem IA (texto_ia vazio) com a data escolhida', sem);
  ok(await page.$eval('#passagem-ultima .passagem-meta', el => /^Turno T3 de .* por diretoria@teste\.local/.test(el.textContent)), 'topo mostra a mais recente');
  const hist = () => page.$$eval('#passagem-historico .passagem-item summary', s => s.map(x => x.textContent.replace(/\s+/g, ' ').trim()));
  ok((await hist()).length === 2, 'histórico com as 2 passagens');
  await page.select('#historico-turno', 'T1');
  await ocioso();
  let h = await hist();
  ok(h.length === 1 && /^T1 /.test(h[0]) && h[0].includes('admin@teste.local'), 'filtro por turno', h.join(' / '));
  await page.select('#historico-turno', '');
  await valor('#historico-data', ontem);
  await ocioso();
  h = await hist();
  ok(h.length === 1 && /^T3 /.test(h[0]), 'filtro por data', h.join(' / '));
  await valor('#historico-data', '2000-01-01');
  await ocioso();
  ok(await page.$eval('#passagem-historico', el => /Nenhuma passagem com esses filtros/.test(el.textContent)), 'filtro sem resultado: aviso');
  await valor('#historico-data', '');
  await ocioso();
  await page.click('#passagem-historico details:last-child summary');
  await page.click('#passagem-historico details:last-child [data-passagem-original]');
  ok(await page.$eval('#passagem-historico details:last-child .passagem-original .passagem-texto', el => el.textContent) === ORIGINAL, 'histórico também tem "Ver texto original"');

  // 9. Motorista não entra; tamanhos
  console.log('\n--- Acesso e tamanhos ---');
  await entrar('motorista');
  ok(/\/HTML\/Login\.html/.test(page.url()), 'motorista vai para o login', page.url());
  await entrar('admin');
  for (const w of [1366, 1920, 390]) {
    await page.setViewport({ width: w, height: 900 });
    await esperar(200);
    const r = await tela();
    const dentro = await page.evaluate(() => Array.from(document.querySelectorAll('#torre-passagem textarea, #torre-passagem select, #torre-passagem button'))
      .filter(el => el.offsetParent).every(el => { const b = el.getBoundingClientRect(); return b.left >= 0 && b.right <= window.innerWidth + 1; }));
    ok(r.passagem && !r.rolagem && dentro, `${w}px: sem rolagem lateral, campos dentro da tela`);
  }

  ok(!(await page.evaluate(() => window.__xss)), 'escapeHtml: nenhum <img onerror> executou');
  const errosJs = erros.filter(e => !/Failed to fetch|Swiper/.test(e));
  ok(errosJs.length === 0, 'sem erros de JS', errosJs.join(' | '));
  console.log(falhas ? `\n${falhas} FALHA(S)` : '\nTUDO OK');
  await browser.close(); srv.close(); await db.close();
  process.exit(falhas ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
