// Barra lateral recolhível pelo logo nos dois dashboards: clique no logo e no "<" (frota), Enter e
// espaço, aria-label/aria-expanded, só ícones (textos e números somem), title com o nome do item,
// conteúdo ocupa o espaço, escolha lembrada ao recarregar (chave por dashboard), 1366 e 1920 px sem
// rolagem lateral; no celular o comportamento de antes (gaveta da frota; barra do cadastro escondida).
const { abrir } = require('./harness');

const LARGURAS = (process.argv[2] || '1366,1920').split(',').map(Number);
const ADMIN = { role: 'admin', nome: 'Gestão Teste', id: 'admin-1', email: 'gestao@exemplo.invalid' };

(async () => {
  const { srv, base, browser, page, erros } = await abrir({});
  // Chart.js vem do CDN (vazio no teste): sem ele a inicialização da frota para antes da barra lateral
  await page.evaluateOnNewDocument(() => {
    window.Chart = class { constructor() { } destroy() { } update() { } static getChart() { return null; } };
    // No site a sessão é conferida no servidor (assíncrono); o auth falso chama na hora e esbarra nos
    // let do fim do dashboard-admin.js. Aqui o retorno vem depois, como no site.
    let aoAutenticar;
    Object.defineProperty(window, 'ajbAoAutenticar', {
      configurable: true,
      get: () => aoAutenticar,
      set: (fn) => { aoAutenticar = (...args) => setTimeout(() => fn(...args), 0); }
    });
  });
  await page.goto(`${base}/HTML/index.html`, { waitUntil: 'load' });
  const espera = (ms) => new Promise(res => setTimeout(res, ms));
  const estado = () => page.evaluate(() => {
    const layout = document.querySelector('.admin-app-layout');
    const sb = document.getElementById('admin-sidebar');
    const main = document.querySelector('.admin-main-wrapper');
    const logo = document.getElementById('sidebar-brand');
    const visivel = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); return getComputedStyle(el).display !== 'none' && r.width > 1 && r.height > 1; };
    const lr = logo.getBoundingClientRect();
    return {
      recolhida: layout.classList.contains('sidebar-recolhida'),
      larguraBarra: Math.round(sb.getBoundingClientRect().width),
      margemConteudo: getComputedStyle(main).marginLeft,
      larguraConteudo: Math.round(main.getBoundingClientRect().width),
      ariaLabel: logo.getAttribute('aria-label'), ariaExpanded: logo.getAttribute('aria-expanded'),
      logoVisivel: lr.width > 0 && lr.left >= 0 && lr.right <= sb.getBoundingClientRect().right + 0.5,
      textosVisiveis: Array.from(sb.querySelectorAll('.nav-text, .brand-info, .user-details, .nav-group-label, .btn-logout-sidebar span')).filter(visivel).length,
      numerosVisiveis: Array.from(sb.querySelectorAll('.badge-pendentes-sidebar')).filter(visivel).map(b => b.textContent.trim()),
      icones: Array.from(sb.querySelectorAll('.nav-link .nav-icon, .user-avatar-circle, .btn-logout-sidebar svg')).filter(visivel).length,
      iconesDentro: Array.from(sb.querySelectorAll('.nav-link .nav-icon, .user-avatar-circle, .btn-logout-sidebar svg')).filter(visivel).every(i => i.getBoundingClientRect().right <= sb.getBoundingClientRect().right),
      dicas: Array.from(sb.querySelectorAll('.nav-link, .user-profile-badge')).map(l => l.getAttribute('title') || '(sem title)'),
      nomeAcessivelDosLinks: Array.from(sb.querySelectorAll('.nav-link')).map(l => l.textContent.replace(/\s+/g, ' ').trim()).join(' / '),
      rolagemH: document.documentElement.scrollWidth > window.innerWidth,
      transicao: getComputedStyle(sb).transitionDuration
    };
  });
  const r = {};

  for (const [nome, url, chave] of [['frota', 'dashboard-admin.html', 'ajborges_sidebar_recolhida_frota'], ['cadastro', 'Dashboard-cadastro-motorista.html', 'ajborges_sidebar_recolhida_cadastro']]) {
    for (const w of LARGURAS) {
      await page.setViewport({ width: w, height: 900 });
      await page.evaluate((u) => { localStorage.clear(); localStorage.setItem('teste_usuario', JSON.stringify(u)); }, ADMIN);
      await page.goto(`${base}/HTML/${url}`, { waitUntil: 'load' });
      await espera(400);
      const t = {};
      t.inicio = await estado();
      await page.click('#sidebar-brand');
      await espera(350);
      t.cliqueNoLogo = await estado();
      t.gravado = await page.evaluate((k) => localStorage.getItem(k), chave);
      await page.reload({ waitUntil: 'load' });
      await espera(400);
      t.depoisDeRecarregar = await estado();
      await page.focus('#sidebar-brand');
      await page.keyboard.press('Enter');
      await espera(350);
      t.enter = await estado();
      await page.keyboard.press('Space');
      await espera(350);
      t.espaco = (await estado()).recolhida;
      await page.keyboard.press('Space');
      await espera(350);
      t.espacoDeNovo = (await estado()).recolhida;
      if (nome === 'frota') {
        // "<" (aberta) recolhe; recolhida ele some e o logo abre de novo
        await page.click('#btn-toggle-sidebar');
        await espera(350);
        t.botaoMenorQueRecolhe = (await estado()).recolhida;
        t.botaoMenorQueComARecolhida = await page.$eval('#btn-toggle-sidebar', b => getComputedStyle(b).display !== 'none' ? 'visível' : 'escondido');
        await page.click('#sidebar-brand');
        await espera(350);
        t.logoAbreDepoisDoMenorQue = !(await estado()).recolhida;
      }
      t.outroDashboardNaoMexe = await page.evaluate((k) => Object.keys(localStorage).filter(c => c.startsWith('ajborges_sidebar_') && c !== k), chave);
      r[`${nome} ${w}px`] = t;
    }

    // Celular (390): nada muda
    await page.setViewport({ width: 390, height: 800 });
    await page.evaluate((u, k) => { localStorage.clear(); localStorage.setItem('teste_usuario', JSON.stringify(u)); localStorage.setItem(k, '1'); }, ADMIN, chave);
    await page.goto(`${base}/HTML/${url}`, { waitUntil: 'load' });
    await espera(400);
    const cel = {};
    const gaveta = () => page.evaluate(() => {
      const sb = document.getElementById('admin-sidebar');
      const r = sb.getBoundingClientRect();
      return `${r.right <= 0 ? 'escondida' : 'aberta'} (${Math.round(r.width)}px), conteúdo margin-left ${getComputedStyle(document.querySelector('.admin-main-wrapper')).marginLeft}, rolagemH=${document.documentElement.scrollWidth > window.innerWidth ? 'SIM' : 'não'}`;
    });
    cel.inicioComRecolhidaGravada = await gaveta();
    if (nome === 'frota') {
      await page.click('#btn-mobile-menu');
      await espera(400);
      cel.hamburguer = await gaveta();
      await page.click('#btn-toggle-sidebar');
      await espera(400);
      cel.botaoMenorQue = await gaveta();
    } else {
      await page.$eval('#sidebar-brand', el => el.click());
      await espera(400);
      cel.cliqueNoLogo = await gaveta();
    }
    r[`${nome} 390px`] = cel;
  }

  r.erros = erros.filter(e => !/Chart is not defined/.test(e));
  console.log(JSON.stringify(r, null, 2));
  await browser.close(); srv.close();
})().catch(e => { console.error(e); process.exit(1); });
