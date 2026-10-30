// Fretes e abastecimentos sem limite visível (passo 22): o motorista adiciona 9, 20 e 100 de cada pelo
// "+ Adicionar"; o 101º não entra (mensagem); totais somam todas as linhas; a cópia do rascunho volta com
// tudo; o envio leva tudo; sem rolagem lateral. Depois o dashboard-admin abre a ficha com 100 + 100.
// Uso: node testes/t_fretes_100.js [largura]   (padrão 1280; rode também com 390)
const { abrir } = require('./harness');
const LARGURA = Number(process.argv[2] || 1280);
const espera = (ms) => new Promise(res => setTimeout(res, ms));
const TAB_FRETES = 'table.tabela-fretes-ml';
const TAB_ABAST = 'table.tabela-abastecimento:not(.tabela-fretes-ml)';

(async () => {
  const { srv, base, browser, page, erros } = await abrir({ largura: LARGURA });
  await page.evaluateOnNewDocument(() => {
    let semSinal = false;
    try { semSinal = localStorage.getItem('__banco_sem_sinal') === '1'; } catch (e) { /* about:blank */ }
    if (!semSinal) return;
    const falha = { data: null, error: { message: 'TypeError: Failed to fetch' } };
    const consulta = new Proxy({}, { get: (t, k) => (k === 'then' ? (ok) => Promise.resolve(falha).then(ok) : () => consulta) });
    const cliente = {
      from: () => consulta, rpc: async () => falha, channel: () => ({ on() { return this; }, subscribe() { return this; } }),
      storage: { from: () => ({ upload: async () => falha, remove: async () => falha, list: async () => falha, createSignedUrl: async () => falha }) },
      auth: { getUser: async () => ({ data: { user: { id: 'u1' } }, error: null }), getSession: async () => ({ data: { session: null } }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }), signOut: async () => ({ error: null }) }
    };
    window.supabase = { createClient: () => cliente };
  });
  await page.goto(`${base}/HTML/Login.html`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.goto(`${base}/HTML/relatorio-viagem.html?novo=true`, { waitUntil: 'load' });
  const r = {};

  const estado = () => page.evaluate((TF, TA) => {
    const info = (sel) => {
      const t = document.querySelector(sel);
      const linhas = Array.from(t.tBodies[0].rows).filter(tr => !tr.classList.contains('linha-adicionar-celular'));
      const visiveis = linhas.filter(tr => getComputedStyle(tr).display !== 'none');
      const btn = t.querySelector('.btn-adicionar-linha-celular');
      const lim = t.querySelector('.texto-limite-linhas');
      return {
        existem: linhas.length, visiveis: visiveis.length,
        ultimoNumero: visiveis.length ? visiveis[visiveis.length - 1].querySelector('.num-rotulo').textContent.trim() : '',
        botao: !!btn && getComputedStyle(btn).display !== 'none' && btn.offsetParent !== null,
        limite: lim && getComputedStyle(lim).display !== 'none' && lim.offsetParent !== null ? lim.textContent : ''
      };
    };
    return {
      fretes: info(TF), abast: info(TA),
      rolagemH: document.documentElement.scrollWidth > window.innerWidth,
      totalFrete: document.getElementById('ml-total-relacao-frete').value,
      totalComissao: document.getElementById('ml-total-relacao-comissao').value,
      totalDescarga: document.getElementById('ml-total-relacao-descarga').value,
      totalDiesel: `${document.getElementById('ml-total-valor-diesel').value} / ${document.getElementById('ml-total-litros-diesel').value} L`,
      totalArla: `${document.getElementById('ml-total-valor-arla').value} / ${document.getElementById('ml-total-litros-arla').value} L`,
      namesRepetidos: (() => { const n = Array.from(document.querySelectorAll('#form-relatorio [name]')).map(e => e.name); return n.length - new Set(n).size; })()
    };
  }, TAB_FRETES, TAB_ABAST);

  // Clica no "+ Adicionar" até o bloco mostrar n linhas e preenche as linhas novas (como o motorista: evento input/change)
  const ate = async (n) => {
    for (const [tab, preencher] of [[TAB_FRETES, 'frete'], [TAB_ABAST, 'abast']]) {
      let vis = await page.$eval(tab, t => Number(t.dataset.mostrar || 1));
      while (vis < n) { await page.$eval(`${tab} .btn-adicionar-linha-celular`, b => b.click()); vis++; }
      await page.evaluate((tipo, n) => {
        const disparar = (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); };
        for (let i = 1; i <= n; i++) {
          if (tipo === 'frete') {
            const q = (c) => document.querySelector(`[name="${c}_frete_ml_${i}"]`);
            if (q('destino').value) continue;
            disparar(q('data'), '01/10/2026');
            disparar(q('cliente'), 'shopee');
            disparar(q('origem'), `Origem ${i}`);
            disparar(q('destino'), `Destino ${i}`);
            disparar(q('valor'), '10000');     // máscara: 100,00 (comissão Shopee 11,00)
            disparar(q('descarga'), '1000');   // 10,00
          } else {
            const q = (c) => document.querySelector(`[name="${c}_ml_${i}"]`);
            if (q('valor').value) continue;
            disparar(q('posto'), 'Marília - Posto Esmeralda');
            disparar(q('combustivel'), i % 10 === 0 ? 'arla' : 'diesel_s10');
            disparar(q('nf'), String(1000 + i));
            disparar(q('km'), String(100000 + i));
            disparar(q('valor'), '5000');      // 50,00
            disparar(q('litros'), '10000');    // 10,000 L
          }
        }
      }, preencher, n);
    }
    return estado();
  };

  r.inicio = await estado();
  r.com9 = await ate(9);
  r.com20 = await ate(20);
  const t0 = Date.now();
  r.com100 = await ate(100);
  r.tempoAte100ms = Date.now() - t0;

  // Digitar no frete 100 com 100 + 100 linhas: tempo de uma tecla (máscara + totais + rascunho)
  r.teclaNaLinha100ms = await page.evaluate(() => {
    const el = document.querySelector('[name="descarga_frete_ml_100"]');
    const t = performance.now();
    el.value = '2000'; el.dispatchEvent(new Event('input', { bubbles: true }));
    return Math.round(performance.now() - t);
  });
  r.totaisDepoisDaTecla = await estado().then(e => ({ frete: e.totalFrete, descarga: e.totalDescarga }));

  // 101º: o botão some, a mensagem aparece; clicar mesmo assim não cria linha
  await page.$eval(`${TAB_FRETES} .btn-adicionar-linha-celular`, b => b.click());
  await page.$eval(`${TAB_ABAST} .btn-adicionar-linha-celular`, b => b.click());
  await espera(100);
  const no101 = await estado();
  r.tentativa101 = {
    fretes: no101.fretes, abast: no101.abast,
    toast: await page.evaluate(() => document.querySelector('.toast-custom, .toast, #toast-container')?.textContent?.replace(/\s+/g, ' ').trim() || '(sem toast)'),
    linha101Existe: await page.evaluate(() => !!document.querySelector('[name="valor_frete_ml_101"], [name="valor_ml_101"]'))
  };

  // Remover o frete 50: os de baixo sobem (o 100 vira 99)
  await page.$eval('button.btn-limpar-linha-inline[data-linha="50"]', b => b.click());
  await espera(100);
  r.removeu50 = await page.evaluate(() => ({
    destino50: document.querySelector('[name="destino_frete_ml_50"]').value,
    destino99: document.querySelector('[name="destino_frete_ml_99"]').value,
    destino100: document.querySelector('[name="destino_frete_ml_100"]').value || '(vazio)'
  }));
  r.depoisDeRemover = await estado().then(e => ({ visiveis: e.fretes.visiveis, botao: e.fretes.botao, frete: e.totalFrete }));
  // volta o 100 para o envio
  await ate(100);

  // Envio: cabeçalho + revisão + confirmar; o que vai para o banco
  await page.evaluate(() => {
    window.reservarNumeroFichaSupabase = async () => 'AJB-2026-100';
    window.salvarFichaSupabase = async (f) => { window.__payload = window.mapearFichaParaSupabase(f); return { success: true }; };
  });
  const digitar = async (sel, txt) => { await page.$eval(sel, el => { el.value = ''; }); await page.focus(sel); await page.keyboard.type(txt); };
  await digitar('#placas', 'ABC1D23');
  await digitar('#km-saida', '100000');
  await digitar('#km-chegada', '105000');
  await digitar('#data-saida', '01102026');
  await digitar('#data-chegada', '05102026');
  await page.$eval('#destino-inicial', el => { el.value = 'Marília - SP'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await digitar('#valor-adiantamento', '0');
  await page.click('#btn-finalizar-relatorio-ml');
  await espera(300);
  r.revisao = await page.evaluate(() => ({
    aberta: document.querySelector('#modal-revisar-envio').classList.contains('ativo'),
    erros: Array.from(document.querySelectorAll('.erro-campo-celular')).map(e => e.textContent),
    qtdFretes: document.getElementById('revisar-qtd-fretes').textContent,
    qtdAbast: document.getElementById('revisar-qtd-abastecimentos').textContent,
    linhasFretes: document.querySelectorAll('#revisar-detalhes-viagem .revisar-linha').length
  }));
  await page.click('#btn-revisar-confirmar');
  await espera(800);
  r.envio = await page.evaluate(() => {
    const p = window.__payload;
    if (!p) return '(não enviou)';
    const fr = p.dados_completos.fretes || [];
    return {
      fretes: fr.length, abastecimentos: p.abastecimentos.length,
      primeiroFrete: fr[0] && fr[0].destino, ultimoFrete: fr[fr.length - 1] && fr[fr.length - 1].destino,
      ultimoAbast: p.abastecimentos[p.abastecimentos.length - 1] && p.abastecimentos[p.abastecimentos.length - 1].nf,
      total_frete: p.total_frete, vr_comissao: p.vr_comissao, totalAbastecimento: p.dados_completos.totalAbastecimento
    };
  });
  const fichaEnviada = await page.evaluate(() => {
    const p = window.__payload;
    return p && { ...p.dados_completos, id: 'AJB-2026-100', status: 'pendente', motorista: 'Motorista Teste', abastecimentos: p.abastecimentos, fretes: p.dados_completos.fretes, dataEnvio: '05/10/2026' };
  });

  // dashboard-admin: o resumo da ficha mostra as 100 + 100 linhas (inclusive no celular)
  if (fichaEnviada) {
    await page.goto(`${base}/HTML/Login.html`, { waitUntil: 'domcontentloaded' });
    await page.evaluate((f) => {
      localStorage.clear();
      localStorage.setItem('teste_usuario', JSON.stringify({ role: 'admin', nome: 'Gestão', id: 'a1', email: 'g@x' }));
      localStorage.setItem('ajborges_fichas_viagem', JSON.stringify([f]));
    }, fichaEnviada);
    await page.goto(`${base}/HTML/dashboard-admin.html`, { waitUntil: 'load' });
    await espera(1200);
    await page.evaluate(() => abrirModalResumoFicha('AJB-2026-100')); // eslint-disable-line no-undef
    await espera(300);
    r.dashboard = await page.evaluate(() => {
      const c = document.getElementById('modal-ficha-conteudo');
      const tabelas = Array.from(c.querySelectorAll('table'));
      const corpo = c.closest('.modal-body') || c;
      const ultima = (t) => t && t.tBodies[0].rows[t.tBodies[0].rows.length - 1];
      return {
        linhasPorTabela: tabelas.map(t => t.tBodies[0] ? t.tBodies[0].rows.length : 0),
        ultimoFrete: ultima(tabelas[0])?.textContent.replace(/\s+/g, ' ').trim(),
        ultimoAbast: ultima(tabelas[1])?.textContent.replace(/\s+/g, ' ').trim(),
        // dá para chegar na última linha rolando o modal (nada cortado por altura fixa)
        rolaAteOFim: (() => { corpo.scrollTop = corpo.scrollHeight; const u = ultima(tabelas[1]).getBoundingClientRect(); return u.bottom <= window.innerHeight + 1 && u.height > 0; })(),
        rolagemHPagina: document.documentElement.scrollWidth > window.innerWidth
      };
    });
  }

  // Cópia do rascunho (celular, sem sinal): 100 + 100, recarrega a página e volta com tudo.
  // O rascunho só liga com o cliente do Supabase: aqui um cliente falso em que o banco nunca responde.
  await page.goto(`${base}/HTML/Login.html`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { localStorage.clear(); localStorage.setItem('__banco_sem_sinal', '1'); });
  await page.goto(`${base}/HTML/relatorio-viagem.html?novo=true`, { waitUntil: 'load' });
  await espera(800);
  await ate(100);
  await espera(3500);
  const antes = await estado();
  await page.goto(`${base}/HTML/relatorio-viagem.html?novo=true`, { waitUntil: 'load' });
  await espera(1500);
  const depois = await estado();
  r.rascunhoVoltou = {
    copiaNoCelular: await page.evaluate(() => { const k = Object.keys(localStorage).find(k => k.startsWith('ajborges_rascunho_viagem_')); const c = k && JSON.parse(localStorage.getItem(k)); return c ? `${c.dados.fretes.length} fretes, ${c.dados.abastecimentos.length} abastecimentos` : '(sem cópia)'; }),
    fretes: `${antes.fretes.visiveis} -> ${depois.fretes.visiveis}`, abast: `${antes.abast.visiveis} -> ${depois.abast.visiveis}`,
    totalFrete: `${antes.totalFrete} -> ${depois.totalFrete}`, totalDiesel: `${antes.totalDiesel} -> ${depois.totalDiesel}`,
    totalArla: `${antes.totalArla} -> ${depois.totalArla}`,
    frete100: await page.evaluate(() => document.querySelector('[name="destino_frete_ml_100"]')?.value || '(não existe)'),
    abast100: await page.evaluate(() => ['posto', 'combustivel', 'nf', 'valor', 'litros'].map(c => document.querySelector(`[name="${c}_ml_100"]`)?.value ?? '(não existe)').join(' | ')),
    botaoNo100: depois.fretes.botao, limiteNo100: depois.fretes.limite
  };

  r.erros = erros;
  console.log(JSON.stringify(r, null, 2));
  await browser.close(); srv.close();
})().catch(e => { console.error(e); process.exit(1); });
