// Frete sem valor (passo 19): o motorista lança data, origem e destino e deixa o valor em 0,00;
// a gestão completa. Ficha do motorista (comissão "a calcular", Mercado Livre R$ 400, "parcial",
// revisão e envio), conferência da gestão (valor preenchido → comissão pela regra, inclusive José Luiz
// e Clóvis; não aprova com frete sem valor) e dashboard (selo, aprovação, acerto e totais pendentes).
// Uso: node testes/t_frete_sem_valor.js [ficha|gestao|dashboard]   (sem argumento: tudo)
// Nada vai para o Supabase: a RPC veiculo_do_motorista é simulada.
const { abrir } = require('./harness');
const PARTE = process.argv[2] || 'tudo';
const espera = (ms) => new Promise(res => setTimeout(res, ms));

async function prepararSupabase(page) {
  await page.evaluateOnNewDocument(() => {
    let cfg = null;
    try { cfg = JSON.parse(localStorage.getItem('teste_veiculo') || 'null'); } catch (e) { /* about:blank */ }
    const vazio = { data: null, error: null };
    const consulta = { eq: () => ({ maybeSingle: async () => vazio }), order: async () => ({ data: [], error: null }) };
    window.supabaseClient = {
      rpc: async (nome) => (nome === 'veiculo_do_motorista' && cfg ? { data: [cfg], error: null } : { data: null, error: { message: 'falhou' } }),
      from: () => ({ select: () => consulta }),
      auth: { getUser: async () => ({ data: { user: { id: 'u1' } } }), getSession: async () => ({ data: { session: null } }), signOut: async () => ({ error: null }) }
    };
  });
}

const CARRETA = { tipo_veiculo: 'carreta', comissao_alim_carreta: null, comissao_alim_rodotrem: null };
const JOSE = { tipo_veiculo: 'carreta_rodotrem', comissao_alim_carreta: null, comissao_alim_rodotrem: 10.5 };   // especial rodotrem 10,5
const CLOVIS = { tipo_veiculo: 'carreta', comissao_alim_carreta: 6, comissao_alim_rodotrem: null };            // especial carreta 6

async function abrirFicha(page, base, cfg) {
  await page.goto(`${base}/HTML/Login.html`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((c) => { localStorage.clear(); localStorage.setItem('teste_veiculo', JSON.stringify(c)); }, cfg);
  await page.goto(`${base}/HTML/relatorio-viagem.html?novo=true`, { waitUntil: 'load' });
  await espera(300);
  await page.evaluate(() => {
    window.reservarNumeroFichaSupabase = async () => 'AJB-2026-998';
    window.salvarFichaSupabase = async (f) => { window.__enviado = f; window.__payload = window.mapearFichaParaSupabase(f); return { success: true }; };
  });
}

// Linha i da Relação de fretes; valor em centavos digitado ('' = não digita nada)
async function linhaFrete(page, i, { cliente, origem = 'Marília - SP', destino = 'Santos - SP', veiculo, valor = '', data = '01/10/2026' }) {
  await page.evaluate((i) => {
    const tr = document.querySelector(`[name="data_frete_ml_${i}"]`).closest('tr');
    const tabela = tr.closest('table');
    const n = Array.from(tabela.tBodies[0].rows).indexOf(tr) + 1;
    if (Number(tabela.dataset.mostrar || 1) < n) tabela.dataset.mostrar = String(n);
    tr.classList.remove('linha-oculta-celular');
  }, i);
  const definir = (campo, v) => page.$eval(`[name="${campo}_frete_ml_${i}"]`, (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }, v);
  await definir('data', data);
  if (cliente) await page.select(`[name="cliente_frete_ml_${i}"]`, cliente);
  if (veiculo !== undefined) await page.select(`[name="veiculo_frete_ml_${i}"]`, veiculo);
  await definir('origem', origem);
  await definir('destino', destino);
  if (valor) {
    await page.$eval(`[name="valor_frete_ml_${i}"]`, el => { el.value = ''; });
    await page.focus(`[name="valor_frete_ml_${i}"]`);
    await page.keyboard.type(valor);
    await page.$eval(`[name="valor_frete_ml_${i}"]`, el => el.blur());
  }
}

async function cabecalhoValido(page) {
  const digitar = async (sel, txt) => { await page.focus(sel); await page.keyboard.type(txt); };
  await digitar('#placas', 'ABC1D23');
  await digitar('#data-saida', '01102026');
  await digitar('#data-chegada', '05102026');
  await digitar('#km-saida', '100000');
  await digitar('#km-chegada', '101500');
  await page.$eval('#destino-inicial', el => { el.value = 'Marília - SP'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await digitar('#valor-adiantamento', '50000');
}

const linhaDaComissao = (page, i) => page.$eval(`[name="comissao_frete_ml_${i}"]`, el => el.value || `(vazio, placeholder "${el.placeholder}")`);

async function tentarEnviar(page) {
  await page.$eval('#btn-finalizar-relatorio-ml', el => el.scrollIntoView({ block: 'center' }));
  await page.click('#btn-finalizar-relatorio-ml');
  await espera(400);
  return page.evaluate(() => ({
    revisaoAberta: document.querySelector('#modal-revisar-envio').classList.contains('ativo'),
    erros: Array.from(document.querySelectorAll('.erro-campo-celular')).map(e => e.textContent),
    foco: document.activeElement && (document.activeElement.name || document.activeElement.id)
  }));
}

// ---------------------------------------------------------------------------
async function testarFicha({ base, page }) {
  const r = {};
  await abrirFicha(page, base, CARRETA);
  await cabecalhoValido(page);
  await linhaFrete(page, 1, { cliente: 'shopee' });                          // sem valor (campo vazio)
  await page.evaluate(() => document.querySelector('table.tabela-fretes-ml .btn-adicionar-linha-celular')?.click());
  await linhaFrete(page, 2, { cliente: 'mercado_livre', valor: '000' });     // 0,00 digitado
  await linhaFrete(page, 3, { cliente: 'alimenticio', valor: '1000000' });  // R$ 10.000,00
  const tela = () => page.evaluate(() => ({
    valores: [1, 2, 3].map(i => document.querySelector(`[name="valor_frete_ml_${i}"]`).value || '(vazio)'),
    dica: document.querySelector('.dica-valor-frete')?.textContent || '(sem dica)',
    dicasNaPagina: document.querySelectorAll('.dica-valor-frete').length,
    totalFrete: document.getElementById('ml-total-relacao-frete').value,
    totalComissao: document.getElementById('ml-total-relacao-comissao').value,
    saldo: document.getElementById('ml-indicador-saldo-comissao').textContent.trim(),
    parciais: Array.from(document.querySelectorAll('[data-parcial]')).map(el => `${el.dataset.parcial}:${el.hidden ? 'escondido' : el.textContent}`),
    destaqueGestao: document.querySelectorAll('tr.linha-frete-sem-valor').length
  }));
  r.comissoes = { shopeeSemValor: await linhaDaComissao(page, 1), mlSemValor: await linhaDaComissao(page, 2), alimenticio: await linhaDaComissao(page, 3) };
  r.tela = await tela();
  r.revisao = await tentarEnviar(page);
  r.revisao.qtdFretes = await page.$eval('#revisar-qtd-fretes', el => el.textContent);
  r.revisao.detalhes = await page.$$eval('#revisar-detalhes-viagem .revisar-linha', ls => ls.map(l => l.textContent.replace(/\s+/g, ' ').trim()).filter(t => /^#|Total/.test(t)));
  await page.click('#btn-revisar-confirmar');
  await espera(1200);
  r.enviado = await page.evaluate(() => window.__payload && {
    fretes: window.__payload.dados_completos.fretes.map(f => `${f.cliente}/${f.valor || '(vazio)'}/${f.comissao || '(vazio)'}`),
    total_frete: window.__payload.total_frete, vr_comissao: window.__payload.vr_comissao, status: window.__payload.status
  });

  // Frete sem a origem: não envia, aviso junto do campo
  await abrirFicha(page, base, CARRETA);
  await cabecalhoValido(page);
  await linhaFrete(page, 1, { cliente: 'shopee', origem: '' });
  r.semOrigem = await tentarEnviar(page);
  // Shopee com valor depois: "a calcular" some e o "parcial" também
  await abrirFicha(page, base, CARRETA);
  await linhaFrete(page, 1, { cliente: 'shopee' });
  const antes = await linhaDaComissao(page, 1);
  await page.focus('[name="valor_frete_ml_1"]'); await page.keyboard.type('100000');
  r.shopeeDepoisDoValor = { antes, depois: await linhaDaComissao(page, 1), parciais: (await tela()).parciais };
  return r;
}

// ---------------------------------------------------------------------------
// Conferência da gestão: frete sem valor em destaque; ao digitar o valor, a comissão sai pela regra
// (veículo e comissões especiais do motorista DA FICHA); não aprova enquanto faltar valor
async function testarGestao({ base, page }) {
  const r = {};
  const casos = [
    ['José Luiz (rodotrem 10,5), Alimentício rodotrem destino Santos', JOSE, { cliente: 'alimenticio', veiculo: 'rodotrem', destino: 'Santos - SP' }, '1.050,00'],
    ['José Luiz, Alimentício linha carreta', JOSE, { cliente: 'alimenticio', veiculo: 'carreta', destino: 'Santos - SP' }, '1.100,00'],
    ['Clóvis (carreta 6), Alimentício', CLOVIS, { cliente: 'alimenticio', destino: 'Santos - SP' }, '600,00'],
    ['Carreta sem especial, Shopee', CARRETA, { cliente: 'shopee', destino: 'Santos - SP' }, '1.100,00'],
    ['Carreta sem especial, Mercado Livre (já tinha 400)', CARRETA, { cliente: 'mercado_livre', destino: 'Santos - SP' }, '400,00']
  ];
  r.preencheValor = [];
  for (const [nome, cfg, fr, esperado] of casos) {
    const FICHA = {
      id: 'AJB-2026-951', motorista: 'Motorista Ficticio', motoristaId: 'mot-1', placas: 'ABC1D23', status: 'pendente',
      kmSaida: '100000', kmEntrada: '101500', destinoInicial: 'Marília - SP', valorAdiantamento: '500,00',
      fretes: [{ data: '01/10/2026', origem: 'Marília - SP', valor: '', comissao: fr.cliente === 'mercado_livre' ? '400,00' : '', descarga: '', ...fr }],
      abastecimentos: [], outrasDespesas: []
    };
    await page.goto(`${base}/HTML/Login.html`, { waitUntil: 'domcontentloaded' });
    await page.evaluate((f, c) => {
      localStorage.clear();
      localStorage.setItem('teste_usuario', JSON.stringify({ role: 'admin', nome: 'Gestão', id: 'admin-1', email: 'gestao@exemplo.com' }));
      localStorage.setItem('ajborges_fichas_viagem', JSON.stringify([f]));
      localStorage.setItem('teste_veiculo', JSON.stringify(c));
    }, FICHA, cfg);
    await page.goto(`${base}/HTML/relatorio-viagem.html?ficha=${FICHA.id}&mode=admin`, { waitUntil: 'load' });
    await espera(700);
    const aoAbrir = await page.evaluate(() => ({
      destaque: !!document.querySelector('[name="valor_frete_ml_1"]').closest('tr.linha-frete-sem-valor'),
      comissao: document.querySelector('[name="comissao_frete_ml_1"]').value || `(vazio, "${document.querySelector('[name="comissao_frete_ml_1"]').placeholder}")`,
      dicaDoMotorista: document.querySelectorAll('.dica-valor-frete').length
    }));
    // Aprovar com frete sem valor: bloqueia (sem a pergunta de confirmação)
    page._dialogos = [];
    await page.click('#btn-admin-aprovar-concluir');
    await espera(300);
    const aprovarSemValor = await page.evaluate(() => ({
      aviso: Array.from(document.querySelectorAll('.erro-campo-celular')).map(e => e.textContent).join(' / '),
      foco: document.activeElement && document.activeElement.name
    }));
    aprovarSemValor.perguntou = page._dialogos.length > 0;
    await page.focus('[name="valor_frete_ml_1"]'); await page.keyboard.type('1000000');
    await page.$eval('[name="valor_frete_ml_1"]', el => el.blur());
    const comissao = await linhaDaComissao(page, 1);
    const destaqueDepois = await page.evaluate(() => !!document.querySelector('tr.linha-frete-sem-valor'));
    // Agora aprova (a pergunta aparece; o harness aceita) e grava a comissão da tela
    page._dialogos = [];
    await page.evaluate(() => { window.salvarFichaSupabase = async (f) => { sessionStorage.setItem('payload', JSON.stringify(window.mapearFichaParaSupabase(f))); return { success: true }; }; });
    await page.click('#btn-admin-aprovar-concluir');
    await espera(900);
    const salvo = await page.evaluate(() => { const p = JSON.parse(sessionStorage.getItem('payload') || 'null'); return p && `${p.status} | frete ${p.dados_completos.fretes[0].valor} comissão ${p.dados_completos.fretes[0].comissao} | total_frete ${p.total_frete} vr_comissao ${p.vr_comissao}`; });
    r.preencheValor.push(`${comissao === esperado ? 'OK ' : 'ERRO'} ${nome}: ao abrir ${aoAbrir.comissao}, destaque ${aoAbrir.destaque ? 'sim' : 'NÃO'} → valor 10.000,00 → comissão ${comissao} (esperado ${esperado}), destaque depois ${destaqueDepois ? 'SIM' : 'não'} | aprovar sem valor: "${aprovarSemValor.aviso}" foco ${aprovarSemValor.foco} pergunta ${aprovarSemValor.perguntou ? 'SIM' : 'não'} | depois aprova: ${page._dialogos.length ? 'pergunta' : 'SEM pergunta'} → ${salvo} | dicas do motorista na gestão: ${aoAbrir.dicaDoMotorista}`);
  }
  return r;
}

// ---------------------------------------------------------------------------
async function testarDashboard({ base, page }) {
  await page.evaluateOnNewDocument(() => {
    // Chart.js (CDN) não carrega no teste: um Proxy aceita qualquer uso (aprovar atualiza os gráficos)
    const grafico = new Proxy(function () {}, { get: (t, k) => (k === Symbol.toPrimitive ? () => 0 : grafico), apply: () => grafico, construct: () => grafico, set: () => true });
    window.Chart = grafico;
    let aoAutenticar;
    Object.defineProperty(window, 'ajbAoAutenticar', {
      configurable: true, get: () => aoAutenticar,
      set: (fn) => { aoAutenticar = (...a) => setTimeout(() => fn(...a), 0); }
    });
  });
  const fichas = [
    { id: 'AJB-2026-960', motorista: 'Motorista Sem Valor', status: 'pendente', dataEnvio: '05/10/2026', dataSaida: '01/10/2026', totalFrete: '10.000,00', vrComissao: '1.500,00', valorAdiantamento: '500,00', saldoComissao: '1.000,00',
      fretes: [{ data: '01/10/2026', cliente: 'mercado_livre', origem: 'A', destino: 'B', valor: '', comissao: '400,00' },
               { data: '02/10/2026', cliente: 'shopee', origem: 'B', destino: 'C', valor: '0,00', comissao: '' },
               { data: '03/10/2026', cliente: 'alimenticio', origem: 'C', destino: 'D', valor: '10.000,00', comissao: '1.100,00' }] },
    { id: 'AJB-2026-961', motorista: 'Motorista Completo', status: 'pendente', dataEnvio: '05/10/2026', dataSaida: '01/10/2026', totalFrete: '2.000,00', vrComissao: '220,00', valorAdiantamento: '0,00', saldoComissao: '220,00',
      fretes: [{ data: '01/10/2026', cliente: 'shopee', origem: 'A', destino: 'B', valor: '2.000,00', comissao: '220,00' }] }
  ];
  await page.goto(`${base}/HTML/Login.html`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((f) => {
    localStorage.clear();
    localStorage.setItem('teste_usuario', JSON.stringify({ role: 'admin', nome: 'Gestão', id: 'a1', email: 'g@x' }));
    localStorage.setItem('ajborges_fichas_viagem', JSON.stringify(f));
  }, fichas);
  await page.goto(`${base}/HTML/dashboard-admin.html`, { waitUntil: 'load' });
  await espera(1200);
  const r = {};
  r.lista = await page.$$eval('#tabela-fichas-body tr', trs => trs.map(tr => `${tr.cells[0].textContent.trim()}: ${tr.cells[4].textContent.replace(/\s+/g, ' ').trim()}`));
  // ✓ da lista na ficha com frete sem valor: não aprova e não pergunta
  page._dialogos = [];
  await page.click('#row-ficha-AJB-2026-960 .btn-acao-aprovar-rapido');
  await espera(300);
  r.aprovarRapido = await page.evaluate(() => ({
    status: appState.fichas.find(f => f.id === 'AJB-2026-960').status, // eslint-disable-line no-undef
    toast: document.getElementById('toast-message')?.textContent || ''
  }));
  r.aprovarRapido.perguntou = page._dialogos.length > 0;
  // Resumo (detalhe) da ficha
  await page.click('#row-ficha-AJB-2026-960 .btn-acao-resumo');
  await espera(300);
  r.detalhe = await page.evaluate(() => {
    const c = document.getElementById('modal-ficha-conteudo');
    return {
      aviso: c.querySelector('.aviso-frete-sem-valor')?.textContent.replace(/\s+/g, ' ').trim() || '(sem aviso)',
      fretes: Array.from(c.querySelectorAll('.modal-tabela-resumo'))[0] ? Array.from(c.querySelectorAll('.modal-tabela-resumo')[0].tBodies[0].rows).map(tr => `${tr.className || '-'}: ${Array.from(tr.cells).slice(-2).map(td => td.textContent.trim()).join(' / ')}`) : [],
      totalESaldo: Array.from(c.querySelectorAll('.modal-info-linha')).filter(l => /Total Frete Bruto|Saldo Comissão/.test(l.textContent)).map(l => l.textContent.replace(/\s+/g, ' ').trim())
    };
  });
  page._dialogos = [];
  await page.click('#btn-modal-aprovar-direto');
  await espera(300);
  r.aprovarNoDetalhe = { perguntou: page._dialogos.length > 0, resumoContinuaAberto: await page.evaluate(() => document.getElementById('modal-resumo-ficha').classList.contains('active')) };
  await page.evaluate(() => fecharModalResumo()); // eslint-disable-line no-undef
  r.acertos = await page.$$eval('#tabela-acertos-body tr', trs => trs.map(tr => Array.from(tr.cells).map(td => td.textContent.replace(/\s+/g, ' ').trim()).join(' | ') + (tr.querySelector('button[disabled]') ? ' [Confirmar desabilitado]' : '')));
  r.kpis = await page.evaluate(() => ['kpi-total-entrada', 'kpi-saida-comissao', 'kpi-resultado-liquido'].map(id => {
    const el = document.getElementById(id);
    const p = el.nextElementSibling && el.nextElementSibling.classList.contains('kpi-pendente') ? el.nextElementSibling : null;
    return `${id}: ${el.textContent} ${p && !p.hidden ? `(${p.textContent})` : '(sem pendente)'}`;
  }));
  // A ficha completa aprova normalmente
  page._dialogos = [];
  await page.click('#row-ficha-AJB-2026-961 .btn-acao-aprovar-rapido');
  await espera(300);
  r.fichaCompletaAprova = { perguntou: page._dialogos.length > 0, status: await page.evaluate(() => appState.fichas.find(f => f.id === 'AJB-2026-961').status) }; // eslint-disable-line no-undef
  return r;
}

// ---------------------------------------------------------------------------
// Cada erro do envio: aviso em vermelho embaixo do campo certo, borda vermelha, foco e o campo
// visível na tela (depois da rolagem); o toast no topo. Na largura pedida (padrão 1280).
async function testarErros({ base, page }, largura = 1280) {
  await page.setViewport({ width: largura, height: largura < 500 ? 740 : 900 });
  const casos = [
    ['placa vazia', async () => { await page.$eval('#placas', el => { el.value = ''; }); }, 'placas'],
    ['data de chegada vazia', async () => { await page.$eval('#data-chegada', el => { el.value = ''; }); }, 'data-chegada'],
    ['KM de chegada menor', async () => { await page.$eval('#km-chegada', el => { el.value = '99000'; el.dispatchEvent(new Event('input', { bubbles: true })); }); }, 'km-chegada'],
    ['adiantamento vazio', async () => { await page.$eval('#valor-adiantamento', el => { el.value = ''; }); }, 'valor-adiantamento'],
    ['sem frete nem abastecimento', async () => {}, 'data_frete_ml_1', { semFrete: true }],
    ['frete sem destino', async () => { await linhaFrete(page, 1, { cliente: 'shopee', destino: '' }); }, 'destino_frete_ml_1']
  ];
  const linhas = [];
  for (const [nome, estragar, campo, op = {}] of casos) {
    await abrirFicha(page, base, CARRETA);
    await cabecalhoValido(page);
    if (!op.semFrete && nome !== 'frete sem destino') await linhaFrete(page, 1, { cliente: 'shopee', valor: '100000' });
    await estragar();
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)); // envio fica no fim da ficha
    const envio = await tentarEnviar(page);
    await espera(500); // rolagem suave
    const m = await page.evaluate((campo) => {
      const el = document.getElementById(campo) || document.querySelector(`[name="${campo}"]`);
      const aviso = Array.from(document.querySelectorAll('.erro-campo-celular'))[0];
      const ra = el.getBoundingClientRect();
      const rAviso = aviso ? aviso.getBoundingClientRect() : null;
      const toast = document.getElementById('toast-notificacao') || document.querySelector('.toast');
      const rt = toast.getBoundingClientRect();
      const borda = getComputedStyle(el.closest('.input-wrapper') || el).borderTopColor;
      return {
        aviso: aviso ? aviso.textContent : '(sem aviso)',
        avisoEmbaixoDoCampo: !!rAviso && rAviso.top >= ra.bottom - 1 && rAviso.top - ra.bottom < 40,
        avisoVermelho: aviso ? getComputedStyle(aviso).color : '-',
        borda,
        foco: document.activeElement === el,
        campoNaTela: ra.top >= 0 && ra.bottom <= window.innerHeight,
        toast: `${toast.textContent.trim()} @ ${Math.round(rt.top)}px do topo`
      };
    }, campo);
    linhas.push(`${nome}: "${m.aviso}" | embaixo do campo ${m.avisoEmbaixoDoCampo ? 'sim' : 'NÃO'} | cor ${m.avisoVermelho} | borda ${m.borda} | foco ${m.foco ? 'sim' : 'NÃO'} | campo na tela ${m.campoNaTela ? 'sim' : 'NÃO'} | revisão ${envio.revisaoAberta ? 'ABRIU' : 'não abriu'} | toast "${m.toast}"`);
  }
  await page.setViewport({ width: 1280, height: 900 });
  return linhas;
}

// 360 px: dica do valor, "a calcular", "parcial" e erro sem rolagem horizontal nem campo para fora
async function testar360({ base, page }) {
  await page.setViewport({ width: 360, height: 740 });
  await abrirFicha(page, base, CARRETA);
  await cabecalhoValido(page);
  await linhaFrete(page, 1, { cliente: 'shopee' });
  await page.evaluate(() => document.querySelector('table.tabela-fretes-ml .btn-adicionar-linha-celular')?.click());
  await linhaFrete(page, 2, { cliente: 'mercado_livre', destino: '' });
  await tentarEnviar(page);
  await espera(500);
  const r = await page.evaluate(() => {
    const foraDaTela = Array.from(document.querySelectorAll('#form-relatorio input, #form-relatorio select, #form-relatorio button, .dica-valor-frete, .aviso-parcial, .erro-campo-celular, .quadro-como-preencher'))
      .filter(el => el.offsetParent !== null).filter(el => { const b = el.getBoundingClientRect(); return b.right > window.innerWidth + 1 || b.left < -1; })
      .map(el => el.name || el.id || el.className);
    const dica = document.querySelector('[name="valor_frete_ml_1"]').closest('td').querySelector('.dica-valor-frete');
    return {
      rolagemH: document.documentElement.scrollWidth > window.innerWidth,
      foraDaTela,
      dica: dica && dica.offsetParent !== null ? `${Math.round(dica.getBoundingClientRect().width)}px, ${dica.getClientRects().length} caixa` : 'NÃO aparece',
      comissao1: document.querySelector('[name="comissao_frete_ml_1"]').placeholder,
      parciaisVisiveis: Array.from(document.querySelectorAll('[data-parcial]')).filter(el => el.offsetParent !== null).length,
      erro: document.querySelector('.erro-campo-celular')?.textContent || '(sem erro)'
    };
  });
  await page.setViewport({ width: 1280, height: 900 });
  return r;
}

(async () => {
  const r = {};
  for (const [nome, fn] of [['ficha', testarFicha], ['gestao', testarGestao], ['dashboard', testarDashboard],
                            ['erros', testarErros], ['erros360', (ctx) => testarErros(ctx, 360)], ['celular360', testar360]]) {
    if (PARTE !== 'tudo' && PARTE !== nome) continue;
    const ctx = await abrir({ largura: 1280 });
    if (nome !== 'dashboard') await prepararSupabase(ctx.page);
    try { r[nome] = await fn(ctx); } catch (e) { r[nome] = 'FALHOU: ' + e.message; }
    // (depois de salvar/aprovar, a ficha da gestão vai para o dashboard, que sem o CDN não tem o Chart)
    r[`erros_${nome}`] = ctx.erros.filter(e => !/limparDadosLocais|Chart is not defined/.test(e));
    await ctx.browser.close(); ctx.srv.close();
  }
  console.log(JSON.stringify(r, null, 2));
})().catch(e => { console.error(e); process.exit(1); });
