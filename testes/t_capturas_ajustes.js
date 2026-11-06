// Prints dos ajustes de novembro (ícone de anotação, verde #235347 do cadastro, barra lateral da Torre,
// WhatsApp na aba Motoristas da Frota e ícone do caminhão) em 1366 e 390 px, com o Google Fonts carregando
// de verdade (REDE_FONTES=1). Dados INVENTADOS: nada vai para o Supabase. Também mede a rolagem lateral
// em 1366, 390, 360 e 320 (prints só em 1366 e 390).
// Uso: node testes/t_capturas_ajustes.js <antes|depois>  -> testes/capturas/ajustes_<sufixo>_<tela>_<largura>.png
process.env.REDE_FONTES = '1';
const fs = require('fs');
const path = require('path');
const { abrir } = require('./harness');
const SUF = process.argv[2] || 'atual';
const CAP = path.join(__dirname, 'capturas');
fs.mkdirSync(CAP, { recursive: true });
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const nome = (tela, largura) => path.join(CAP, `ajustes_${SUF}_${tela}_${largura}.png`);
const LARGURAS = [1366, 390, 360, 320];
const PRINT = (l) => l === 1366 || l === 390;

const fonteTorre = fs.readFileSync(path.join(__dirname, 'torre', 't_torre_interface.js'), 'utf8');
const ini = fonteTorre.indexOf('function criarViewsSimuladas');
const criarViewsSimuladas = new Function(`${fonteTorre.slice(ini, fonteTorre.indexOf('\n}\n', ini) + 2)}; return criarViewsSimuladas;`)();

function instalarMock(tabelas) {
  localStorage.setItem('teste_usuario', JSON.stringify({ role: 'admin', nome: 'Admin Teste', id: 'a1', email: 'admin@teste.local' }));
  window.__mockTabelas = tabelas;
  const ler = (n) => Promise.resolve({ data: (window.__mockTabelas || {})[n] || [], error: null });
  const consulta = (n) => {
    const q = {
      select: () => q, order: () => q, eq: () => q, in: () => q, limit: () => q, gte: () => q, lte: () => q, neq: () => q, is: () => q, not: () => q, or: () => q, range: () => q,
      single: () => ler(n).then((r) => ({ data: r.data[0] || null, error: null })),
      maybeSingle: () => ler(n).then((r) => ({ data: r.data[0] || null, error: null })),
      then: (a, b) => ler(n).then(a, b)
    };
    return q;
  };
  const cliente = {
    auth: { getUser: async () => ({ data: { user: { id: 'a1', email: 'admin@teste.local' } }, error: null }), getSession: async () => ({ data: { session: null } }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }), signOut: async () => ({}) },
    from: consulta, rpc: async () => ({ data: [], error: null }),
    schema: () => ({ from: consulta, rpc: async () => ({ data: [], error: null }) }),
    storage: { from: () => ({ list: async () => ({ data: [] }) }) },
    functions: { invoke: async () => ({ data: null, error: null }) },
    channel: () => ({ on() { return this; }, subscribe() { return this; } }), removeChannel() {}
  };
  window.supabase = { createClient: () => cliente };
  window.supabaseClient = cliente;
  window.Chart = class { constructor() { this.data = { datasets: [] }; this.options = {}; } update() {} destroy() {} };
  window.Chart.register = () => {};
  let a;
  Object.defineProperty(window, 'ajbAuth', { configurable: true, get: () => a, set: (v) => { a = v; if (v && !v.limparDadosLocais) v.limparDadosLocais = () => {}; } });
}

async function revelar(p) {
  await p.evaluate(() => document.querySelectorAll('.reveal-up,.reveal-left,.reveal-right,.reveal-scale,.reveal-fade').forEach((e) => e.classList.add('revealed')));
  await p.evaluate(() => document.fonts && document.fonts.ready);
  await espera(700);
}

// Recorte da página que cobre os seletores (com folga)
async function clipDe(p, seletores, folga = 12) {
  return p.evaluate((sels, f) => {
    const rs = sels.flatMap((s) => Array.from(document.querySelectorAll(s))).filter((e) => e.offsetParent !== null || getComputedStyle(e).position === 'fixed').map((e) => e.getBoundingClientRect());
    if (!rs.length) return null;
    const top = Math.min(...rs.map((r) => r.top)) + scrollY, bottom = Math.max(...rs.map((r) => r.bottom)) + scrollY;
    const left = Math.max(0, Math.min(...rs.map((r) => r.left)) - f), right = Math.min(document.documentElement.clientWidth, Math.max(...rs.map((r) => r.right)) + f);
    return { x: left, y: Math.max(0, top - f), width: right - left, height: bottom - top + 2 * f };
  }, seletores, folga);
}

(async () => {
  const { srv, base, browser, erros } = await abrir({});
  const problemas = [];
  const medidas = {};
  const novaPagina = async (largura, tabelas, semMock) => {
    const p = await browser.newPage();
    await p.setRequestInterception(true);
    p.on('pageerror', (e) => erros.push(`${p.url().split('/').pop()}: ${String(e).slice(0, 120)}`));
    p.on('dialog', (d) => d.accept());
    p.on('request', (r) => {
      const u = r.url();
      if (/^https:\/\/(fonts\.googleapis\.com|fonts\.gstatic\.com|cdn\.jsdelivr\.net\/npm\/swiper@)/.test(u)) return r.continue();
      if (!u.startsWith(base)) return r.respond({ status: 200, contentType: 'text/javascript', body: '' });
      r.continue();
    });
    await p.setViewport({ width: largura, height: largura >= 1000 ? 768 : 844 });
    if (semMock) {
      // Como no t_filtro_veiculo: Chart falso e login respondendo depois (assíncrono), sem Supabase falso
      await p.evaluateOnNewDocument(() => {
        localStorage.setItem('teste_usuario', JSON.stringify({ role: 'admin', nome: 'Gestão Teste', id: 'a1' }));
        window.Chart = class { constructor() { this.data = { datasets: [] }; this.options = {}; } update() {} destroy() {} };
        window.Chart.register = () => {};
        let ao;
        Object.defineProperty(window, 'ajbAoAutenticar', { configurable: true, get: () => ao, set: (fn) => { ao = (...a) => setTimeout(() => fn(...a), 0); } });
      });
    } else await p.evaluateOnNewDocument(instalarMock, tabelas || {});
    return p;
  };
  const lateral = async (p, largura, tela) => {
    const sw = await p.evaluate(() => document.documentElement.scrollWidth);
    if (sw > largura) problemas.push(`${tela} ${largura}px: scrollWidth ${sw}`);
  };

  for (const largura of LARGURAS) {
    // ---------- 1 e 2. Painel de cadastros ----------
    const pC = await novaPagina(largura);
    await pC.goto(`${base}/HTML/Dashboard-cadastro-motorista.html`, { waitUntil: 'networkidle2' });
    await pC.evaluate(() => {
      const b = { criado_em: '2026-10-27T12:00:00Z', etapas: {}, documentos: [], dados: {}, tipo: 'pf' };
      cadastros = [ // eslint-disable-line no-undef
        { ...b, id: 'k1', status: 'pendente', nome: 'Ana Lima', cpf: '52316915930', celular: '11900000000', anotacoes: 'Ligar depois das 18h.', anotado_em: '2026-11-01T10:00:00Z' },
        { ...b, id: 'k2', status: 'aprovado', nome: 'Leonardo Arloque de oliveira', cpf: '11144477735', celular: '(14) 99858-0000', anotacoes: 'Mandou a CNH nova pelo WhatsApp; falta o comprovante de endereço.', etapas: { gr: true } },
        { ...b, id: 'k3', status: 'analise', nome: 'Maria Aparecida dos Santos Ferreira Rodrigues', cpf: '22255588846', celular: '11912345678', tipo: 'pj', dados: { 'nome-empresa': 'Transportes Ficticios do Interior Ltda' }, anotacoes: 'Empresa com CNPJ novo.' },
        { ...b, id: 'k4', status: 'recusado', nome: 'Sicrano de Teste', cpf: '33366699957', celular: '11988887777' },
        { ...b, id: 'k5', status: 'aprovado', nome: 'Beltrano Sem Nota', cpf: '44477711100', celular: '11977776666', etapas: { gr: true, shopee: true, base: true } }
      ];
      atualizarMetricas(); // eslint-disable-line no-undef
      renderTabela(); // eslint-disable-line no-undef
    });
    await revelar(pC);
    await lateral(pC, largura, 'cadastros', problemas);
    if (PRINT(largura)) await pC.screenshot({ path: nome('cadastro_verde', largura) });
    // Filtro "Com anotação"
    await pC.evaluate(() => { const c = document.getElementById('filtro-com-anotacao'); c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); });
    await espera(300);
    await lateral(pC, largura, 'cadastros com anotação', problemas);
    // Ícone sozinho numa linha? (topo do ícone abaixo do topo da última linha do nome = caiu)
    medidas[`anotacao_${largura}`] = await pC.evaluate(() => Array.from(document.querySelectorAll('#tabela-cadastros-body tr, tbody tr')).map((tr) => {
      const ic = tr.querySelector('.icone-anotacao'); if (!ic) return null;
      const linha = ic.parentElement; const r = ic.getBoundingClientRect();
      const txt = document.createRange(); txt.selectNodeContents(linha);
      const rects = Array.from(txt.getClientRects()).filter((q) => q.width > 0 && !(q.left >= r.left - 0.5 && q.right <= r.right + 0.5));
      const ultimaLinhaTopo = Math.max(...rects.map((q) => q.top));
      return `${(linha.textContent || '').trim().slice(0, 22)}: ${Math.round(r.width)}x${Math.round(r.height)} ${r.top > ultimaLinhaTopo + 4 ? 'SOZINHO' : 'junto'}`;
    }).filter(Boolean));
    if (PRINT(largura)) {
      const clip = await clipDe(pC, ['#filtro-com-anotacao', 'table']);
      await pC.screenshot({ path: nome('cadastro_anotacao', largura), clip: largura < 1000 ? { ...clip, height: Math.min(clip.height, 900) } : clip });
      // Barra lateral (no celular, gaveta aberta)
      if (largura < 1000) { await pC.click('#btn-mobile-menu').catch(() => {}); await espera(500); }
      await (await pC.$('#admin-sidebar')).screenshot({ path: nome('cadastro_sidebar', largura) });
    }
    await pC.close();

    // ---------- 3. Torre ----------
    const pT = await novaPagina(largura, criarViewsSimuladas({ minutosDesde: 4 }));
    await pT.goto(`${base}/torre-de-controle-shoppe/HTML/index.html`, { waitUntil: 'networkidle2' });
    await pT.waitForSelector('#torre-tabela-dados tbody tr', { timeout: 8000 }).catch(() => problemas.push(`torre ${largura}px: tabela vazia`));
    await revelar(pT);
    await lateral(pT, largura, 'torre', problemas);
    if (PRINT(largura)) {
      if (largura < 1000) { await pT.click('#btn-mobile-menu').catch(() => {}); await espera(500); await pT.screenshot({ path: nome('torre_sidebar', largura) }); }
      else await pT.screenshot({ path: nome('torre_sidebar', largura) });
    }
    await pT.close();

    // ---------- 4. Frota: aba Motoristas ----------
    const pF = await novaPagina(largura, null, true);
    await pF.goto(`${base}/HTML/dashboard-admin.html`, { waitUntil: 'networkidle2' });
    await espera(400);
    await pF.evaluate(() => {
      document.querySelectorAll('.admin-section').forEach((s) => s.classList.toggle('active', s.querySelector('#mot-painel-frota') !== null));
      estadoMotoristas.frota = [ // eslint-disable-line no-undef
        { id: 'm1', nome: 'Alfa Carreta Ficticio', cpf: '11122233344', telefone: '14999990001', status: 'aprovado', tipo_veiculo: 'carreta', ultimo_acesso: '2026-11-05T10:00:00Z' },
        { id: 'm2', nome: 'Beta Sem Celular Ficticio', cpf: '55566677788', telefone: '(00) 00000-0000', status: 'aprovado', tipo_veiculo: 'rodotrem' },
        { id: 'm3', nome: 'Gama Inativo Ficticio', cpf: '99988877766', telefone: '', status: 'inativo', tipo_veiculo: 'carreta_rodotrem' }
      ];
      renderizarFrota(); // eslint-disable-line no-undef
      document.getElementById('mot-painel-frota').scrollIntoView({ block: 'start' });
    });
    await revelar(pF);
    await lateral(pF, largura, 'frota motoristas', problemas);
    medidas[`frota_${largura}`] = await pF.evaluate(() => Array.from(document.querySelectorAll('#mot-tbody tr')).map((tr) => {
      const bs = Array.from(tr.querySelectorAll('.table-actions-cell > *')).map((b) => { const r = b.getBoundingClientRect(); return `${b.textContent.trim().slice(0, 14)}=${Math.round(r.width)}x${Math.round(r.height)}`; });
      return bs.join(' | ');
    }));
    if (PRINT(largura)) {
      const clip = await clipDe(pF, ['.mot-toolbar', '#mot-tbody']);
      await pF.screenshot({ path: nome('frota_whatsapp', largura), clip: { ...clip, height: Math.min(clip.height, 1400) } });
    }
    await pF.close();

    // ---------- 5. Caminhão ----------
    const lugares = [
      ['HTML/index.html', ['.pilar-icone-box svg', '.diferencial-icone-box svg', '.btn-solucao-primario']],
      ['HTML/Nossosfretes.html', ['.info-ponto .icone-caixa svg']],
      ['HTML/dashboard-admin.html', ['#admin-sidebar .nav-icon svg']],
      ['HTML/escolhaDashboard.html', ['.card-icon-container svg']],
      ['HTML/Login.html', ['#tab-motorista']],
      ['HTML/relatorio-viagem.html', ['.secao-titulo svg', '.subbloco-titulo svg']],
      ['torre-de-controle-shoppe/HTML/index.html', ['#torre-sidebar .nav-icon svg']]
    ];
    for (const [url, sels] of lugares) {
      const p = await novaPagina(largura, null, url.includes('dashboard-admin'));
      if (url.includes('relatorio')) await p.evaluateOnNewDocument(() => localStorage.setItem('teste_usuario', JSON.stringify({ role: 'motorista', nome: 'Motorista Teste', id: 'u1', cpf: '12345678900' })));
      await p.goto(`${base}/${url}`, { waitUntil: 'networkidle2' }).catch(() => {});
      await revelar(p);
      await lateral(p, largura, url, problemas);
      if (PRINT(largura)) {
        // Só os SVGs de caminhão (cabine com 23 11/23 12), cada um com a caixa em volta
        const alvos = await p.evaluate((ss) => {
          const out = [];
          ss.forEach((s) => document.querySelectorAll(s).forEach((el) => {
            const svg = el.tagName.toLowerCase() === 'svg' ? el : el.querySelector('svg');
            if (!svg || !/23 1[12]/.test(svg.innerHTML)) return;
            const caixa = el.tagName.toLowerCase() === 'svg' ? (el.parentElement.closest('a,button,.pilar-icone-box,.diferencial-icone-box,.icone-caixa,.card-icon-container,.secao-titulo,.subbloco-titulo,.nav-link') || el) : el;
            caixa.scrollIntoView({ block: 'center' });
            const r = caixa.getBoundingClientRect();
            if (r.width && r.height) out.push({ x: Math.max(0, r.left - 8), y: r.top + scrollY - 8, width: Math.min(r.width + 16, 520), height: Math.min(r.height + 16, 120) });
          }));
          return out;
        }, sels);
        let i = 0;
        for (const clip of alvos.slice(0, 3)) {
          await p.screenshot({ path: nome(`caminhao_${url.split('/').pop().replace('.html', '')}${url.includes('torre') ? '_torre' : ''}_${++i}`, largura), clip });
        }
        if (!alvos.length) problemas.push(`caminhão não achado em ${url} ${largura}px`);
      }
      await p.close();
    }
  }
  console.log('Medidas:', JSON.stringify(medidas, null, 1));
  console.log(problemas.length ? `Rolagem lateral / problemas: ${problemas.join(' | ')}` : 'Sem rolagem lateral nas telas capturadas');
  const errosUteis = erros.filter((e) => !/Chart|limparDadosLocais|Swiper|L is not defined/.test(e));
  if (errosUteis.length) console.log('Erros da página:', [...new Set(errosUteis)].slice(0, 8).join(' | '));
  await browser.close(); srv.close();
})().catch((e) => { console.error(e); process.exit(1); });
