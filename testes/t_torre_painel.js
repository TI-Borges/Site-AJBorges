// Seleção de painéis com 4 cards (Portal da Frota, Cadastro, Torre Shoppe, Dashboard - RH)
// e acesso à Torre de Controle: admin entra, quem não é admin vai para o login.
// Salva o print do card RH em testes/capturas/escolha_card_rh.png
// Uso: node testes/t_torre_painel.js [larguras]   (padrão 360,768,1440)
const http = require('http');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');
const { abrir } = require('./harness');

const LARGURAS = (process.argv[2] || '360,768,1440').split(',').map(Number);
const RAIZ = path.resolve(__dirname, '..');
const TORRE = '/torre-de-controle-shoppe/HTML/index.html';
const RH = '/dashboard-rh/HTML/index.html';
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
        rhHref: cards[3].getAttribute('href'),
        rhAtivo: !cards[3].hasAttribute('aria-disabled') && !cards[3].querySelector('.card-button').disabled,
        rhTexto: cards[3].textContent.replace(/\s+/g, ' ').trim(),
        rhTag: Array.from(cards[3].querySelectorAll('.card-tag')).map(t => t.textContent.trim()),
        rhItens: Array.from(cards[3].querySelectorAll('.card-features-list .feature-row')).map(li => li.textContent.trim()),
        rhChecks: Array.from(cards[3].querySelectorAll('.feature-check')).map(c => getComputedStyle(c).color),
        // Selo e itens com o mesmo estilo da Torre (só a cor muda)
        mesmoSelo: ['fontSize', 'fontWeight', 'borderRadius', 'paddingTop', 'textTransform']
          .filter(p => getComputedStyle(cards[2].querySelector('.card-tag'))[p] !== getComputedStyle(cards[3].querySelector('.card-tag'))[p]),
        mesmoItem: ['width', 'height', 'borderRadius']
          .filter(p => getComputedStyle(cards[2].querySelector('.feature-check'))[p] !== getComputedStyle(cards[3].querySelector('.feature-check'))[p]),
        alturaIgual: Math.abs(cards[2].getBoundingClientRect().height - cards[3].getBoundingClientRect().height) < 1,
        rhBotao: getComputedStyle(cards[3].querySelector('.card-button')).backgroundColor,
        rhFaixa: getComputedStyle(cards[3], '::before').backgroundImage,
        rhIcone: getComputedStyle(cards[3].querySelector('.card-icon-container')).color,
        rhSeta: cards[3].querySelectorAll('.arrow-icon-circle line').length === 1 && !cards[3].querySelector('.arrow-icon-circle circle'),
        // Mesmo estilo base da Torre (borda, raio, sombra, opacidade, cursor, botão)
        mesmoEstilo: ['borderTopWidth', 'borderRadius', 'boxShadow', 'opacity', 'cursor', 'paddingTop']
          .filter(p => getComputedStyle(cards[2])[p] !== getComputedStyle(cards[3])[p]),
        mesmoBotao: ['height', 'borderRadius', 'fontSize', 'fontWeight', 'color']
          .filter(p => getComputedStyle(cards[2].querySelector('.card-button'))[p] !== getComputedStyle(cards[3].querySelector('.card-button'))[p])
      };
    });
    console.log(`\n${w}px:`, JSON.stringify(m));
    ok(m.ids.join() === 'card-dashboard-admin,card-dashboard-motorista,card-torre-shoppe,card-dashboard-rh', `${w}px: 4 cards na ordem`);
    ok(m.linhas === (w > 860 ? 2 : 4), `${w}px: ${w > 860 ? '2 por linha' : 'um embaixo do outro'} (${m.linhas} linhas)`);
    ok(m.alinhados, `${w}px: cards de baixo alinhados com os de cima`);
    ok(!m.rolagemH && m.foraDaTela === 0, `${w}px: sem rolagem lateral`);
    ok(m.torreHref === TORRE, `${w}px: Torre aponta para ${TORRE}`);
    ok(m.torreBotao === 'rgb(238, 77, 45)', `${w}px: botão da Torre laranja #EE4D2D`);
    ok(m.tags[3] === 'A' && m.rhHref === RH && m.rhAtivo, `${w}px: RH é link ativo para ${RH}`);
    ok(m.rhBotao === 'rgb(124, 58, 237)' && m.rhIcone === 'rgb(124, 58, 237)', `${w}px: botão e ícone do RH violeta #7c3aed`);
    ok(m.rhFaixa.includes('rgb(124, 58, 237)'), `${w}px: faixa de cor violeta no topo do RH`);
    ok(!/em breve|em desenvolvimento/i.test(m.rhTexto), `${w}px: sem "Em breve" nem "Em desenvolvimento"`);
    ok(m.rhTag.join() === 'Gestão de Pessoas', `${w}px: selo "Gestão de Pessoas" (${m.rhTag.join()})`);
    ok(m.rhItens.join('|') === 'Admissões e rescisões com checklist|Alertas de exames periódicos|Férias e contratos PJ'
      && m.rhChecks.length === 3 && m.rhChecks.every(c => c === 'rgb(124, 58, 237)'), `${w}px: 3 itens com ✓ violeta`);
    ok(m.mesmoSelo.length === 0 && m.mesmoItem.length === 0, `${w}px: selo e ✓ no mesmo estilo da Torre ${JSON.stringify([m.mesmoSelo, m.mesmoItem])}`);
    if (w > 860) ok(m.alturaIgual, `${w}px: card RH com a mesma altura do card da Torre (mesma linha)`);
    ok(m.rhTexto.includes('Gestão de pessoas, admissões, rescisões, exames e férias.') && m.rhTexto.includes('Acessar Dashboard do RH') && m.rhSeta,
      `${w}px: descrição nova e botão "Acessar" com seta`);
    ok(m.mesmoEstilo.length === 0 && m.mesmoBotao.length === 0, `${w}px: mesmo estilo do card da Torre ${JSON.stringify([m.mesmoEstilo, m.mesmoBotao])}`);
  }

  // Hover do RH: sobe, borda e botão violeta (como os outros cards)
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(`${base}/HTML/escolhaDashboard.html`, { waitUntil: 'load' });
  await page.hover('#card-dashboard-rh');
  await new Promise(r => setTimeout(r, 500));
  const hov = await page.evaluate(() => {
    const c = document.getElementById('card-dashboard-rh');
    const s = getComputedStyle(c);
    return { borda: s.borderTopColor, transform: s.transform, botao: getComputedStyle(c.querySelector('.card-button')).backgroundColor };
  });
  ok(hov.borda === 'rgb(124, 58, 237)' && hov.transform.includes('-6') && hov.botao === 'rgb(109, 40, 217)', `hover do RH igual aos outros ${JSON.stringify(hov)}`);

  // Print do card RH
  await page.mouse.move(0, 0);
  await new Promise(r => setTimeout(r, 500));
  fs.mkdirSync(path.join(RAIZ, 'testes', 'capturas'), { recursive: true });
  const cardRh = await page.$('#card-dashboard-rh');
  await cardRh.screenshot({ path: path.join(RAIZ, 'testes', 'capturas', 'escolha_card_rh.png') });
  ok(fs.existsSync(path.join(RAIZ, 'testes', 'capturas', 'escolha_card_rh.png')), 'print salvo em testes/capturas/escolha_card_rh.png');

  // RH navega para o Dashboard do RH
  await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), page.click('#card-dashboard-rh')]);
  ok(page.url() === `${base}${RH}`, 'clicar no RH abre o Dashboard do RH');
  await page.goto(`${base}/HTML/escolhaDashboard.html`, { waitUntil: 'load' });

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
