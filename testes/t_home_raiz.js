// Home na raiz: o servidor de teste imita as regras do .htaccess (lidas do próprio arquivo):
// "/" mostra HTML/index.html sem mudar o endereço e /HTML/index.html (ou /HTML/) responde 301 para "/".
// Confere imagens, CSS e JS carregados na raiz, o 301, os links do menu e 390 px sem rolagem lateral.
// Uso: node testes/t_home_raiz.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const RAIZ = path.resolve(__dirname, '..');
const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
let falhas = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'OK  ' : 'FALHA'} ${msg}`); if (!cond) falhas++; };

// Regras do .htaccess (as linhas novas), transformadas em RegExp do JS
const ht = fs.readFileSync(path.join(RAIZ, '.htaccess'), 'utf8');
const condReq = new RegExp(ht.match(/^RewriteCond %\{THE_REQUEST\} (\S+)$/m)[1]);
const regra301 = new RegExp(ht.match(/^RewriteRule (\S+) https:\/\/%\{HTTP_HOST\}\/ \[L,R=301\]$/m)[1]);
ok(/^RewriteRule \^\$ HTML\/index\.html \[L\]$/m.test(ht), '.htaccess: raiz reescreve (sem R) para HTML/index.html');
ok(!/R=302/.test(ht), '.htaccess: o 302 antigo da raiz saiu');
// Mesma conta do Apache: caminho sem a barra inicial (per-dir) + linha do pedido
const redireciona = (url) => { const p = url.split('?')[0].replace(/^\//, ''); return regra301.test(p) && condReq.test(`GET ${url} HTTP/1.1`); };
ok(redireciona('/HTML/index.html') && redireciona('/HTML/') && redireciona('/HTML/index.html?x=1'), 'regra 301 pega /HTML/index.html, /HTML/ e com ?query');
ok(!redireciona('/HTML/Login.html') && !redireciona('/HTML/index.html.bak') && !redireciona('/torre-de-controle-shoppe/HTML/index.html') && !redireciona('/dashboard-rh/HTML/index.html'), 'regra 301 não pega outras páginas nem os index dos dashboards');
// Reescrita interna: o Apache reprocessa com o caminho HTML/index.html, mas THE_REQUEST continua "GET / ..."
ok(!(regra301.test('HTML/index.html') && condReq.test('GET / HTTP/1.1')), 'sem laço: a reescrita interna da raiz não cai no 301');

const pedidos = [];
const srv = http.createServer((req, resp) => {
  let url = decodeURIComponent(req.url.split('?')[0]);
  pedidos.push(url);
  if (url === '/JavaScript/auth.js') { resp.writeHead(200, { 'Content-Type': TIPOS['.js'] }); return resp.end(''); }
  if (redireciona(req.url)) { resp.writeHead(301, { Location: '/' }); return resp.end(); }
  if (url === '/') url = '/HTML/index.html';
  const arq = path.join(RAIZ, url);
  fs.readFile(arq, (err, dados) => {
    if (err) { resp.writeHead(404); return resp.end(); }
    resp.writeHead(200, { 'Content-Type': TIPOS[path.extname(arq).toLowerCase()] || 'application/octet-stream' });
    resp.end(dados);
  });
});

(async () => {
  await new Promise(r => srv.listen(0, r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const browser = await puppeteer.launch({ executablePath: process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  const erros = [];
  const nao200 = [];
  // O CDN fica vazio no teste (como no harness): o "Swiper is not defined" do carrossel é esperado aqui
  page.on('pageerror', e => { if (!/Swiper is not defined/.test(String(e))) erros.push(String(e)); });
  page.on('response', r => { if (r.url().startsWith(base) && r.status() >= 400) nao200.push(`${r.status()} ${r.url()}`); });
  await page.setRequestInterception(true);
  page.on('request', r => (r.url().startsWith(base) ? r.continue() : r.respond({ status: 200, contentType: 'text/javascript', body: '' })));

  for (const largura of [1366, 390]) {
    await page.setViewport({ width: largura, height: 900 });
    pedidos.length = 0; nao200.length = 0;
    await page.goto(base + '/', { waitUntil: 'load' });
    // As fotos do carrossel/frota são lazy: rola até o fim para todas pedirem
    await page.evaluate(async () => { for (let y = 0; y < document.body.scrollHeight; y += 400) { window.scrollTo(0, y); await new Promise(r => setTimeout(r, 30)); } window.scrollTo(0, 0); });
    await new Promise(r => setTimeout(r, 400));
    const m = await page.evaluate(() => ({
      url: location.pathname,
      titulo: document.title,
      imgsQuebradas: [...document.images].filter(i => i.getAttribute('src') && i.complete && i.naturalWidth === 0).map(i => i.getAttribute('src')),
      logoOk: document.querySelector('.logotipo-AJBorges img').naturalWidth > 0,
      cssOk: getComputedStyle(document.querySelector('.header-AJBorges')).display === 'flex',
      folhas: [...document.styleSheets].filter(s => s.href && s.href.includes('/CSS/')).length,
      logoHref: document.querySelector('.logo-link').getAttribute('href'),
      links: [...document.querySelectorAll('a[href]')].map(a => a.href).filter(h => h.startsWith(location.origin)),
      rolagemH: document.documentElement.scrollWidth > window.innerWidth
    }));
    ok(m.url === '/', `${largura}px: a raiz fica em "/" (sem redirecionar)`);
    ok(/AJBorges/.test(m.titulo), `${largura}px: título da home`);
    ok(m.logoOk && m.imgsQuebradas.length === 0, `${largura}px: imagens carregadas (quebradas: ${m.imgsQuebradas.join(', ') || 'nenhuma'})`);
    ok(m.cssOk && m.folhas === 2, `${largura}px: style.css e frota-agregados.css aplicados`);
    ok(pedidos.includes('/JavaScript/supabase-client.js') && pedidos.includes('/JavaScript/aviso-atualizacao.js'), `${largura}px: JS da home pedidos em /JavaScript/`);
    ok(nao200.length === 0, `${largura}px: nenhum 404 (${nao200.join(', ') || 'ok'})`);
    ok(erros.length === 0, `${largura}px: sem erro de JS (${erros.join(' | ') || 'ok'})`);
    ok(m.logoHref === '/', `${largura}px: logo aponta para "/"`);
    ok(!m.rolagemH, `${largura}px: sem rolagem horizontal`);
    // Cada link interno da home abre um arquivo que existe
    const quebrados = [];
    for (const h of [...new Set(m.links.map(l => l.split('#')[0]))]) {
      const r = await fetch(h, { redirect: 'manual' });
      if (r.status !== 200) quebrados.push(`${r.status} ${h.replace(base, '')}`);
    }
    ok(quebrados.length === 0, `${largura}px: ${new Set(m.links.map(l => l.split('#')[0])).size} links internos da home abrem (${quebrados.join(', ') || 'todos 200'})`);
    if (largura === 390) await page.screenshot({ path: path.join(__dirname, 'capturas', 'home_raiz_390.png') });
  }

  // Endereço antigo: 301 para "/"
  for (const antigo of ['/HTML/index.html', '/HTML/']) {
    const r = await fetch(base + antigo, { redirect: 'manual' });
    ok(r.status === 301 && r.headers.get('location') === '/', `${antigo} responde 301 -> / (${r.status} ${r.headers.get('location')})`);
  }
  const final = await page.goto(base + '/HTML/index.html', { waitUntil: 'load' });
  ok(new URL(page.url()).pathname === '/' && final.status() === 200, 'navegador em /HTML/index.html termina em / com a home');

  // Outras páginas: o logo volta para "/" e "/" abre a home
  for (const pag of ['Contato', 'FichaMultiCadastro', 'Login', 'Nossosfretes', 'Sobrenos', 'politica-privacidade', 'relatorio-viagem']) {
    await page.goto(`${base}/HTML/${pag}.html`, { waitUntil: 'domcontentloaded' });
    const href = await page.$eval('.logo-link', a => a.getAttribute('href'));
    ok(href === '/', `${pag}: logo aponta para "/"`);
  }
  await page.goto(`${base}/HTML/Contato.html`, { waitUntil: 'load' });
  await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), page.click('.logo-link')]);
  ok(new URL(page.url()).pathname === '/' && await page.$('.hero-carousel-container') !== null, 'clicar no logo do Contato abre a home na raiz');
  // Menu da home: clicar em "Contato" abre /HTML/Contato.html
  await page.goto(base + '/', { waitUntil: 'load' });
  await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), page.click('.lista-links a[href="/HTML/Contato.html"]')]);
  ok(new URL(page.url()).pathname === '/HTML/Contato.html', 'menu da home: Contato abre /HTML/Contato.html');

  // Links do JS que voltavam para index.html
  const fichaJs = fs.readFileSync(path.join(RAIZ, 'JavaScript/FichaMultiCadastro.js'), 'utf8');
  const relJs = fs.readFileSync(path.join(RAIZ, 'JavaScript/relatorio.js'), 'utf8');
  ok(fichaJs.includes('href="/">Página principal') && !/href="index\.html"/.test(fichaJs), 'FichaMultiCadastro.js: "Página principal" vai para "/"');
  ok(relJs.includes("window.location.href = '/';") && !/'index\.html'/.test(relJs), 'relatorio.js: voltar à página principal vai para "/"');

  await browser.close(); srv.close();
  console.log(falhas ? `\n${falhas} FALHA(S)` : '\nTudo certo');
  process.exit(falhas ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
