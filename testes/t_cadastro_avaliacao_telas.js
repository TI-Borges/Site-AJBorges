// Avaliação "Apto / Inapto" no Dashboard do Cadastro (passo25b): selo na lista e nos detalhes, filtro por
// avaliação, campo no modal gravando pela RPC avaliar_cadastro, motivo escapado. Em 1366 e 390 px.
// A ficha e a edge function não mostram nada disso. Nada vai para o Supabase (RPC e Storage simulados).
// Só dados inventados (nomes "de Teste").
// Uso: node testes/t_cadastro_avaliacao_telas.js   -> prints em testes/capturas/cadastro_avaliacao_*.png
const fs = require('fs');
const path = require('path');
const { abrir } = require('./harness');
const espera = (ms) => new Promise((res) => setTimeout(res, ms));
const RAIZ = path.resolve(__dirname, '..');
const CAP = path.join(__dirname, 'capturas');

const PERIGOSO = '<img src=x onerror="window.__xss=1">Documento <b>vencido</b>';

(async () => {
  const { srv, base, browser, page, erros } = await abrir({});
  const r = { estatico: {}, telas: {} };
  let ok = true;
  const confere = (cond, msg) => { if (!cond) { ok = false; console.log('FALHOU:', msg); } };

  // A ficha e a edge function não mencionam a avaliação
  for (const arq of ['HTML/FichaMultiCadastro.html', 'JavaScript/FichaMultiCadastro.js', 'supabase/functions/solicitar-cadastro/index.ts']) {
    r.estatico[arq] = /avalia|\bapto\b|inapto/i.test(fs.readFileSync(path.join(RAIZ, arq), 'utf8'));
    confere(!r.estatico[arq], `${arq} menciona a avaliação`);
  }

  for (const largura of [1366, 390]) {
    await page.setViewport({ width: largura, height: 900 });
    await page.goto(`${base}/HTML/Dashboard-cadastro-motorista.html`, { waitUntil: 'load' });
    await page.evaluate(() => localStorage.setItem('teste_usuario', JSON.stringify({ role: 'admin', nome: 'Admin Teste', id: 'a1' })));
    await page.goto(`${base}/HTML/Dashboard-cadastro-motorista.html`, { waitUntil: 'load' });
    const t = r.telas[largura] = {};

    t.lista = await page.evaluate(async (perigoso) => {
      const base = { celular: '11900000000', criado_em: '2026-10-27T12:00:00Z', etapas: {}, documentos: [], dados: {}, tipo: 'pf' };
      const lista = [
        { ...base, id: 'k1', status: 'pendente', nome: 'Fulano de Teste', cpf: '52316915930', avaliacao: 'apto', avaliacao_motivo: 'Conferido na GR', avaliado_por: 'gestao@teste.local', avaliado_em: '2026-11-01T10:00:00Z' },
        { ...base, id: 'k2', status: 'aprovado', nome: 'Beltrano de Teste', cpf: '11144477735', avaliacao: 'inapto', avaliacao_motivo: perigoso, avaliado_por: 'gestao@teste.local', avaliado_em: '2026-11-02T10:00:00Z' },
        { ...base, id: 'k3', status: 'analise', nome: 'Ciclano de Teste', cpf: '22255588846', avaliacao: null },
        { ...base, id: 'k4', status: 'recusado', nome: 'Sicrano de Teste', cpf: '33366699957' }
      ];
      window.__rpc = [];
      window.supabaseClient = {
        rpc: async (nome, args) => {
          window.__rpc.push({ nome, args });
          if (nome === 'avaliar_cadastro') {
            const a = args.p_avaliacao || null;
            return { data: { id: args.p_id, avaliacao: a, avaliacao_motivo: a ? args.p_motivo : null, avaliado_por: 'admin@teste.local', avaliado_em: '2026-11-04T15:30:00Z' }, error: null };
          }
          return { data: null, error: null };
        },
        storage: { from: () => ({
          list: async () => ({ data: [] }),
          createSignedUrls: async (cs) => ({ data: cs.map((p) => ({ path: p, signedUrl: `https://link.teste/${p}` })) }),
          createSignedUrl: async (p) => ({ data: { signedUrl: `https://link.teste/${p}` } })
        }) }
      };
      cadastros = lista; // eslint-disable-line no-undef
      renderTabela(); // eslint-disable-line no-undef
      const linhas = () => Array.from(document.querySelectorAll('#driver-table-body tr')).map((tr) => {
        const id = tr.querySelector('[data-acao="abrir"]')?.getAttribute('data-id');
        const s = tr.querySelector('.selo-avaliacao');
        return `${id}:${s ? `${s.textContent}/${s.classList.contains('apto') ? 'verde' : s.classList.contains('inapto') ? 'vermelho' : '?'}` : '-'}`;
      });
      const filtrar = (v) => { const sel = document.getElementById('filtro-avaliacao'); sel.value = v; sel.dispatchEvent(new Event('change', { bubbles: true })); return linhas(); };
      const res = {
        todos: linhas(),
        apto: filtrar('apto'),
        inapto: filtrar('inapto'),
        sem: filtrar('sem')
      };
      filtrar('todas');
      // Filtro de avaliação junto com a aba de status
      document.querySelector('#tab-filter-container [data-tab="aprovado"]').click();
      res.abaDocsOkComInapto = filtrar('inapto');
      document.querySelector('#tab-filter-container [data-tab="todos"]').click();
      filtrar('todas');
      res.tituloDoSeloInapto = document.querySelector('#driver-table-body .selo-avaliacao.apto, #driver-table-body .selo-avaliacao.inapto') && Array.from(document.querySelectorAll('#driver-table-body .selo-avaliacao.inapto')).map((s) => s.getAttribute('title'))[0];
      res.semHtmlInjetado = !document.querySelector('#driver-table-body img, #driver-table-body b') && !window.__xss;
      return res;
    }, PERIGOSO);
    confere(JSON.stringify(t.lista.todos) === JSON.stringify(['k1:Apto/verde', 'k2:Inapto/vermelho', 'k3:-', 'k4:-']), `${largura}: selos ${t.lista.todos}`);
    confere(JSON.stringify(t.lista.apto) === '["k1:Apto/verde"]' && JSON.stringify(t.lista.inapto) === '["k2:Inapto/vermelho"]' &&
      JSON.stringify(t.lista.sem) === '["k3:-","k4:-"]', `${largura}: filtro por avaliação`);
    confere(JSON.stringify(t.lista.abaDocsOkComInapto) === '["k2:Inapto/vermelho"]', `${largura}: filtro junto com a aba`);
    confere(t.lista.tituloDoSeloInapto === PERIGOSO && t.lista.semHtmlInjetado, `${largura}: motivo não escapado na lista`);
    await page.screenshot({ path: path.join(CAP, `cadastro_avaliacao_lista_${largura}.png`) });

    // Detalhes do cadastro "Inapto" com motivo perigoso: aparece como texto
    t.detalhesInapto = await page.evaluate(async () => {
      await abrirModal('k2'); // eslint-disable-line no-undef
      await new Promise((res) => setTimeout(res, 100));
      const corpo = document.getElementById('modal-body-content');
      return {
        topo: corpo.querySelector('.cad-topo').innerText.split('\n').find((l) => /Avaliação/.test(l)) || '',
        seloTopo: corpo.querySelector('.cad-topo .selo-avaliacao')?.className || '',
        marcadoInapto: corpo.querySelector('#secao-avaliacao input[value="inapto"]').checked,
        motivoNoCampo: corpo.querySelector('#avaliacao-motivo').value,
        quem: corpo.querySelector('.avaliacao-rodape').innerText,
        semHtmlInjetado: !corpo.querySelector('img') && !Array.from(corpo.querySelectorAll('b')).some((b) => b.textContent === 'vencido') && !window.__xss
      };
    });
    confere(t.detalhesInapto.seloTopo === 'selo-avaliacao inapto' && t.detalhesInapto.marcadoInapto, `${largura}: detalhes do inapto`);
    confere(t.detalhesInapto.motivoNoCampo === '<img src=x onerror="window.__xss=1">Documento <b>vencido</b>' &&
      t.detalhesInapto.topo.includes('<img src=x') && t.detalhesInapto.semHtmlInjetado, `${largura}: motivo não escapado nos detalhes`);
    confere(/gestao@teste\.local/.test(t.detalhesInapto.quem), `${largura}: quem marcou`);

    // Marca "Inapto" num cadastro sem avaliação, com motivo; depois volta para "Sem avaliação"
    t.marcar = await page.evaluate(async () => {
      await abrirModal('k3'); // eslint-disable-line no-undef
      await new Promise((res) => setTimeout(res, 100));
      const corpo = document.getElementById('modal-body-content');
      const antes = { status: cadastros.find((c) => c.id === 'k3').status, sem: corpo.querySelector('#secao-avaliacao input[value=""]').checked }; // eslint-disable-line no-undef
      corpo.querySelector('#secao-avaliacao input[value="inapto"]').checked = true;
      const txt = corpo.querySelector('#avaliacao-motivo');
      txt.value = '  Placa <i>divergente</i> no CRLV  ';
      txt.dispatchEvent(new Event('input', { bubbles: true }));
      const contador = document.getElementById('avaliacao-contador').textContent;
      corpo.querySelector('[data-acao="salvar-avaliacao"]').click();
      await new Promise((res) => setTimeout(res, 300));
      const c = cadastros.find((x) => x.id === 'k3'); // eslint-disable-line no-undef
      const linha = Array.from(document.querySelectorAll('#driver-table-body tr')).find((tr) => tr.querySelector('[data-id="k3"]'));
      const depois = {
        rpc: window.__rpc[window.__rpc.length - 1],
        avaliacao: c.avaliacao, motivo: c.avaliacao_motivo, status: c.status,
        seloLista: linha.querySelector('.selo-avaliacao')?.textContent || '-',
        quem: document.querySelector('#modal-body-content .avaliacao-rodape').innerText,
        semHtmlInjetado: !document.querySelector('#modal-body-content .cad-topo i')
      };
      // Volta para "Sem avaliação": o motivo some
      document.querySelector('#secao-avaliacao input[value=""]').checked = true;
      document.querySelector('#modal-body-content [data-acao="salvar-avaliacao"]').click();
      await new Promise((res) => setTimeout(res, 300));
      const volta = { rpc: window.__rpc[window.__rpc.length - 1], avaliacao: c.avaliacao, motivo: c.avaliacao_motivo, status: c.status,
        seloLista: Array.from(document.querySelectorAll('#driver-table-body tr')).find((tr) => tr.querySelector('[data-id="k3"]')).querySelector('.selo-avaliacao')?.textContent || '-' };
      return { antes, contador, depois, volta, outrasRpc: window.__rpc.filter((x) => x.nome !== 'avaliar_cadastro').map((x) => x.nome) };
    });
    const m = t.marcar;
    confere(m.antes.sem && m.contador === '35/300', `${largura}: estado inicial/contador ${m.contador}`);
    confere(m.depois.rpc.nome === 'avaliar_cadastro' && m.depois.rpc.args.p_id === 'k3' && m.depois.rpc.args.p_avaliacao === 'inapto' &&
      m.depois.rpc.args.p_motivo === 'Placa <i>divergente</i> no CRLV', `${largura}: chamada da RPC ${JSON.stringify(m.depois.rpc)}`);
    confere(m.depois.avaliacao === 'inapto' && m.depois.status === 'analise' && m.depois.seloLista === 'Inapto' &&
      /admin@teste\.local/.test(m.depois.quem) && m.depois.semHtmlInjetado, `${largura}: depois de marcar ${JSON.stringify(m.depois)}`);
    confere(m.volta.rpc.args.p_avaliacao === null && m.volta.rpc.args.p_motivo === null && m.volta.avaliacao === null &&
      m.volta.motivo === null && m.volta.status === 'analise' && m.volta.seloLista === '-', `${largura}: voltar para sem avaliação`);
    confere(!m.outrasRpc.length, `${largura}: chamou outras RPCs: ${m.outrasRpc}`);

    // Print do modal com a seção de avaliação
    await page.evaluate(async () => { await abrirModal('k2'); document.getElementById('secao-avaliacao').scrollIntoView(); }); // eslint-disable-line no-undef
    await espera(250);
    await page.screenshot({ path: path.join(CAP, `cadastro_avaliacao_modal_${largura}.png`) });
    t.semRolagemLateral = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    confere(t.semRolagemLateral, `${largura}: rolagem lateral`);
  }

  r.errosNaPagina = erros;
  confere(!erros.length, `erros na página: ${erros.join(' | ')}`);
  console.log(JSON.stringify(r, null, 2));
  console.log(ok ? 'OK' : 'FALHOU');
  await browser.close(); srv.close();
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
