// Posto "Outro" e cadastro de postos (passo 22). Ficha: lista da tabela postos em ordem alfabética com
// "Outro" no fim (e a lista fixa de reserva sem banco), "Nome do posto" obrigatório (até 80), rascunho
// volta com o nome, envio leva posto_outro, escape com <img onerror>, posto desativado de ficha antiga.
// Dashboard: "Adicionar posto", lista com ativar/desativar, repetido bloqueado, motorista sem permissão,
// "Outro: <nome>" destacado no resumo com "Cadastrar este posto" (modal já preenchido).
// O Supabase é falso (localStorage '__postos'), com a RLS do passo 22: só a gestão cria e
// ativa/desativa; quem não é da gestão só vê os ativos; nome repetido (maiúsculas/espaços) = 23505.
// '__sem_cliente' = 1: página sem Supabase (lista de reserva). As fichas não vêm do banco falso.
// Uso: node testes/t_postos.js [largura]   (padrão 1280; rode também com 390)
const { abrir } = require('./harness');
const LARGURA = Number(process.argv[2] || 1280);
const espera = (ms) => new Promise(res => setTimeout(res, ms));
const XSS = '<img src=x onerror="window.__xss=1">';

function supabaseFalso() {
  let semCliente = false;
  try { semCliente = localStorage.getItem('__sem_cliente') === '1'; } catch (e) { return; }
  if (semCliente) return;
  const ler = () => { try { return JSON.parse(localStorage.getItem('__postos')) || []; } catch (e) { return []; } };
  const gravar = (l) => localStorage.setItem('__postos', JSON.stringify(l));
  const usuario = () => { try { return JSON.parse(localStorage.getItem('teste_usuario')) || {}; } catch (e) { return {}; } };
  const ehAdmin = () => ['admin', 'diretoria'].includes(usuario().role);
  const chave = (t) => String(t || '').trim().replace(/\s+/g, ' ').toLowerCase();
  const falha = { data: null, error: { message: 'TypeError: Failed to fetch' } };
  class Consulta {
    constructor(t) { this.t = t; this.op = 'select'; this.filtros = []; }
    select() { return this; }
    insert(v) { this.op = 'insert'; this.valor = v; return this; }
    update(v) { this.op = 'update'; this.valor = v; return this; }
    eq(c, v) { this.filtros.push(r => String(r[c]) === String(v)); return this; }
    order() { return this; } limit() { return this; } neq() { return this; } gt() { return this; } not() { return this; }
    maybeSingle() { return this; }
    then(ok, falhou) { return Promise.resolve().then(() => this.executar()).then(ok, falhou); }
    executar() {
      // fichas e o resto: banco sem resposta (a página segue com o que tem no aparelho)
      if (this.t !== 'postos') return falha;
      const l = ler();
      (window.__consultasPostos = window.__consultasPostos || []).push(`${this.op} ${usuario().role}`);
      if (this.op === 'insert') {
        if (!ehAdmin()) return { data: null, error: { code: '42501', message: 'new row violates row-level security policy for table "postos"' } };
        if (l.some(p => chave(p.nome) === chave(this.valor.nome))) return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "postos_nome_unico"' } };
        l.push({ id: l.reduce((m, p) => Math.max(m, p.id), 0) + 1, nome: this.valor.nome, ativo: true });
        gravar(l);
        return { data: null, error: null };
      }
      const visiveis = l.filter(p => ehAdmin() || p.ativo).filter(p => this.filtros.every(f => f(p)));
      if (this.op === 'update') {
        if (!ehAdmin()) return { data: [], error: null };
        visiveis.forEach(p => Object.assign(p, this.valor));
        gravar(l);
        return { data: visiveis.map(p => ({ id: p.id })), error: null };
      }
      return { data: visiveis.map(p => ({ ...p })), error: null };
    }
  }
  const canal = { on() { return canal; }, subscribe() { return canal; } };
  const cliente = {
    from: (t) => new Consulta(t), rpc: async () => falha, channel: () => canal, removeChannel() {},
    storage: { from: () => ({ upload: async () => falha, remove: async () => falha, list: async () => falha, createSignedUrl: async () => falha }) },
    auth: {
      getUser: async () => ({ data: { user: { id: usuario().id, email: usuario().email || '' } }, error: null }),
      getSession: async () => ({ data: { session: null } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      signOut: async () => ({ error: null })
    }
  };
  window.supabase = { createClient: () => cliente };
  // Chart.js (CDN) não carrega no teste: sem ele o dashboard pararia antes de ligar os modais
  const grafico = new Proxy(function () {}, { get: (t, k) => (k === Symbol.toPrimitive ? () => 0 : grafico), apply: () => grafico, construct: () => grafico, set: () => true });
  window.Chart = grafico;
  // O ajbAoAutenticar de teste chama a página na hora; o de verdade espera o DOM (o dashboard
  // tem const declarada depois da chamada)
  let aoAutenticar = null;
  Object.defineProperty(window, 'ajbAoAutenticar', {
    configurable: true,
    get: () => aoAutenticar,
    set: (fn) => { aoAutenticar = (...args) => setTimeout(() => fn(...args), 0); }
  });
}

const POSTOS_BANCO = [
  { id: 1, nome: 'Marília - Posto Esmeralda', ativo: true },
  { id: 2, nome: 'Zeca - Posto da Serra', ativo: true },
  { id: 3, nome: 'açaí - posto minúsculo', ativo: true },
  { id: 4, nome: 'Posto Desativado Antigo', ativo: false },
  { id: 5, nome: 'Bela Vista - Posto Novo da Gestão', ativo: true }
];
const MOTORISTA = { role: 'motorista', nome: 'Motorista Teste', id: 'u1', cpf: '12345678900' };
const GESTAO = { role: 'admin', nome: 'Gestão', id: 'a1', email: 'g@x' };

(async () => {
  const { srv, base, browser, page, erros } = await abrir({ largura: LARGURA });
  await page.evaluateOnNewDocument(supabaseFalso);
  const r = {};
  const preparar = async (usuario, extra = {}) => {
    await page.goto(`${base}/HTML/Login.html`, { waitUntil: 'domcontentloaded' });
    await page.evaluate((u, postos, extra) => {
      localStorage.clear();
      localStorage.setItem('teste_usuario', JSON.stringify(u));
      localStorage.setItem('__postos', JSON.stringify(postos));
      Object.entries(extra).forEach(([k, v]) => localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v)));
    }, usuario, POSTOS_BANCO, extra);
  };
  const opcoesPosto = (i = 1) => page.evaluate((i) => Array.from(document.querySelector(`[name="posto_ml_${i}"]`).options).map(o => o.textContent), i);
  const escolher = (sel, v) => page.$eval(sel, (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }, v);
  const digitar = async (sel, txt) => { await page.$eval(sel, el => { el.value = ''; }); await page.focus(sel); await page.keyboard.type(txt); };
  const campoOutro = (i = 1) => page.evaluate((i) => {
    const c = document.querySelector(`[name="posto_outro_ml_${i}"]`);
    return c ? { visivel: c.offsetParent !== null, valor: c.value, maxlength: c.maxLength, placeholder: c.placeholder, foco: document.activeElement === c } : '(não existe)';
  }, i);

  // ---------------- Ficha: lista do banco (motorista) ----------------
  await preparar(MOTORISTA);
  await page.goto(`${base}/HTML/relatorio-viagem.html?novo=true`, { waitUntil: 'load' });
  await espera(900);
  const lista = await opcoesPosto();
  r.fichaListaDoBanco = { opcoes: lista, desativadoFora: !lista.includes('Posto Desativado Antigo') };

  // "Outro": aparece "Nome do posto" (obrigatório, 80), com foco; o nome com <img onerror> fica texto
  await escolher('[name="posto_ml_1"]', 'Outro');
  r.outroEscolhido = await campoOutro();
  await page.keyboard.type(`Posto da Estrada ${XSS}`);
  await escolher('[name="combustivel_ml_1"]', 'diesel_s10');
  await digitar('[name="valor_ml_1"]', '50000');
  await page.click('#btn-lixeira-abast-ml');
  await espera(100);
  r.popoverEscapado = await page.evaluate(() => ({
    texto: document.querySelector('#popover-lista-linhas-abast-preenchidas .detalhe-linha')?.textContent,
    imgCriado: !!document.querySelector('#popover-lista-linhas-abast-preenchidas img'),
    xss: !!window.__xss
  }));
  await page.click('#fechar-popover-abast-ml').catch(() => {});

  // Rascunho (cópia do celular, banco sem resposta): recarrega e volta com o nome
  await espera(3500);
  await page.goto(`${base}/HTML/relatorio-viagem.html?novo=true`, { waitUntil: 'load' });
  await espera(1200);
  r.rascunhoVoltou = { posto: await page.$eval('[name="posto_ml_1"]', el => el.value), outro: await campoOutro(), xss: await page.evaluate(() => !!window.__xss) };

  // Trocar para um posto da lista: o nome some e sai
  await escolher('[name="posto_ml_1"]', 'Marília - Posto Esmeralda');
  r.trocouDePosto = await campoOutro();
  await escolher('[name="posto_ml_1"]', 'Outro');
  r.voltouParaOutro = await campoOutro();

  // Linha nova (11ª em diante, criada pela página) também tem "Outro" no fim e o campo
  await page.evaluate(() => {
    const t = document.querySelector('table.tabela-abastecimento:not(.tabela-fretes-ml)');
    while (Number(t.dataset.mostrar || 1) < 12) t.querySelector('.btn-adicionar-linha-celular').click();
  });
  const op12 = await opcoesPosto(12);
  await escolher('[name="posto_ml_12"]', 'Outro');
  r.linha12 = { ultimaOpcao: op12[op12.length - 1], primeiraDepoisDoSelecione: op12[1], campo: await campoOutro(12) };
  r.rolagemH = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);

  // ---------------- Ficha sem Supabase: lista de reserva, "Outro" obrigatório e envio ----------------
  await preparar(MOTORISTA, { __sem_cliente: '1' });
  await page.goto(`${base}/HTML/relatorio-viagem.html?novo=true`, { waitUntil: 'load' });
  await espera(500);
  const reserva = await opcoesPosto();
  const ordenada = reserva.slice(1, -1).slice().sort((a, b) => a.localeCompare(b, 'pt-BR', { sensitivity: 'base' }));
  r.listaDeReserva = { total: reserva.length, primeira: reserva[1], ultima: reserva[reserva.length - 1], emOrdem: JSON.stringify(ordenada) === JSON.stringify(reserva.slice(1, -1)) };
  await page.evaluate(() => {
    window.reservarNumeroFichaSupabase = async () => 'AJB-2026-501';
    window.salvarFichaSupabase = async (f) => { window.__payload = window.mapearFichaParaSupabase(f); return { success: true }; };
  });
  await digitar('#placas', 'ABC1D23');
  await digitar('#km-saida', '100000');
  await digitar('#km-chegada', '105000');
  await digitar('#data-saida', '01102026');
  await digitar('#data-chegada', '05102026');
  await page.$eval('#destino-inicial', el => { el.value = 'Marília - SP'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await digitar('#valor-adiantamento', '0');
  await escolher('[name="posto_ml_1"]', 'Outro');
  await escolher('[name="combustivel_ml_1"]', 'diesel_s10');
  await digitar('[name="valor_ml_1"]', '50000');
  await page.click('#btn-finalizar-relatorio-ml');
  await espera(300);
  r.semNomeNaoEnvia = await page.evaluate(() => ({
    revisaoAberta: document.querySelector('#modal-revisar-envio').classList.contains('ativo'),
    erro: document.querySelector('.erro-campo-celular')?.textContent || '(sem erro)',
    focoNoNome: document.activeElement?.name || ''
  }));
  await page.keyboard.type('Posto Beira Rio ' + 'x'.repeat(100));
  r.limite80 = (await campoOutro()).valor.length;
  await page.click('#btn-finalizar-relatorio-ml');
  await espera(300);
  await page.click('#btn-revisar-confirmar');
  await espera(800);
  r.envio = await page.evaluate(() => window.__payload ? window.__payload.abastecimentos.map(a => `${a.posto} | ${a.posto_outro}`) : '(não enviou)');

  // ---------------- Gestão abre ficha antiga com posto desativado e com "Outro" ----------------
  const FICHA = {
    id: 'AJB-2026-502', motorista: 'Motorista Teste', placas: 'ABC1D23', status: 'pendente', dataEnvio: '05/10/2026', dataSaida: '01/10/2026',
    kmSaida: '100000', kmEntrada: '101500', kmChegada: '101500', fretes: [],
    abastecimentos: [
      { posto: 'Posto Desativado Antigo', valor: '600,00', litros: '100', combustivel: 'diesel_s10', placa: 'principal' },
      { posto: 'Outro', posto_outro: `Posto Sem Cadastro ${XSS}`, valor: '300,00', litros: '50', combustivel: 'diesel_s10', placa: 'principal' }
    ]
  };
  await preparar(GESTAO, { ajborges_fichas_viagem: [FICHA] });
  await page.goto(`${base}/HTML/relatorio-viagem.html?ficha=${FICHA.id}&mode=admin`, { waitUntil: 'load' });
  await espera(900);
  const op1 = await opcoesPosto(1);
  r.fichaAntigaNaGestao = {
    posto1: await page.$eval('[name="posto_ml_1"]', el => el.value),
    desativadoAntesDoOutro: op1.indexOf('Posto Desativado Antigo') === op1.length - 2 && op1[op1.length - 1] === 'Outro',
    posto2: await page.$eval('[name="posto_ml_2"]', el => el.value),
    outro2: await campoOutro(2),
    xss: await page.evaluate(() => !!window.__xss)
  };

  // ---------------- Dashboard ----------------
  await page.goto(`${base}/HTML/dashboard-admin.html`, { waitUntil: 'load' });
  await espera(1500);
  await page.evaluate(() => abrirModalResumoFicha('AJB-2026-502')); // eslint-disable-line no-undef
  await espera(300);
  r.resumoDaFicha = await page.evaluate(() => {
    const c = document.getElementById('modal-ficha-conteudo');
    const destaque = c.querySelector('.posto-outro-destaque');
    const btn = c.querySelector('[data-cadastrar-posto]');
    return {
      destaque: destaque?.textContent, botao: btn?.textContent, nomeNoBotao: btn?.getAttribute('data-cadastrar-posto'),
      postoDesativado: Array.from(c.querySelectorAll('.modal-tabela-resumo'))[1]?.tBodies[0].rows[0].cells[0].textContent.trim(),
      imgCriado: !!c.querySelector('td img'), xss: !!window.__xss
    };
  });
  // Conferência de Combustível também mostra "Outro: <nome>"
  r.conferenciaCombustivel = await page.evaluate(() => Array.from(document.querySelectorAll('#tabela-combustivel-body tr td:first-child')).map(td => td.textContent.trim()));

  // "Cadastrar este posto": modal de postos já preenchido, por cima do resumo
  await page.click('[data-cadastrar-posto]');
  await espera(400);
  r.atalho = await page.evaluate(() => ({
    aberto: document.getElementById('modal-postos').classList.contains('active'),
    nome: document.getElementById('postos-nome').value,
    lista: Array.from(document.querySelectorAll('#postos-lista .postos-nome')).map(e => e.textContent.trim()),
    resumo: document.getElementById('postos-resumo').textContent,
    noTopo: (() => { const b = document.getElementById('postos-salvar').getBoundingClientRect(); const el = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2); return !!el && !!el.closest('#modal-postos'); })(),
    rolagemH: document.documentElement.scrollWidth > window.innerWidth
  }));
  // O nome veio com <img onerror> (a ficha antiga não passou pela _txt): salva como texto
  await page.click('#postos-salvar');
  await espera(500);
  r.salvouDoAtalho = await page.evaluate(() => ({
    aviso: document.getElementById('postos-ok').hidden ? document.getElementById('postos-alerta').textContent : document.getElementById('postos-ok').textContent,
    noBanco: JSON.parse(localStorage.getItem('__postos')).map(p => p.nome).slice(-1)[0],
    imgNaLista: !!document.querySelector('#postos-lista img'), xss: !!window.__xss
  }));

  // Repetido (maiúsculas e espaços): bloqueado na tela; e se passar, o banco recusa (23505)
  await digitar('#postos-nome', '  marília  -  posto ESMERALDA ');
  await page.click('#postos-salvar');
  await espera(300);
  r.repetidoNaTela = await page.$eval('#postos-alerta', el => el.textContent);
  await page.evaluate(() => { postosCadastrados = []; }); // eslint-disable-line no-undef
  await digitar('#postos-nome', 'MARÍLIA - POSTO ESMERALDA');
  await page.click('#postos-salvar');
  await espera(300);
  r.repetidoNoBanco = await page.$eval('#postos-alerta', el => el.textContent);
  await digitar('#postos-nome', 'outro');
  await page.click('#postos-salvar');
  await espera(200);
  r.nomeOutro = await page.$eval('#postos-alerta', el => el.textContent);

  // Posto novo pelo botão da Conferência de Combustível
  await page.evaluate(() => fecharModalPostos()); // eslint-disable-line no-undef
  await page.evaluate(() => fecharModalResumo()); // eslint-disable-line no-undef
  await page.evaluate(() => document.getElementById('btn-postos-abrir').click());
  await espera(300);
  await digitar('#postos-nome', '  Abaeté  -  Posto Cadastrado Agora ');
  await page.click('#postos-salvar');
  await espera(500);
  r.cadastrouPeloBotao = await page.evaluate(() => ({
    aviso: document.getElementById('postos-ok').textContent,
    noBanco: JSON.parse(localStorage.getItem('__postos')).map(p => p.nome).slice(-1)[0]
  }));

  // Desativar "Zeca - Posto da Serra"
  await page.evaluate(() => {
    const li = Array.from(document.querySelectorAll('#postos-lista .postos-item')).find(l => l.textContent.includes('Zeca - Posto da Serra'));
    li.querySelector('button').click();
  });
  await espera(500);
  r.desativou = await page.evaluate(() => ({
    aviso: document.getElementById('postos-ok').textContent,
    item: Array.from(document.querySelectorAll('#postos-lista .postos-item')).find(l => l.textContent.includes('Zeca')).textContent.replace(/\s+/g, ' ').trim(),
    resumo: document.getElementById('postos-resumo').textContent
  }));
  // 390px: o modal cabe sem rolagem lateral
  r.modalCabe = await page.evaluate(() => {
    const m = document.querySelector('#modal-postos .modal-container').getBoundingClientRect();
    return { rolagemH: document.documentElement.scrollWidth > window.innerWidth, dentro: m.left >= -1 && m.right <= window.innerWidth + 1 };
  });

  // A ficha do motorista mostra o posto novo junto com os outros e não mostra o desativado
  const postosAgora = await page.evaluate(() => localStorage.getItem('__postos'));
  await preparar(MOTORISTA, { __postos: postosAgora });
  await page.goto(`${base}/HTML/relatorio-viagem.html?novo=true`, { waitUntil: 'load' });
  await espera(900);
  const listaFinal = await opcoesPosto();
  r.fichaDepoisDaGestao = {
    opcoes: listaFinal,
    novoAparece: listaFinal.includes('Abaeté - Posto Cadastrado Agora'),
    desativadoSumiu: !listaFinal.includes('Zeca - Posto da Serra'),
    outroNoFim: listaFinal[listaFinal.length - 1] === 'Outro'
  };

  // Motorista (sem ser gestão) não cadastra: o banco recusa (RLS)
  r.motoristaInsere = await page.evaluate(async () => {
    const { error } = await window.supabaseClient.from('postos').insert({ nome: 'Posto do Motorista' });
    return error ? `${error.code} ${error.message}` : 'GRAVOU';
  });

  r.erros = erros;
  console.log(JSON.stringify(r, null, 2));
  await browser.close(); srv.close();
})().catch(e => { console.error(e); process.exit(1); });
