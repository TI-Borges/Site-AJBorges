// Cadastro único pelo CPF do motorista nas telas: a ficha mostra o aviso do servidor sem apagar o que foi
// preenchido (e não consulta CPF antes do envio); o Dashboard do Cadastro mostra o selo "CPF repetido"
// (só CPF; o CNPJ não conta) e o filtro "Só repetidos". Em 1366 e 390 px.
// Nada vai para o Supabase: a edge function e o Storage são simulados no navegador (com a mesma regra
// do trigger do passo25). Só dados inventados (CPF de teste 523.169.159-30, nomes "de Teste").
// Uso: node testes/t_cadastro_unico_telas.js   -> prints em testes/capturas/cadastro_unico_*.png
const path = require('path');
const { abrir } = require('./harness');
const espera = (ms) => new Promise((res) => setTimeout(res, ms));
const CAP = path.join(__dirname, 'capturas');

const MSG = 'Já existe um cadastro com este CPF em análise. Aguarde o retorno da nossa equipe ou fale com a gente pelo WhatsApp (14) 99858-4705.';

// Simulação na página: arquivos, edge function (com a regra do trigger) e Storage
const NA_PAGINA = (msg) => {
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
  // "Banco" guardado entre recarregamentos da página (cadastros ativos por CPF)
  const ativos = () => JSON.parse(sessionStorage.getItem('__ativos') || '[]');
  window.__chamadas = 0;
  window.solicitarCadastroAgregado = async (corpo) => {
    window.__chamadas++;
    const cpf = String(corpo.dados.cpf || '').replace(/\D/g, '');
    if (ativos().includes(cpf)) return { sucesso: false, erro: msg };
    sessionStorage.setItem('__ativos', JSON.stringify([...ativos(), cpf]));
    let i = 0;
    const uploads = Object.entries(corpo.documentos).flatMap(([campo, l]) => l.map((d) => ({ indice: i++, campo, path: `terceiros/cad-teste/${campo}_${i}_${d.nome}`, token: `t${i}` })));
    return { sucesso: true, cadastroId: 'cad-teste', uploads };
  };
  window.supabaseClient = { storage: { from: () => ({ uploadToSignedUrl: async () => ({ error: null }) }) } };
  // Qualquer chamada de rede feita pela ficha antes do envio
  window.__fetches = [];
  const f = window.fetch;
  window.fetch = (...a) => { window.__fetches.push(String(a[0])); return f(...a); };
};

async function novaFicha(page, base) {
  await page.goto(`${base}/HTML/FichaMultiCadastro.html`, { waitUntil: 'load' });
  await page.evaluate(NA_PAGINA, MSG);
  await page.click('#card-pf');
}

async function preencher(page, cpf) {
  await page.select('#pf-tipologia', 'Toco (4×2)');
  await page.evaluate(async (cpf) => {
    const v = (id, val) => { const el = document.getElementById(id); el.value = val; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('blur', { bubbles: true })); };
    v('pf-motorista-nome', 'Fulano'); v('pf-motorista-sobrenome', 'de Teste');
    v('pf-cpf', cpf); v('pf-celular', '(11) 90000-0000');
    v('pf-rastreador-marca', 'Sascar'); v('pf-rastreador-id', 'TESTE-000123');
    __arq.escolher('#pf-anexo-cnh', [__arq.pdf('cnh.pdf')]);
    document.querySelectorAll('#pf-crlvs input[type=file]').forEach((i) => __arq.escolher(`#${i.id}`, [__arq.pdf('crlv.pdf')]));
    __arq.escolher('#pf-anexo-rntrc', [__arq.pdf('rntrc.pdf')]);
    __arq.escolher('#pf-anexo-selfie', [await __arq.foto('selfie.png')]);
    document.getElementById('pf-aceite-lgpd').checked = true;
  }, cpf);
  await page.evaluate(() => __arq.pronto('#pf-anexo-selfie'));
}

async function enviar(page) {
  page._dialogos = [];
  await page.evaluate(() => document.querySelector('#form-pf button[type="submit"]').click());
  await espera(250);
  await page.click('#btn-confirmar-envio');
  await espera(900);
  return page.evaluate(() => {
    const ativo = (id) => document.getElementById(id).classList.contains('ativo');
    return {
      sucesso: ativo('modal-sucesso-cadastro'),
      duplicado: ativo('modal-cadastro-duplicado'),
      texto: document.getElementById('texto-cadastro-duplicado').textContent,
      whatsapp: document.getElementById('btn-duplicado-whatsapp').getAttribute('href') || '',
      preenchido: {
        nome: document.getElementById('pf-motorista-nome').value,
        cpf: document.getElementById('pf-cpf').value,
        tipologia: document.getElementById('pf-tipologia').value,
        // A ficha guarda os arquivos numa lista própria; na tela, uma prévia por arquivo
        anexos: document.querySelectorAll('#form-pf .file-preview-nome').length,
        aceite: document.getElementById('pf-aceite-lgpd').checked
      },
      chamadas: window.__chamadas
    };
  }).then((r) => ({ ...r, alertas: (page._dialogos || []).join(' / ') }));
}

(async () => {
  const { srv, base, browser, page, erros } = await abrir({});
  const r = { ficha: {}, dashboard: {} };
  let ok = true;
  const confere = (cond, msg) => { if (!cond) { ok = false; console.log('FALHOU:', msg); } };

  for (const largura of [1366, 390]) {
    await page.setViewport({ width: largura, height: 900 });
    const f = r.ficha[largura] = {};
    await page.goto(`${base}/HTML/FichaMultiCadastro.html`, { waitUntil: 'load' });
    await page.evaluate(() => sessionStorage.clear());

    // 1. Primeiro envio: sucesso. Preencher o CPF não chama nada (sem consulta antes do envio)
    await novaFicha(page, base);
    await preencher(page, '523.169.159-30');
    f.redeAntesDoEnvio = await page.evaluate(() => window.__fetches.length + window.__chamadas);
    f.primeiro = await enviar(page);
    confere(f.redeAntesDoEnvio === 0, `${largura}: a ficha consultou algo antes do envio`);
    confere(f.primeiro.sucesso && !f.primeiro.duplicado, `${largura}: primeiro envio não deu sucesso`);

    // 2. Segundo envio com o mesmo CPF: aviso com a mensagem do servidor; nada do que foi preenchido some
    await novaFicha(page, base);
    await preencher(page, '523.169.159-30');
    f.segundo = await enviar(page);
    confere(f.segundo.duplicado && !f.segundo.sucesso, `${largura}: segundo envio não mostrou o aviso`);
    confere(f.segundo.texto === MSG, `${largura}: mensagem do aviso diferente`);
    confere(!f.segundo.alertas, `${largura}: abriu alert em vez do aviso`);
    confere(f.segundo.preenchido.nome === 'Fulano' && f.segundo.preenchido.cpf === '523.169.159-30' &&
      f.segundo.preenchido.tipologia === 'Toco (4×2)' && f.segundo.preenchido.anexos === 4 && f.segundo.preenchido.aceite,
      `${largura}: o formulário foi apagado`);
    confere(!/523|169|Fulano/.test(decodeURIComponent(f.segundo.whatsapp)), `${largura}: link do WhatsApp com dados`);
    await page.screenshot({ path: path.join(CAP, `cadastro_unico_aviso_${largura}.png`) });
    // "Entendi" fecha e o formulário continua lá
    await page.click('#btn-duplicado-fechar');
    f.depoisDeFechar = await page.evaluate(() => ({
      aberto: document.getElementById('modal-cadastro-duplicado').classList.contains('ativo'),
      cpf: document.getElementById('pf-cpf').value
    }));
    confere(!f.depoisDeFechar.aberto && f.depoisDeFechar.cpf === '523.169.159-30', `${largura}: fechar o aviso perdeu dados`);

    // 3. Pontuação diferente também é bloqueada
    await novaFicha(page, base);
    await preencher(page, '52316915930');
    f.semPontos = await enviar(page);
    confere(f.semPontos.duplicado && f.semPontos.texto === MSG, `${largura}: CPF sem pontos passou`);

    // 4. Depois que a gestão recusa o anterior, o mesmo formulário (ainda preenchido) é aceito
    await page.evaluate(() => sessionStorage.setItem('__ativos', '[]'));
    await page.click('#btn-duplicado-fechar');
    f.depoisDeRecusar = await enviar(page);
    confere(f.depoisDeRecusar.sucesso && !f.depoisDeRecusar.duplicado, `${largura}: depois de recusar não aceitou`);
  }

  // 5. Dashboard: selo e filtro (cadastros inventados, inclusive duplicados como os de hoje)
  for (const largura of [1366, 390]) {
    await page.setViewport({ width: largura, height: 900 });
    await page.goto(`${base}/HTML/Dashboard-cadastro-motorista.html`, { waitUntil: 'load' });
    await page.evaluate(() => localStorage.setItem('teste_usuario', JSON.stringify({ role: 'admin', nome: 'Admin Teste', id: 'a1' })));
    await page.goto(`${base}/HTML/Dashboard-cadastro-motorista.html`, { waitUntil: 'load' });
    const d = r.dashboard[largura] = await page.evaluate(async () => {
      const base = { celular: '11900000000', criado_em: '2026-10-27T12:00:00Z', etapas: {}, documentos: [], dados: {} };
      const lista = [
        { ...base, id: 'a1', tipo: 'pf', status: 'pendente', nome: 'Fulano de Teste', cpf: '52316915930' },
        { ...base, id: 'a2', tipo: 'pf', status: 'analise', nome: 'Fulano de Teste', cpf: '523.169.159-30' },
        { ...base, id: 'a3', tipo: 'pf', status: 'recusado', nome: 'Fulano de Teste', cpf: '52316915930' },
        { ...base, id: 'b1', tipo: 'pf', status: 'aprovado', nome: 'Beltrano de Teste', cpf: '11144477735' },
        { ...base, id: 'b2', tipo: 'pf', status: 'recusado', nome: 'Beltrano de Teste', cpf: '11144477735' },
        { ...base, id: 'c1', tipo: 'pj', status: 'pendente', nome: 'Ciclano de Teste', cpf: '22255588846', dados: { 'nome-empresa': 'Empresa <b>de Teste</b>', cnpj: '11.222.333/0001-81' } },
        { ...base, id: 'c2', tipo: 'pj', status: 'aprovado', nome: 'Outro de Teste', cpf: '33366699957', dados: { 'nome-empresa': 'Empresa de Teste', cnpj: '11222333000181' } },
        // Mesmo CPF de motorista num PF e numa PJ: o CPF vale em qualquer tipo
        { ...base, id: 'd1', tipo: 'pj', status: 'pendente', nome: 'Beltrano de Teste', cpf: '11144477735', dados: { cnpj: '99.888.777/0001-66' } },
        // Mesmo CPF de motorista (a1/a2) numa PJ que divide o CNPJ com c1/c2: só o CPF conta
        { ...base, id: 'e1', tipo: 'pj', status: 'pendente', nome: 'Fulano de Teste', cpf: '52316915930', dados: { cnpj: '11222333000181' } }
      ];
      cadastros = lista; // eslint-disable-line no-undef
      renderTabela(); // eslint-disable-line no-undef
      const linhas = () => Array.from(document.querySelectorAll('#driver-table-body tr')).map((tr) => {
        const id = tr.querySelector('[data-acao="abrir"]')?.getAttribute('data-id');
        return `${id}:${Array.from(tr.querySelectorAll('.selo-repetido')).map((s) => s.textContent).join('+') || '-'}`;
      });
      const todos = linhas();
      document.getElementById('btn-tab-repetidos').click();
      const filtrados = linhas();
      const botao = document.getElementById('btn-tab-repetidos').textContent;
      const selosNoHtml = document.querySelectorAll('.selo-repetido').length;
      const semTagInjetada = !document.querySelector('#driver-table-body b');
      return { todos, filtrados, botao, selosNoHtml, semTagInjetada, cadastrosIntactos: JSON.stringify(cadastros) === JSON.stringify(lista) }; // eslint-disable-line no-undef
    });
    confere(JSON.stringify(d.filtrados.sort()) === JSON.stringify(['a1:CPF repetido', 'a2:CPF repetido', 'b1:CPF repetido', 'd1:CPF repetido', 'e1:CPF repetido']),
      `${largura}: filtro Só repetidos errado: ${d.filtrados}`);
    confere(d.todos.length === 9 && d.todos.filter((t) => !t.endsWith(':-')).length === 5 && !d.todos.some((t) => /CNPJ/.test(t)), `${largura}: selos errados: ${d.todos}`);
    confere(d.botao === 'Só repetidos (5)', `${largura}: botão ${d.botao}`);
    confere(d.semTagInjetada && d.cadastrosIntactos, `${largura}: HTML injetado ou cadastros mudaram`);
    d.semRolagemLateral = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    confere(d.semRolagemLateral, `${largura}: página com rolagem lateral`);
    const tabela = await page.$('#tab-filter-container');
    await tabela.evaluate((e) => e.closest('div[style*="border-radius: 16px"]').scrollIntoView());
    await espera(200);
    await (await page.$('#tab-filter-container')).evaluate(() => 0);
    await page.screenshot({ path: path.join(CAP, `cadastro_unico_dashboard_${largura}.png`) });
  }

  r.errosNaPagina = erros;
  confere(!erros.length, `erros na página: ${erros.join(' | ')}`);
  console.log(JSON.stringify(r, null, 2));
  console.log(ok ? 'OK' : 'FALHOU');
  await browser.close(); srv.close();
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
