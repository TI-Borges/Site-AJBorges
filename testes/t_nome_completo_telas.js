// "Nome completo" do motorista nas telas, em 1366 e 390 px. Só dados inventados; nada vai para o Supabase
// (a edge function é simulada no navegador e só guarda o corpo recebido).
// Ficha: PF e PJ mostram só "Nome completo" (sem "Sobrenome"); uma palavra só é recusada ("Informe o nome
// completo") e nada é enviado; espaços das pontas e repetidos saem; envia o nome completo em
// dados["motorista-nome"] sem "motorista-sobrenome".
// Dashboard: os 5 casos de nome + sobrenome dos cadastros antigos (só na tela) na lista, busca, detalhes,
// selo "CPF repetido", PDF e no primeiro nome do "Avisar no WhatsApp"; nada muda nos cadastros.
// Uso: node testes/t_nome_completo_telas.js   -> prints em testes/capturas/nome_completo_*.png
const path = require('path');
const { abrir } = require('./harness');
const espera = (ms) => new Promise((res) => setTimeout(res, ms));
const CAP = path.join(__dirname, 'capturas');
let falhas = 0;
const ok = (cond, msg, extra) => { console.log(`${cond ? 'OK  ' : 'FALHA'} ${msg}${extra !== undefined ? ` (${typeof extra === 'string' ? extra : JSON.stringify(extra)})` : ''}`); if (!cond) falhas++; };

const NA_PAGINA = () => {
  window.__arq = {
    pdf: (nome) => new File([new Uint8Array(2048).fill(37)], nome, { type: 'application/pdf' }),
    async foto(nome) {
      const c = document.createElement('canvas'); c.width = 400; c.height = 300;
      c.getContext('2d').fillRect(0, 0, 400, 300);
      return new File([await new Promise((r) => c.toBlob(r, 'image/png'))], nome, { type: 'image/png' });
    },
    escolher(sel, arquivos) {
      const input = document.querySelector(sel);
      const dt = new DataTransfer();
      arquivos.forEach((f) => dt.items.add(f));
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    },
    async pronto(sel) {
      const zona = document.querySelector(sel).closest('.upload-dropzone');
      for (let i = 0; i < 100 && zona.dataset.processando; i++) await new Promise((r) => setTimeout(r, 50));
    }
  };
  window.__corpos = [];
  window.solicitarCadastroAgregado = async (corpo) => {
    window.__corpos.push(JSON.parse(JSON.stringify(corpo)));
    let i = 0;
    const uploads = Object.entries(corpo.documentos).flatMap(([campo, l]) => l.map((d) => ({ indice: i++, campo, path: `terceiros/cad-teste/${campo}_${i}_${d.nome}`, token: `t${i}` })));
    return { sucesso: true, cadastroId: 'cad-teste', uploads };
  };
  window.supabaseClient = { storage: { from: () => ({ uploadToSignedUrl: async () => ({ error: null }) }) } };
};

async function preencherPf(page, nome) {
  await page.select('#pf-tipologia', 'Toco (4×2)');
  await page.evaluate(async (nome) => {
    const v = (id, val) => { const el = document.getElementById(id); el.value = val; el.dispatchEvent(new Event('input', { bubbles: true })); };
    v('pf-motorista-nome', nome);
    v('pf-cpf', '523.169.159-30'); v('pf-celular', '(11) 90000-0000');
    v('pf-rastreador-marca', 'Sascar'); v('pf-rastreador-id', 'TESTE-000123');
    __arq.escolher('#pf-anexo-cnh', [__arq.pdf('cnh.pdf')]);
    document.querySelectorAll('#pf-crlvs input[type=file]').forEach((i) => __arq.escolher(`#${i.id}`, [__arq.pdf('crlv.pdf')]));
    __arq.escolher('#pf-anexo-rntrc', [__arq.pdf('rntrc.pdf')]);
    __arq.escolher('#pf-anexo-selfie', [await __arq.foto('selfie.png')]);
    document.getElementById('pf-aceite-lgpd').checked = true;
  }, nome);
  await page.evaluate(() => __arq.pronto('#pf-anexo-selfie'));
}

const clicarEnviar = (page) => page.evaluate(() => document.querySelector('#form-pf button[type="submit"]').click());

(async () => {
  const { srv, base, browser, page, erros } = await abrir({});

  // ---------- Ficha ----------
  for (const largura of [1366, 390]) {
    console.log(`\n--- Ficha ${largura}px ---`);
    await page.setViewport({ width: largura, height: 900 });
    await page.goto(`${base}/HTML/FichaMultiCadastro.html`, { waitUntil: 'load' });
    await page.evaluate(NA_PAGINA);

    const campos = await page.evaluate(() => ['pf', 'pj'].map((p) => {
      const el = document.getElementById(`${p}-motorista-nome`);
      const label = document.querySelector(`label[for="${p}-motorista-nome"]`);
      const form = el.closest('form');
      // Nenhum campo nem rótulo "Sobrenome" (a dica "Nome e sobrenome do motorista..." pode ter a palavra)
      const rotulos = Array.from(form.querySelectorAll('label, .field-sublabel')).map((x) => x.textContent.replace(/\s+/g, ' ').trim());
      return { p, rotulo: label && label.textContent.replace(/\s+/g, ' ').trim(), required: el.required, sobrenome: !!form.querySelector('[name*="sobrenome"], [id*="sobrenome"]'), textoSobrenome: rotulos.some((t) => /^Sobrenome/i.test(t)) };
    }));
    ok(campos.every((c) => /^Nome completo:/.test(c.rotulo) && c.required && !c.sobrenome && !c.textoSobrenome), 'PF e PJ: só "Nome completo" (obrigatório), sem "Sobrenome"', campos);

    await page.click('#card-pf');
    // Uma palavra só: recusada, nada enviado
    await preencherPf(page, 'Fulano');
    await clicarEnviar(page);
    await espera(300);
    const umaPalavra = await page.evaluate(() => ({
      msg: document.getElementById('pf-motorista-nome').validationMessage,
      revisar: document.getElementById('modal-revisar-cadastro').classList.contains('ativo'),
      enviados: window.__corpos.length
    }));
    ok(umaPalavra.msg === 'Informe o nome completo' && !umaPalavra.revisar && umaPalavra.enviados === 0, 'uma palavra só: "Informe o nome completo" e nada enviado', umaPalavra);
    // Mais de 120 letras: recusado
    await page.evaluate(() => { const el = document.getElementById('pf-motorista-nome'); el.value = `Fulano ${'a'.repeat(114)}`; el.dispatchEvent(new Event('input', { bubbles: true })); });
    await clicarEnviar(page);
    await espera(300);
    const longo = await page.evaluate(() => ({ msg: document.getElementById('pf-motorista-nome').validationMessage, enviados: window.__corpos.length }));
    ok(/no máximo 120 letras/.test(longo.msg) && longo.enviados === 0, 'mais de 120 letras: recusado', longo);
    // Espaços nas pontas e repetidos: saem ao sair do campo
    await page.evaluate(() => { const el = document.getElementById('pf-motorista-nome'); el.value = '  João   da  Silva de Teste '; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('blur')); });
    const limpo = await page.$eval('#pf-motorista-nome', (el) => el.value);
    ok(limpo === 'João da Silva de Teste', 'tira espaços das pontas e repetidos', limpo);
    await page.evaluate(() => document.getElementById('pf-motorista-nome').scrollIntoView({ block: 'center' }));
    await espera(150);
    await page.screenshot({ path: path.join(CAP, `nome_completo_ficha_${largura}.png`) });
    // Envia: nome completo em dados["motorista-nome"], sem sobrenome
    await clicarEnviar(page);
    await espera(300);
    const resumo = await page.$eval('#resumo-cadastro', (el) => el.textContent.replace(/\s+/g, ' '));
    ok(/Motorista: João da Silva de Teste · CPF/.test(resumo), 'revisão mostra o nome completo', resumo.slice(0, 120));
    await page.click('#btn-confirmar-envio');
    await espera(900);
    const enviado = await page.evaluate(() => window.__corpos[0] && window.__corpos[0].dados);
    ok(!!enviado && enviado['motorista-nome'] === 'João da Silva de Teste' && !Object.hasOwn(enviado, 'motorista-sobrenome'), 'envia o nome completo em dados["motorista-nome"], sem "motorista-sobrenome"', enviado);
    ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'ficha sem rolagem lateral');
  }

  // ---------- Dashboard (cadastros antigos: só na tela) ----------
  const CASOS = [
    // [id, motorista-nome, motorista-sobrenome, coluna nome (como a edge function antiga gravou), esperado, primeiro nome]
    ['k1', 'Ana Paula de Teste', '', 'Ana Paula de Teste', 'Ana Paula de Teste', 'Ana'],
    ['k2', 'José da Silva de Teste', 'jose  DA silva de teste', 'José da Silva de Teste jose  DA silva de teste', 'José da Silva de Teste', 'José'],
    ['k3', 'Carlos', 'Carlos Alberto de Teste', 'Carlos Carlos Alberto de Teste', 'Carlos Alberto de Teste', 'Carlos'],
    ['k4', 'Márcia Regina de Teste', 'de Teste', 'Márcia Regina de Teste de Teste', 'Márcia Regina de Teste', 'Márcia'],
    ['k5', 'Marcos', 'Pereira de Teste', 'Marcos Pereira de Teste', 'Marcos Pereira de Teste', 'Marcos'],
    // Cadastro novo (campo único)
    ['k6', 'Rita de Cássia de Teste', undefined, 'Rita de Cássia de Teste', 'Rita de Cássia de Teste', 'Rita'],
    // Nome com HTML: escapado
    ['k7', 'Beto <img src=x onerror="window.__xss=1">', 'de Teste', 'x', 'Beto <img src=x onerror="window.__xss=1"> de Teste', 'Beto']
  ];
  for (const largura of [1366, 390]) {
    console.log(`\n--- Dashboard ${largura}px ---`);
    await page.setViewport({ width: largura, height: 900 });
    await page.goto(`${base}/HTML/Dashboard-cadastro-motorista.html`, { waitUntil: 'load' });
    await page.evaluate(() => localStorage.setItem('teste_usuario', JSON.stringify({ role: 'admin', nome: 'Admin Teste', id: 'a1' })));
    await page.goto(`${base}/HTML/Dashboard-cadastro-motorista.html`, { waitUntil: 'load' });
    const d = await page.evaluate(async (CASOS) => {
      const base = { tipo: 'pf', celular: '11900000000', criado_em: '2026-10-27T12:00:00Z', etapas: {}, documentos: [], status: 'aprovado' };
      const lista = CASOS.map(([id, n, s, coluna], i) => {
        const dados = { 'motorista-nome': n, cpf: '52316915930' };
        if (s !== undefined) dados['motorista-sobrenome'] = s;
        if (id === 'k6') dados._tipologia = 'Toco (4×2)';
        // k2 e k3 com o mesmo CPF: selo "CPF repetido"
        const cpf = (id === 'k2' || id === 'k3') ? '11144477735' : `5231691593${i}`;
        return { ...base, id, nome: coluna, cpf, celular: `1190000000${i}`, dados };
      });
      const antes = JSON.stringify(lista);
      // Supabase simulado: conta qualquer gravação (não pode haver nenhuma)
      window.__gravacoes = 0;
      window.supabaseClient = {
        rpc: async () => { window.__gravacoes++; return { data: null, error: null }; },
        from: () => ({ update: () => { window.__gravacoes++; return { eq: async () => ({ error: null }) }; } }),
        storage: { from: () => ({
          list: async () => ({ data: [] }),
          createSignedUrls: async (cs) => ({ data: cs.map((p) => ({ path: p, signedUrl: `https://link.teste/${p}` })) }),
          createSignedUrl: async (p) => ({ data: { signedUrl: `https://link.teste/${p}` } })
        }) }
      };
      cadastros = lista; // eslint-disable-line no-undef
      renderTabela(); // eslint-disable-line no-undef
      const linha = (id) => document.querySelector(`#driver-table-body [data-acao="abrir"][data-id="${id}"]`).closest('tr');
      const r = {};
      for (const [id] of CASOS) {
        const tr = linha(id);
        r[id] = { lista: tr.querySelector('div[style*="font-weight: 600"]').textContent.trim(), selo: !!tr.querySelector('.selo-repetido') };
        await abrirModal(id); // eslint-disable-line no-undef
        r[id].titulo = document.getElementById('modal-title').textContent;
        const inp = Array.from(document.querySelectorAll('#modal-body-content .cad-campo')).find((l) => l.querySelector('span').textContent === 'Nome completo');
        r[id].detalhe = inp && inp.querySelector('input').value;
        r[id].editavel = !!(inp && inp.querySelector('input').hasAttribute('data-campo'));
        r[id].temSobrenomeNaTela = Array.from(document.querySelectorAll('#modal-body-content .cad-campo span')).some((s) => s.textContent === 'Sobrenome');
        const wa = document.querySelector('#modal-footer-actions .btn-whatsapp');
        r[id].whatsapp = wa ? decodeURIComponent(new URL(wa.href).searchParams.get('text')) : null;
        const c = cadastros.find((x) => x.id === id); // eslint-disable-line no-undef
        const html = fichaHtml(c, { enviados: new Set(), nomes: {}, srcFoto: () => null, imprimir: false }); // eslint-disable-line no-undef
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const linhaNome = Array.from(doc.querySelectorAll('tr')).find((t) => t.querySelector('th') && t.querySelector('th').textContent === 'Nome');
        r[id].pdf = linhaNome && linhaNome.querySelector('td').textContent;
        r[id].pdfTitulo = doc.title;
        r[id].pdfImg = !!doc.querySelector('td img');
        fecharModal(); // eslint-disable-line no-undef
      }
      // Busca pelo nome juntado (e não acha pelo pedaço repetido de propósito)
      const busca = document.getElementById('driver-search-input');
      const buscar = (t) => { busca.value = t; busca.dispatchEvent(new Event('input', { bubbles: true })); return Array.from(document.querySelectorAll('#driver-table-body [data-acao="abrir"]')).map((b) => b.getAttribute('data-id')); };
      r.buscaAlberto = buscar('carlos alberto');
      r.buscaRita = buscar('rita de cássia');
      r.buscaDuplicada = buscar('teste jose');
      buscar('');
      r.intactos = JSON.stringify(cadastros) === antes && window.__gravacoes === 0; // eslint-disable-line no-undef
      r.xss = !!window.__xss || !!document.querySelector('#driver-table-body img');
      return r;
    }, CASOS);
    for (const [id, , , , esperado, primeiro] of CASOS) {
      const x = d[id];
      ok(x.lista === esperado && x.titulo === `Cadastro • ${esperado}` && x.detalhe === esperado && x.pdf === esperado && x.pdfTitulo === `Cadastro - ${esperado}` && !x.temSobrenomeNaTela,
        `${id}: lista, detalhes e PDF mostram "${esperado}"`, x);
      ok(x.whatsapp === `Olá, ${primeiro}! Aqui é da AJBorges Transportes. Seu cadastro foi aprovado. ✅`, `${id}: WhatsApp com o primeiro nome "${primeiro}"`, x.whatsapp);
    }
    ok(d.k2.selo && d.k3.selo && !d.k1.selo, 'selo "CPF repetido" ao lado do nome juntado', { k2: d.k2.lista, k3: d.k3.lista });
    ok(!d.k2.editavel && !d.k3.editavel && d.k6.editavel, 'cadastro antigo: nome juntado só para ver (Editar/Salvar não grava); novo continua editável', { k2: d.k2.editavel, k6: d.k6.editavel });
    ok(JSON.stringify(d.buscaAlberto) === '["k3"]' && JSON.stringify(d.buscaRita) === '["k6"]' && d.buscaDuplicada.length === 0, 'busca pelo nome juntado', { a: d.buscaAlberto, r: d.buscaRita, dup: d.buscaDuplicada });
    ok(d.intactos, 'nada muda nos cadastros (só na tela)');
    ok(!d.xss && !d.k7.pdfImg, 'escapeHtml: nome com <img onerror> não vira elemento (lista, detalhes e PDF)');
    ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'dashboard sem rolagem lateral');
    await page.evaluate(() => document.getElementById('driver-table-body').scrollIntoView({ block: 'start' }));
    await espera(200);
    await page.screenshot({ path: path.join(CAP, `nome_completo_dashboard_${largura}.png`) });
    await page.evaluate(() => abrirModal('k3')); // eslint-disable-line no-undef
    await espera(300);
    await page.evaluate(() => Array.from(document.querySelectorAll('#modal-body-content .cad-campo'))
      .find((l) => l.querySelector('span').textContent === 'Nome completo').closest('fieldset').scrollIntoView({ block: 'start' }));
    await espera(200);
    await page.screenshot({ path: path.join(CAP, `nome_completo_dashboard_detalhe_${largura}.png`) });
    await page.evaluate(() => fecharModal()); // eslint-disable-line no-undef
  }

  const errosJs = erros.filter((e) => !/Failed to fetch|Swiper|limparDadosLocais/.test(e));
  ok(errosJs.length === 0, 'sem erros de JS', errosJs.join(' | '));
  console.log(falhas ? `\n${falhas} FALHA(S)` : '\nTUDO OK');
  await browser.close(); srv.close();
  process.exit(falhas ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
