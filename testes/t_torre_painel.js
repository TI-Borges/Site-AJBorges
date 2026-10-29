// Seleção de painéis com 4 cards (Portal da Frota, Cadastro, Torre Shoppe, RH em breve)
// e acesso à Torre de Controle: admin entra, quem não é admin vai para o login.
// Uso: node testes/t_torre_painel.js [larguras]   (padrão 360,768,1440)
const http = require('http');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');
const { abrir } = require('./harness');

const LARGURAS = (process.argv[2] || '360,768,1440').split(',').map(Number);
const RAIZ = path.resolve(__dirname, '..');
const TORRE = '/torre-de-controle-shoppe/HTML/index.html';
let falhas = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'OK  ' : 'FALHA'} ${msg}`); if (!cond) falhas++; };

// Supabase falso no lugar do CDN: o auth.js real valida o papel vindo de app_metadata.role
const SUPABASE_FALSO = `
window.supabase = { createClient: () => ({
  auth: {
    getUser: async () => {
      const papel = localStorage.getItem('teste_papel');
      return papel ? { data: { user: { id: 'u1', email: 't@t', app_metadata: { role: papel }, user_metadata: {} } }, error: null }
                   : { data: { user: null }, error: { message: 'sem sessão' } };
    },
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    signOut: async () => ({})
  },
  from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) })
}) };`;

function servidorReal() {
  const tipos = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png' };
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
  // 1. Layout dos 4 cards (auth simulada pelo harness)
  const { srv, base, browser, page, erros } = await abrir({});
  for (const w of LARGURAS) {
    await page.setViewport({ width: w, height: 900 });
    await page.goto(`${base}/HTML/escolhaDashboard.html`, { waitUntil: 'load' });
    const m = await page.evaluate(() => {
      const cards = Array.from(document.querySelectorAll('.blocks-grid > .portal-card'));
      const r = cards.map(c => c.getBoundingClientRect());
      const linhas = new Set(r.map(x => Math.round(x.top))).size;
      return {
        ids: cards.map(c => c.id),
        tags: cards.map(c => c.tagName),
        linhas,
        alinhados: Math.abs(r[0].left - r[2].left) < 1 && Math.abs(r[1].left - r[3].left) < 1 && Math.abs(r[0].width - r[2].width) < 1,
        rolagemH: document.documentElement.scrollWidth > window.innerWidth,
        foraDaTela: r.filter(x => x.right > window.innerWidth + 1 || x.left < -1).length,
        torreHref: cards[2].getAttribute('href'),
        torreBotao: getComputedStyle(cards[2].querySelector('.card-button')).backgroundColor,
        rhDesab: cards[3].getAttribute('aria-disabled') === 'true' && cards[3].querySelector('.card-button').disabled,
        rhLinks: cards[3].querySelectorAll('a').length
      };
    });
    console.log(`\n${w}px:`, JSON.stringify(m));
    ok(m.ids.join() === 'card-dashboard-admin,card-dashboard-motorista,card-torre-shoppe,card-dashboard-rh', `${w}px: 4 cards na ordem`);
    ok(m.linhas === (w > 860 ? 2 : 4), `${w}px: ${w > 860 ? '2 por linha' : 'um embaixo do outro'} (${m.linhas} linhas)`);
    ok(m.alinhados, `${w}px: cards de baixo alinhados com os de cima`);
    ok(!m.rolagemH && m.foraDaTela === 0, `${w}px: sem rolagem lateral`);
    ok(m.torreHref === TORRE, `${w}px: Torre aponta para ${TORRE}`);
    ok(m.torreBotao === 'rgb(238, 77, 45)', `${w}px: botão da Torre laranja #EE4D2D`);
    ok(m.tags[3] === 'DIV' && m.rhDesab && m.rhLinks === 0, `${w}px: RH é div desabilitada, sem link`);
  }

  // RH não navega
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(`${base}/HTML/escolhaDashboard.html`, { waitUntil: 'load' });
  const antes = page.url();
  await page.click('#card-dashboard-rh');
  await page.click('#card-dashboard-rh .card-button').catch(() => {});
  await new Promise(r => setTimeout(r, 500));
  ok(page.url() === antes, 'clicar no RH não sai da página');

  // Torre navega para a página certa
  await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), page.click('#card-torre-shoppe')]);
  const torre = await page.evaluate(() => ({
    h1: document.querySelector('h1') && document.querySelector('h1').textContent.trim(),
    robots: document.querySelector('meta[name="robots"]').content,
    visivel: document.documentElement.style.visibility !== 'hidden',
    rolagemH: document.documentElement.scrollWidth > window.innerWidth
  }));
  ok(page.url() === `${base}${TORRE}`, 'clicar na Torre abre a página da Torre');
  ok(torre.h1 === 'Torre de Controle - Shoppe' && torre.visivel, 'Torre aparece para admin');
  ok(torre.robots === 'noindex, nofollow', 'Torre com noindex, nofollow');
  for (const w of LARGURAS) {
    await page.setViewport({ width: w, height: 900 });
    ok(!(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)), `Torre ${w}px sem rolagem lateral`);
  }
  ok(erros.length === 0, `sem erros de JS ${erros.length ? JSON.stringify(erros) : ''}`);
  await browser.close(); srv.close();

  // 2. Controle de sessão real (auth.js + supabase-client.js de verdade, Supabase falso)
  const srv2 = await servidorReal();
  const base2 = `http://127.0.0.1:${srv2.address().port}`;
  const browser2 = await puppeteer.launch({
    executablePath: process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: true, args: ['--no-sandbox']
  });
  const p2 = await browser2.newPage();
  await p2.setRequestInterception(true);
  p2.on('request', r => {
    const u = r.url();
    if (u.includes('@supabase/supabase-js')) return r.respond({ status: 200, contentType: 'text/javascript', body: SUPABASE_FALSO });
    if (!u.startsWith(base2)) return r.respond({ status: 200, contentType: 'text/css', body: '' });
    r.continue();
  });
  for (const papel of [null, 'motorista', 'admin', 'diretoria']) {
    await p2.goto(`${base2}/HTML/Login.html`, { waitUntil: 'domcontentloaded' });
    await p2.evaluate(p => { localStorage.clear(); if (p) localStorage.setItem('teste_papel', p); }, papel);
    await p2.goto(`${base2}${TORRE}`, { waitUntil: 'load' });
    await new Promise(r => setTimeout(r, 800));
    const url = p2.url().replace(base2, '');
    const nome = papel || 'sem sessão';
    if (papel === 'admin' || papel === 'diretoria') {
      const vis = await p2.evaluate(() => document.documentElement.style.visibility);
      ok(url === TORRE && vis === '', `${nome}: entra na Torre (${url})`);
    } else {
      ok(url === '/HTML/Login.html#admin', `${nome}: vai para o login (${url})`);
    }
  }
  await browser2.close(); srv2.close();

  console.log(`\n${falhas ? falhas + ' FALHA(S)' : 'TUDO OK'}`);
  process.exit(falhas ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
