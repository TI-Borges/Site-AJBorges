// Barra lateral padrão nos dashboards (Frota, Cadastro, Torre, RH), modelo do RH:
// "SISTEMAS & PAINÉIS" + "Hub de Dashboard" (mesmo ícone) abrindo o escolhaDashboard; rodapé com
// avatar (iniciais), e-mail, selo do perfil vindo do login com ponto verde e o botão vermelho "Sair"
// (mesmo logout da Frota: confirma e chama ajbAuth.sair); mesmos tamanhos/fontes/raios nos 4, só a
// cor de destaque muda; nenhum Hub/Sair fora da barra; recolhida pelo logo (só ícones com title,
// lembrada ao recarregar); 1366/1920 sem rolagem lateral; 390 com a gaveta.
// Uso: node testes/t_sidebar_padrao.js [frota,cadastro,torre,rh]
const { abrir } = require('./harness');

const TODOS = {
  frota: { url: '/HTML/dashboard-admin.html', chave: 'ajborges_sidebar_recolhida_frota', cor: '#6366f1' },
  cadastro: { url: '/HTML/Dashboard-cadastro-motorista.html', chave: 'ajborges_sidebar_recolhida_cadastro', cor: '#4f9a85' },
  torre: { url: '/torre-de-controle-shoppe/HTML/index.html', chave: 'ajborges_sidebar_recolhida_torre', cor: '#ee4d2d' },
  rh: { url: '/dashboard-rh/HTML/index.html', chave: 'ajborges_sidebar_recolhida_rh', cor: '#7c3aed' }
};
const PAPEIS = { frota: ['admin', 'diretoria'], cadastro: ['admin', 'diretoria'], torre: ['admin', 'diretoria'], rh: ['admin', 'rh'] };
const SELO = { admin: 'ADMINISTRADOR', diretoria: 'DIRETORIA', rh: 'RECURSOS HUMANOS' };
const nomes = (process.argv[2] || 'frota,cadastro,torre,rh').split(',');

let falhas = 0;
const ok = (cond, msg, extra = '') => {
  console.log(`${cond ? 'OK   ' : 'FALHA'} ${msg}${extra !== '' ? ` (${typeof extra === 'string' ? extra : JSON.stringify(extra)})` : ''}`);
  if (!cond) falhas++;
};
const espera = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const { srv, base, browser, page, erros } = await abrir({});
  await page.evaluateOnNewDocument(() => {
    window.Chart = class { constructor() { } destroy() { } update() { } static getChart() { return null; } };
    // Sessão conferida "no servidor" depois (assíncrono, como no site)
    let aoAutenticar;
    Object.defineProperty(window, 'ajbAoAutenticar', {
      configurable: true, get: () => aoAutenticar,
      set: (fn) => { aoAutenticar = (...a) => setTimeout(() => fn(...a), 0); }
    });
    // Sair: registra o destino em vez de deslogar
    let auth;
    Object.defineProperty(window, 'ajbAuth', {
      configurable: true, get: () => auth,
      set: (v) => { auth = v; auth.limparDadosLocais = auth.limparDadosLocais || (() => { }); auth.sair = (d) => { sessionStorage.setItem('teste_saiu', d); }; }
    });
    // Banco simulado: toda consulta devolve lista vazia, sem erro
    const vazio = { data: [], error: null, count: 0 };
    const consulta = () => new Proxy(function () { }, {
      get: (_, k) => k === 'then' ? (res) => res(vazio) : consulta(),
      apply: () => consulta()
    });
    const cliente = consulta();
    Object.defineProperty(window, 'supabaseClient', { configurable: true, get: () => cliente, set: () => { } });
  });

  const medir = () => page.evaluate(() => {
    const sb = document.querySelector('aside.ajb-sidebar');
    if (!sb) return null;
    const cs = (el, ...p) => { if (!el) return null; const c = getComputedStyle(el); return p.map(x => c[x]).join(' '); };
    const visivel = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); return getComputedStyle(el).display !== 'none' && r.width > 1 && r.height > 1; };
    const hub = sb.querySelector('#sidebar-link-hub');
    const sair = sb.querySelector('#btn-logout');
    const grupo = sb.querySelector('.nav-group-sistemas');
    const foraDaBarra = Array.from(document.querySelectorAll('a, button')).filter(el => !sb.contains(el) && visivel(el))
      .filter(el => /^(hub|sair)$/i.test(el.textContent.replace(/\s+/g, ' ').trim()) || /escolhaDashboard/.test(el.getAttribute('href') || '') || /logout|sair/i.test(el.id + ' ' + el.className))
      .map(el => `${el.tagName}#${el.id}.${el.className}`);
    return {
      grupo: grupo ? grupo.textContent.trim() : null,
      hubTexto: hub ? hub.querySelector('.nav-text').textContent.trim() : null,
      hubHref: hub ? hub.getAttribute('href') : null,
      hubIcone: hub ? hub.querySelector('svg').innerHTML.replace(/\s+/g, ' ').trim() : null,
      email: (sb.querySelector('#sidebar-user-email') || {}).textContent,
      selo: (sb.querySelector('#sidebar-user-role') || {}).textContent,
      avatar: (sb.querySelector('#user-avatar-initials') || {}).textContent,
      pontoVerde: cs(sb.querySelector('.pulse-online'), 'backgroundColor'),
      sairTexto: sair ? sair.textContent.trim() : null,
      sairCor: cs(sair, 'color'),
      foraDaBarra,
      // Medidas que têm de ser iguais nos 4
      medidas: {
        barra: Math.round(sb.getBoundingClientRect().width),
        fundo: cs(sb, 'backgroundColor'),
        topo: cs(sb.querySelector('.sidebar-header'), 'height', 'paddingLeft'),
        logo: cs(sb.querySelector('.brand-logo-wrapper'), 'width', 'height', 'borderRadius'),
        marca: cs(sb.querySelector('.brand-name'), 'fontFamily', 'fontSize', 'fontWeight'),
        etiqueta: cs(sb.querySelector('.brand-tag'), 'fontSize', 'fontWeight', 'textTransform'),
        nav: cs(sb.querySelector('.sidebar-nav'), 'paddingTop', 'paddingLeft'),
        grupo: cs(grupo, 'fontSize', 'fontWeight', 'letterSpacing', 'color', 'marginTop', 'paddingLeft'),
        hub: cs(hub, 'paddingTop', 'paddingLeft', 'fontSize', 'fontWeight', 'fontFamily', 'borderRadius', 'gap', 'height'),
        icone: cs(hub && hub.querySelector('svg'), 'width', 'height'),
        rodape: cs(sb.querySelector('.sidebar-footer'), 'paddingTop', 'paddingLeft', 'gap', 'backgroundColor'),
        avatar: cs(sb.querySelector('.user-avatar-circle'), 'width', 'height', 'borderRadius', 'fontSize', 'fontFamily'),
        email: cs(sb.querySelector('.user-email'), 'fontSize', 'fontWeight', 'color'),
        selo: cs(sb.querySelector('.role-tag'), 'fontSize', 'fontWeight', 'textTransform', 'borderRadius'),
        ponto: cs(sb.querySelector('.pulse-online'), 'width', 'height', 'backgroundColor'),
        sair: cs(sair, 'height', 'paddingTop', 'borderRadius', 'fontSize', 'fontWeight', 'backgroundColor', 'color')
      },
      destaque: getComputedStyle(sb).getPropertyValue('--sb-cor').trim(),
      rolagemH: document.documentElement.scrollWidth > window.innerWidth
    };
  });

  const estadoRecolhida = () => page.evaluate(() => {
    const sb = document.querySelector('aside.ajb-sidebar');
    const visivel = (el) => { const r = el.getBoundingClientRect(); return getComputedStyle(el).display !== 'none' && r.width > 1 && r.height > 1; };
    return {
      largura: Math.round(sb.getBoundingClientRect().width),
      textosVisiveis: Array.from(sb.querySelectorAll('.nav-text, .brand-info, .user-details, .nav-group-label, .btn-logout-sidebar span')).filter(visivel).length,
      iconesVisiveis: Array.from(sb.querySelectorAll('.nav-link .nav-icon, .user-avatar-circle, .btn-logout-sidebar svg')).filter(visivel).length,
      semTitle: Array.from(sb.querySelectorAll('.nav-link, #btn-logout, .user-profile-badge')).filter(el => !(el.getAttribute('title') || '').trim()).map(el => el.id || el.className),
      titleHub: document.getElementById('sidebar-link-hub').title,
      titleSair: document.getElementById('btn-logout').title,
      rolagemH: document.documentElement.scrollWidth > window.innerWidth
    };
  });

  const referencia = {};
  for (const nome of nomes) {
    const d = TODOS[nome];
    console.log(`\n--- ${nome} ---`);
    for (const papel of PAPEIS[nome]) {
      const usuario = { role: papel, nome: 'Maria Teste Silva', id: `u-${papel}`, email: `${papel}.teste@exemplo.invalid` };
      for (const w of [1366, 1920]) {
        await page.setViewport({ width: w, height: 900 });
        await page.goto(`${base}/HTML/Login.html`, { waitUntil: 'load' }).catch(() => { });
        await page.evaluate((u) => { localStorage.clear(); sessionStorage.clear(); localStorage.setItem('teste_usuario', JSON.stringify(u)); }, usuario);
        await page.goto(`${base}${d.url}`, { waitUntil: 'load' });
        await espera(500);
        const m = await medir();
        if (!m) { ok(false, `${nome} ${w}px: barra .ajb-sidebar encontrada`); continue; }
        const tag = `${nome} ${papel} ${w}px`;
        ok(m.grupo === 'SISTEMAS & PAINÉIS', `${tag}: título "SISTEMAS & PAINÉIS"`, m.grupo);
        ok(m.hubTexto === 'Hub de Dashboard' && m.hubHref === '/HTML/escolhaDashboard.html', `${tag}: item "Hub de Dashboard" -> escolhaDashboard`, `${m.hubTexto} ${m.hubHref}`);
        ok(m.email === usuario.email, `${tag}: e-mail de quem está logado`, m.email);
        ok(m.selo === SELO[papel], `${tag}: selo do perfil vindo do login`, m.selo);
        ok(m.avatar === 'MS', `${tag}: avatar com iniciais`, m.avatar);
        ok(m.pontoVerde === 'rgb(16, 185, 129)', `${tag}: ponto verde`, m.pontoVerde);
        ok(m.sairTexto === 'Sair' && m.sairCor === 'rgb(248, 113, 113)', `${tag}: botão vermelho "Sair"`, `${m.sairTexto} ${m.sairCor}`);
        ok(m.foraDaBarra.length === 0, `${tag}: nenhum Hub/Sair fora da barra lateral`, m.foraDaBarra.join(', '));
        ok(!m.rolagemH, `${tag}: sem rolagem lateral`);
        if (w === 1366 && papel === PAPEIS[nome][0]) {
          referencia[nome] = { medidas: m.medidas, hubIcone: m.hubIcone, destaque: m.destaque };

          // Sair: confirma e chama o logout da Frota (ajbAuth.sair para o login)
          page._dialogos = [];
          await page.click('#btn-logout');
          await espera(200);
          const saiu = await page.evaluate(() => sessionStorage.getItem('teste_saiu'));
          ok(saiu === '/HTML/Login.html#admin' && (page._dialogos || []).length === 1, `${nome}: Sair confirma uma vez e desloga`, `${saiu} | ${(page._dialogos || []).join(' / ')}`);

          // Recolhida pelo logo: só ícones com title, lembrada ao recarregar
          await page.click('#sidebar-brand');
          await espera(400);
          const r1 = await estadoRecolhida();
          ok(r1.largura === 74 && r1.textosVisiveis === 0 && r1.iconesVisiveis > 3, `${nome}: logo recolhe (só ícones)`, r1);
          ok(r1.semTitle.length === 0 && r1.titleHub === 'Hub de Dashboard' && r1.titleSair === 'Sair', `${nome}: recolhida, cada ícone com tooltip`, r1.semTitle.join(', '));
          ok(await page.evaluate(k => localStorage.getItem(k), d.chave) === '1', `${nome}: grava a escolha em ${d.chave}`);
          await page.reload({ waitUntil: 'load' });
          await espera(500);
          const r2 = await estadoRecolhida();
          ok(r2.largura === 74 && r2.textosVisiveis === 0 && !r2.rolagemH, `${nome}: lembra recolhida ao recarregar`, r2);
          await page.click('#sidebar-brand');
          await espera(400);
          ok((await estadoRecolhida()).largura === 268, `${nome}: logo abre de novo`);

          // Hub abre o escolhaDashboard
          await Promise.all([page.waitForNavigation({ waitUntil: 'load' }).catch(() => { }), page.click('#sidebar-link-hub')]);
          ok(/\/HTML\/escolhaDashboard\.html$/.test(new URL(page.url()).pathname), `${nome}: Hub abre o escolhaDashboard`, new URL(page.url()).pathname);
        }
      }
    }

    // Celular: gaveta pelo menu, rodapé completo dentro da tela
    await page.setViewport({ width: 390, height: 800 });
    await page.evaluate((k) => { localStorage.setItem(k, '1'); }, d.chave);
    await page.goto(`${base}${d.url}`, { waitUntil: 'load' });
    await espera(500);
    const fechada = await page.evaluate(() => document.querySelector('aside.ajb-sidebar').getBoundingClientRect().right <= 0);
    await page.click('#btn-mobile-menu');
    await espera(450);
    const cel = await page.evaluate(() => {
      const sb = document.querySelector('aside.ajb-sidebar');
      const r = sb.getBoundingClientRect();
      const dentro = (sel) => { const e = sb.querySelector(sel); if (!e) return false; const x = e.getBoundingClientRect(); return x.width > 1 && x.left >= 0 && x.right <= window.innerWidth && getComputedStyle(e).display !== 'none'; };
      return { aberta: r.left >= 0 && r.width > 200, largura: Math.round(r.width), email: dentro('#sidebar-user-email'), selo: dentro('#sidebar-user-role'), sair: dentro('#btn-logout .nav-text, #btn-logout span'), hub: dentro('#sidebar-link-hub .nav-text'), rolagemH: document.documentElement.scrollWidth > window.innerWidth };
    });
    ok(fechada && cel.aberta && cel.email && cel.selo && cel.sair && cel.hub && !cel.rolagemH, `${nome} 390px: gaveta abre completa (mesmo com recolhida gravada)`, cel);
  }

  // Mesmas medidas nos dashboards testados; só a cor de destaque muda
  const lista = Object.keys(referencia);
  if (lista.length > 1) {
    const base0 = referencia[lista[0]];
    for (const nome of lista.slice(1)) {
      const dif = Object.keys(base0.medidas).filter(k => base0.medidas[k] !== referencia[nome].medidas[k])
        .map(k => `${k}: ${lista[0]}=${base0.medidas[k]} | ${nome}=${referencia[nome].medidas[k]}`);
      ok(dif.length === 0, `${nome} igual a ${lista[0]} (tamanhos, espaçamentos, fontes, raios)`, dif.join(' ; '));
      ok(referencia[nome].hubIcone === base0.hubIcone, `${nome}: mesmo ícone do Hub que ${lista[0]}`);
    }
    const cores = lista.map(n => referencia[n].destaque);
    ok(new Set(cores).size === lista.length, 'cor de destaque diferente em cada um', cores.join(' / '));
  }
  for (const nome of lista) ok(referencia[nome].destaque === TODOS[nome].cor, `${nome}: cor de destaque certa`, referencia[nome].destaque);

  const errosJs = erros.filter(e => !/Swiper is not defined|Chart is not defined/.test(e));
  ok(errosJs.length === 0, 'sem erros de JS', errosJs.join(' | '));
  console.log(falhas ? `\n${falhas} FALHA(S)` : '\nTUDO OK');
  await browser.close(); srv.close();
  process.exit(falhas ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
