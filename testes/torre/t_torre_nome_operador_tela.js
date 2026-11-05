// "Seu nome" na passagem de turno da Torre (T04_nome_operador.sql), com a IA SIMULADA e o banco num
// PGlite com T01 + T02 + T03 + T04 (cada consulta roda como authenticated com o JWT do usuário).
// Confere: sem nome (ou com 1 letra) não gera nem publica; o nome não vai para a edge function (IA);
// o navegador lembra o nome ao recarregar (e a tela funciona sem localStorage); o nome aparece na
// "Última passagem" do topo, no histórico e no Histórico de pendências (quem criou e quem resolveu);
// passagem e pendência antigas (sem nome) mostram "não informado"; <img onerror> no nome é escapado;
// 390 px. Print em testes/capturas/torre_nome_operador_390.png.
// Uso: node testes/torre/t_torre_nome_operador_tela.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');
const { PGlite } = require('@electric-sql/pglite');

const RAIZ = path.resolve(__dirname, '..', '..');
const TORRE = '/torre-de-controle-shoppe/HTML/index.html';
const SUBS = { admin: '00000000-0000-0000-0000-0000000000c3', diretoria: '00000000-0000-0000-0000-0000000000d4' };
const NOME_XSS = 'Ana <img src=x onerror="window.__xss=1">';
let falhas = 0;
const ok = (cond, msg, extra) => { console.log(`${cond ? 'OK  ' : 'FALHA'} ${msg}${extra !== undefined ? ` (${typeof extra === 'string' ? extra : JSON.stringify(extra)})` : ''}`); if (!cond) falhas++; };
const esperar = (ms) => new Promise(r => setTimeout(r, ms));
const ateCommit = (sql) => sql.slice(0, sql.indexOf('\ncommit;\n') + '\ncommit;\n'.length);

const SUPABASE_FALSO = `
window.supabase = { createClient: () => {
  const SUBS = ${JSON.stringify(SUBS)};
  const papel = () => { try { return localStorage.getItem('teste_papel'); } catch (e) { return window.__papelTeste || null; } };
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
  // Passagem e pendência de ANTES do T04 (sem nome): publicadas pelo T03, depois roda o T04
  await db.exec(`begin;
    select set_config('request.jwt.claims', '{"sub":"${SUBS.diretoria}","role":"authenticated","email":"diretoria@teste.local","app_metadata":{"role":"diretoria"}}', true);
    select torre.publicar_passagem('T3', current_date - 1, 'passagem antiga', null, E'PENDÊNCIAS PARA O PRÓXIMO TURNO\n- Pendência antiga sem nome', '[]');
    commit;`);
  const t04 = ateCommit(fs.readFileSync(path.join(RAIZ, 'supabase/sql/torre/T04_nome_operador.sql'), 'utf8'));
  await db.exec(t04.slice(t04.indexOf('\nbegin;\n')));
  return db;
}

// PostgREST mínimo: select/eq/order/limit, update(...).eq().select() e as RPCs da passagem
function montarSql(pedido) {
  const nome = /^[a-z_]+$/;
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
  if (pedido.op === 'update') {
    const p2 = [JSON.stringify(linhas[0]), ...params];
    const where2 = pedido.filtros.map(([c], i) => `alvo.${c}::text = $${i + 2}`).join(' and ');
    return [`with r as (update ${t} as alvo set ${cols.map(c => `${c} = s.${c}`)} from json_populate_record(null::${t}, $1::json) s
             ${where2 ? `where ${where2}` : ''} returning alvo.*) select coalesce(json_agg(r), '[]'::json) as j from r`, p2];
  }
  throw new Error('operação não usada neste teste');
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

  const ia = { pedidos: [], resposta: { status: 200, corpo: {} } };
  await page.setRequestInterception(true);
  page.on('request', r => {
    const u = r.url();
    if (u.includes('@supabase/supabase-js')) return r.respond({ status: 200, contentType: 'text/javascript', body: SUPABASE_FALSO });
    if (u.endsWith('/functions/v1/torre-passagem-turno')) {
      if (r.method() === 'OPTIONS') return r.respond({ status: 200, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' }, body: 'ok' });
      ia.pedidos.push({ bruto: r.postData() || '', corpo: JSON.parse(r.postData() || '{}') });
      return r.respond({ status: ia.resposta.status, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(ia.resposta.corpo) });
    }
    if (!u.startsWith(base)) return r.respond({ status: 200, contentType: 'text/css', body: '' });
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
  const valor = (sel, v) => page.$eval(sel, (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }, v);
  const statusTxt = () => page.$eval('#passagem-status', el => el.textContent);
  const nomeCampo = () => page.$eval('#passagem-operador-nome', el => ({ valor: el.value, invalido: el.getAttribute('aria-invalid'), foco: document.activeElement === el }));
  const passagens = async () => Number((await db.query('select count(*) n from torre.passagens_turno')).rows[0].n);

  // 1. Entra sem nome guardado
  await page.goto(`${base}/HTML/Login.html`).catch(() => { });
  await page.evaluate(() => { localStorage.clear(); localStorage.setItem('teste_papel', 'admin'); });
  await page.goto(`${base}${TORRE}#passagem`, { waitUntil: 'load' });
  await ocioso();
  console.log('\n--- Sem nome ---');
  ok((await nomeCampo()).valor === '', 'sem nome guardado: campo "Seu nome" vazio');
  const posicao = await page.evaluate(() => {
    const nome = document.getElementById('passagem-operador-nome'), gerar = document.getElementById('btn-gerar-passagem');
    return nome.getBoundingClientRect().top < gerar.getBoundingClientRect().top && nome.required && nome.maxLength === 80;
  });
  ok(posicao, '"Seu nome" vem antes de "Gerar passagem" (obrigatório, até 80 letras)');
  const topoAntigo = await page.$eval('#passagem-ultima .passagem-meta', el => el.textContent);
  ok(/^T3 · \d{2}\/\d{2} \d{2}:\d{2} · por não informado · turno de \d{2}\/\d{2}\/\d{4}$/.test(topoAntigo), 'passagem antiga no topo: "por não informado"', topoAntigo);
  ok(await page.$eval('#passagem-historico', el => /por não informado/.test(el.textContent)), 'passagem antiga no histórico: "por não informado"');

  const ORIGINAL = 'carreta parada em Registro; falta conferir os canhotos';
  await page.select('#passagem-turno', 'T1');
  await valor('#passagem-original', ORIGINAL);
  ia.resposta = { status: 200, corpo: { texto_ia: 'PENDÊNCIAS PARA O PRÓXIMO TURNO\n- Conferir os canhotos do CD Cajamar', removidos: { cpf: 0 } } };
  await page.click('#btn-gerar-passagem');
  await ocioso();
  let st = await statusTxt();
  let campo = await nomeCampo();
  ok(/^Preencha "Seu nome" \(2 a 80 letras\)/.test(st) && ia.pedidos.length === 0 && campo.invalido === 'true' && campo.foco, 'sem nome: não gera (nada vai para a IA), campo marcado e com foco', st);
  await valor('#passagem-operador-nome', ' A ');
  await page.click('#btn-gerar-passagem');
  await ocioso();
  ok(/^Preencha "Seu nome"/.test(await statusTxt()) && ia.pedidos.length === 0, 'nome de 1 letra: não gera');

  // Publicar sem nome (com a herdada fechada e o texto pronto): recusado na tela, nada gravado
  await valor('#passagem-operador-nome', '');
  await valor('#passagem-final', 'AVISOS\n- ok');
  await page.click('#passagem-herdadas input[value="resolvida"]');
  await valor('#passagem-herdadas [data-fechar-resolucao]', 'Resolvida no turno 1.');
  await page.click('#btn-publicar-passagem');
  await ocioso();
  ok(/^Preencha "Seu nome"/.test(await statusTxt()) && await passagens() === 1, 'sem nome: não publica (nada gravado)');
  await valor('#passagem-operador-nome', 'B');
  await page.click('#btn-publicar-passagem');
  await ocioso();
  ok(/^Preencha "Seu nome"/.test(await statusTxt()) && await passagens() === 1, 'nome de 1 letra: não publica');
  // Mesmo que a tela deixasse passar, o banco recusa (RPC com nome de 1 letra)
  const direto = await page.evaluate(() => new Promise(res => window.supabaseClient.schema('torre').rpc('publicar_passagem', {
    p_turno: 'T1', p_data: '2026-11-04', p_texto_original: 'x', p_texto_ia: null, p_texto_final: 'x', p_fechamentos: [], p_operador_nome: 'B'
  }).then(r => res(r.error && r.error.message))));
  ok(/Preencha "Seu nome"/.test(direto || '') && await passagens() === 1, 'banco recusa publicar com nome de 1 letra', direto);

  // 2. Nome lembrado ao recarregar
  console.log('\n--- Nome lembrado ---');
  await valor('#passagem-operador-nome', NOME_XSS);
  ok(await page.evaluate(() => localStorage.getItem('torre_operador_nome')) === NOME_XSS, 'o nome digitado fica guardado no navegador');
  await page.reload({ waitUntil: 'load' });
  await ocioso();
  ok((await nomeCampo()).valor === NOME_XSS, 'recarregou: o nome continua no campo');

  // 3. Gerar: o nome não vai para a IA
  await page.select('#passagem-turno', 'T1');
  await valor('#passagem-original', ORIGINAL);
  await page.click('#btn-gerar-passagem');
  await ocioso();
  await esperar(200);
  const pedido = ia.pedidos[0] || { corpo: {}, bruto: '' };
  ok(ia.pedidos.length === 1 && Object.keys(pedido.corpo).sort().join() === 'texto,turno' && !pedido.bruto.includes('Ana') && !pedido.bruto.includes('onerror'),
    'com nome: gera, e a edge function recebe só turno e texto (o nome não vai para a IA)', Object.keys(pedido.corpo).join());

  // 4. Publica fechando a herdada: nome na passagem e na pendência fechada
  console.log('\n--- Nome gravado e mostrado ---');
  await page.click('#passagem-herdadas input[value="resolvida"]');
  await valor('#passagem-herdadas [data-fechar-resolucao]', 'Resolvida no turno 1.');
  await page.click('#btn-publicar-passagem');
  await ocioso();
  st = await statusTxt();
  const nova = (await db.query(`select operador_nome, autor_email from torre.passagens_turno where turno = 'T1'`)).rows[0];
  const fechada = (await db.query(`select resolvido_nome, resolvido_email, status from torre.passagem_pendencias where texto = 'Pendência antiga sem nome'`)).rows[0];
  ok(/^Passagem publicada\./.test(st) && nova && nova.operador_nome === NOME_XSS && nova.autor_email === 'admin@teste.local', 'publicou: nome na passagem (e o e-mail do login continua gravado)', st);
  ok(fechada && fechada.status === 'resolvida' && fechada.resolvido_nome === NOME_XSS && fechada.resolvido_email === 'admin@teste.local', 'a herdada fechada guarda o nome de quem fechou', fechada);
  ok((await nomeCampo()).valor === NOME_XSS, 'depois de publicar o nome continua no campo (para a próxima)');

  const topo = await page.evaluate(() => ({ meta: document.querySelector('#passagem-ultima .passagem-meta').textContent, img: document.querySelectorAll('#passagem-ultima img').length }));
  ok(/^T1 · \d{2}\/\d{2} \d{2}:\d{2} · por Ana <img src=x onerror="window.__xss=1">$/.test(topo.meta) && topo.img === 0, 'topo: "T1 · dd/mm hh:mm · por <nome>" (como texto)', topo.meta);
  const hist = await page.$$eval('#passagem-historico .passagem-item summary', s => s.map(x => x.textContent.replace(/\s+/g, ' ').trim()));
  ok(hist.length === 2 && /^T1 .* por Ana <img src=x onerror="window.__xss=1"> · /.test(hist[0]) && /^T3 .* por não informado · /.test(hist[1]), 'histórico: nome da nova e "não informado" na antiga', hist);

  // 5. Histórico de pendências: quem criou e quem resolveu
  await page.click('#nav-link-pendencias');
  await ocioso();
  const itens = await page.$$eval('#pendencias-lista .pendencia-item', els => els.map(e => e.textContent.replace(/\s+/g, ' ').trim()));
  const antiga = itens.find(t => t.includes('Pendência antiga sem nome')) || '';
  const criada = itens.find(t => t.includes('Conferir os canhotos do CD Cajamar')) || '';
  ok(/criada por não informado/.test(antiga) && /Resolvida por Ana <img src=x onerror="window.__xss=1"> em \d{2}\/\d{2}\/\d{4}/.test(antiga), 'pendência antiga: criada por "não informado", resolvida pelo nome', antiga.slice(0, 220));
  ok(/criada por Ana <img src=x onerror="window.__xss=1">/.test(criada) && /Ainda aberta/.test(criada), 'pendência nova: criada pelo nome de quem publicou', criada.slice(0, 160));
  ok(await page.$$eval('#pendencias-lista img, #torre-passagem img', i => i.length) === 0, 'nenhum <img> do nome virou elemento');

  // 6. 390 px
  await page.click('#nav-link-passagem');
  await ocioso();
  await page.setViewport({ width: 390, height: 844 });
  await esperar(300);
  const m390 = await page.evaluate(() => {
    const el = document.getElementById('passagem-operador-nome');
    const b = el.getBoundingClientRect();
    return { rolagem: document.documentElement.scrollWidth > window.innerWidth, dentro: b.left >= 0 && b.right <= window.innerWidth + 1 && b.width > 200 };
  });
  ok(!m390.rolagem && m390.dentro, '390px: sem rolagem lateral e "Seu nome" dentro da tela', m390);
  await page.evaluate(() => { document.getElementById('passagem-operador-nome').scrollIntoView({ block: 'start' }); window.scrollBy(0, -70); });
  await esperar(150);
  await page.screenshot({ path: path.join(RAIZ, 'testes/capturas/torre_nome_operador_390.png') });
  // O texto de ajuda "Todos usam o mesmo login..." saiu da tela; o campo continua obrigatório
  const semAjuda = await page.evaluate(() => {
    const el = document.getElementById('passagem-operador-nome');
    return { texto: /Todos usam o mesmo login|Não vai para a IA/.test(document.getElementById('torre-passagem').textContent),
      required: el.required, ajudaNoCampo: !!el.closest('label').querySelector('.passagem-ajuda') };
  });
  ok(!semAjuda.texto && !semAjuda.ajudaNoCampo && semAjuda.required, 'texto "Todos usam o mesmo login..." não aparece mais; "Seu nome" segue obrigatório', semAjuda);
  for (const largura of [1366, 390]) {
    await page.setViewport({ width: largura, height: largura === 390 ? 844 : 900 });
    await esperar(250);
    await page.evaluate(() => { document.getElementById('form-passagem').scrollIntoView({ block: 'start' }); window.scrollBy(0, -70); });
    await esperar(150);
    await page.screenshot({ path: path.join(RAIZ, `testes/capturas/torre_passagem_sem_ajuda_${largura}.png`) });
  }
  await page.setViewport({ width: 1366, height: 900 });

  // 7. Sem localStorage (navegador bloqueando): a tela continua funcionando, só não lembra
  console.log('\n--- Sem localStorage ---');
  const p2 = await browser.newPage();
  p2.on('pageerror', e => erros.push('[sem localStorage] ' + String(e)));
  await p2.setRequestInterception(true);
  p2.on('request', r => {
    const u = r.url();
    if (u.includes('@supabase/supabase-js')) return r.respond({ status: 200, contentType: 'text/javascript', body: SUPABASE_FALSO });
    if (!u.startsWith(base)) return r.respond({ status: 200, contentType: 'text/css', body: '' });
    r.continue();
  });
  await p2.exposeFunction('__torreBanco', async (papel, pedido) => {
    const claims = JSON.stringify({ sub: SUBS.admin, role: 'authenticated', email: 'admin@teste.local', app_metadata: { role: 'admin' } });
    try {
      const data = await db.transaction(async (tx) => {
        await tx.query(`select set_config('request.jwt.claims', $1, true)`, [claims]);
        await tx.query('set local role authenticated');
        const [sql, params] = montarSql(pedido);
        return (await tx.query(sql, params)).rows[0].j;
      });
      return { data, error: null };
    } catch (e) { return { data: null, error: { message: e.message, code: e.code || '' } }; }
  });
  // auth.js guarda o usuário no localStorage: aqui só o "Seu nome" falha (como um bloqueio parcial)
  await p2.evaluateOnNewDocument(() => {
    const ler = Storage.prototype.getItem, gravar = Storage.prototype.setItem;
    Storage.prototype.getItem = function (k) { if (k === 'torre_operador_nome') throw new Error('bloqueado'); return ler.call(this, k); };
    Storage.prototype.setItem = function (k, v) { if (k === 'torre_operador_nome') throw new Error('bloqueado'); return gravar.call(this, k, v); };
  });
  await p2.goto(`${base}/HTML/Login.html`).catch(() => { });
  await p2.evaluate(() => { localStorage.setItem('teste_papel', 'admin'); });
  await p2.goto(`${base}${TORRE}#passagem`, { waitUntil: 'load' });
  await esperar(1200);
  await p2.$eval('#passagem-operador-nome', (el) => { el.value = 'Carla'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  const semLs = await p2.evaluate(() => ({ visivel: !document.getElementById('torre-passagem').hidden, nome: document.getElementById('passagem-operador-nome').value }));
  ok(semLs.visivel && semLs.nome === 'Carla', 'sem localStorage para o nome: a tela abre e o campo funciona (só não lembra)', semLs);
  await p2.close();

  ok(!(await page.evaluate(() => window.__xss)), 'escapeHtml: nenhum <img onerror> do nome executou');
  const errosJs = erros.filter(e => !/Failed to fetch|Swiper/.test(e));
  ok(errosJs.length === 0, 'sem erros de JS', errosJs.join(' | '));
  console.log(falhas ? `\n${falhas} FALHA(S)` : '\nTUDO OK');
  await browser.close(); srv.close(); await db.close();
  process.exit(falhas ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
