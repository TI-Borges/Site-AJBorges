// Anotações no Dashboard do Cadastro (passo 26) e botão "Avisar no WhatsApp", em 1366 e 390 px:
//  - o Apto / Inapto (passo 25b) sumiu da tela (selos, filtro "Avaliação", bloco nos detalhes);
//  - Anotações: salvar, editar, apagar, contador de 2000, XSS como texto, quebras de linha preservadas,
//    "Última anotação por … em …", ícone 📝 na lista (com o começo do texto no title), filtro "Com anotação",
//    busca no texto das anotações e "Anotação antiga: …" (avaliacao_motivo, só leitura);
//  - WhatsApp: só "aprovado"; wa.me/55 + dígitos (sem duplicar o 55); mensagem codificada; celular inválido
//    desativado; target _blank e rel noopener noreferrer; não grava nada (nenhuma RPC/update).
// Nada vai para o Supabase (RPC e Storage simulados). Só dados inventados (nomes "de Teste").
// Uso: node testes/t_cadastro_anotacoes_telas.js   -> prints em testes/capturas/cadastro_anotacoes_*.png
const fs = require('fs');
const path = require('path');
const { abrir } = require('./harness');
const espera = (ms) => new Promise((res) => setTimeout(res, ms));
const RAIZ = process.env.RAIZ || path.resolve(__dirname, '..');
const CAP = path.join(__dirname, 'capturas');
fs.mkdirSync(CAP, { recursive: true });

const PERIGOSO = '<img src=x onerror="window.__xss=1">Ligar <b>amanhã</b>';
const MSG = 'Olá, Beltrano! Aqui é da AJBorges Transportes. Seu cadastro foi aprovado. ✅';

(async () => {
  const { srv, base, browser, page, erros } = await abrir({});
  const r = { estatico: {}, telas: {} };
  let ok = true;
  const confere = (cond, msg) => { if (!cond) { ok = false; console.log('FALHOU:', msg); } };

  // A ficha e a edge function não mencionam anotações nem WhatsApp do cadastro
  for (const arq of ['HTML/FichaMultiCadastro.html', 'JavaScript/FichaMultiCadastro.js', 'supabase/functions/solicitar-cadastro/index.ts']) {
    r.estatico[arq] = /anota[cç]/i.test(fs.readFileSync(path.join(RAIZ, arq), 'utf8'));
    confere(!r.estatico[arq], `${arq} menciona anotações`);
  }

  for (const largura of [1366, 390]) {
    await page.setViewport({ width: largura, height: 900 });
    await page.goto(`${base}/HTML/Dashboard-cadastro-motorista.html`, { waitUntil: 'load' });
    await page.evaluate(() => localStorage.setItem('teste_usuario', JSON.stringify({ role: 'admin', nome: 'Admin Teste', id: 'a1' })));
    await page.goto(`${base}/HTML/Dashboard-cadastro-motorista.html`, { waitUntil: 'load' });
    const t = r.telas[largura] = {};

    t.lista = await page.evaluate(async (perigoso) => {
      const base = { criado_em: '2026-10-27T12:00:00Z', etapas: {}, documentos: [], dados: {}, tipo: 'pf' };
      const lista = [
        { ...base, id: 'k1', status: 'pendente', nome: 'Fulano de Teste', cpf: '52316915930', celular: '11900000000',
          anotacoes: 'Pediu para ligar depois das 18h.\nCombinou mandar o CRLV.', anotado_por: 'gestao@teste.local', anotado_em: '2026-11-01T10:00:00Z',
          avaliacao: 'apto', avaliacao_motivo: 'Conferido na GR' },
        { ...base, id: 'k2', status: 'aprovado', nome: 'Beltrano de Teste', cpf: '11144477735', celular: '(14) 99858-0000', anotacoes: perigoso, anotado_por: 'gestao@teste.local', anotado_em: '2026-11-02T10:00:00Z' },
        { ...base, id: 'k3', status: 'aprovado', nome: 'Ciclano de Teste', cpf: '22255588846', celular: '+55 (11) 91234-5678', avaliacao: 'inapto', avaliado_por: 'gestao@teste.local' },
        { ...base, id: 'k4', status: 'aprovado', nome: 'Sicrano de Teste', cpf: '33366699957', celular: '1234-567' },
        { ...base, id: 'k5', status: 'analise', nome: 'Deltrano de Teste', cpf: '44477711122', celular: '11988887777' }
      ];
      window.__rpc = [];
      window.__updates = 0;
      window.supabaseClient = {
        rpc: async (nome, args) => {
          window.__rpc.push({ nome, args });
          if (nome === 'anotar_cadastro') {
            const texto = String(args.p_texto || '').replace(/^[\s]+|[\s]+$/g, '') || null;
            return { data: { id: args.p_id, anotacoes: texto, anotado_por: 'admin@teste.local', anotado_em: '2026-11-05T15:30:00Z' }, error: null };
          }
          return { data: null, error: null };
        },
        from: () => ({ update: () => { window.__updates++; return { eq: async () => ({ error: null }) }; } }),
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
        const icone = tr.querySelector('.icone-anotacao');
        return `${id}:${icone ? '📝' : '-'}`;
      });
      const chk = document.getElementById('filtro-com-anotacao');
      const buscar = (txt) => { const b = document.getElementById('driver-search-input'); b.value = txt; b.dispatchEvent(new Event('input', { bubbles: true })); return linhas(); };
      const res = { todos: linhas() };
      chk.checked = true; chk.dispatchEvent(new Event('change', { bubbles: true }));
      res.comAnotacao = linhas();
      chk.checked = false; chk.dispatchEvent(new Event('change', { bubbles: true }));
      res.buscaNaAnotacao = buscar('crlv');
      res.buscaNaAnotacaoAntiga = buscar('conferido na gr');
      buscar('');
      res.tituloIcone = document.querySelector('#driver-table-body [data-id="k1"]').closest('tr').querySelector('.icone-anotacao').getAttribute('title');
      res.tituloPerigoso = document.querySelector('#driver-table-body [data-id="k2"]').closest('tr').querySelector('.icone-anotacao').getAttribute('title');
      res.semHtmlInjetado = !document.querySelector('#driver-table-body img') && !window.__xss;
      // O Apto / Inapto sumiu da lista e do filtro
      res.avaliacaoNaLista = !!document.querySelector('.selo-avaliacao, #filtro-avaliacao') || /\b(Apto|Inapto)\b/.test(document.getElementById('driver-table-body').innerText);
      return res;
    }, PERIGOSO);
    confere(JSON.stringify(t.lista.todos) === JSON.stringify(['k1:📝', 'k2:📝', 'k3:-', 'k4:-', 'k5:-']), `${largura}: ícone 📝 ${t.lista.todos}`);
    confere(JSON.stringify(t.lista.comAnotacao) === '["k1:📝","k2:📝"]', `${largura}: filtro "Com anotação" ${t.lista.comAnotacao}`);
    confere(JSON.stringify(t.lista.buscaNaAnotacao) === '["k1:📝"]' && JSON.stringify(t.lista.buscaNaAnotacaoAntiga) === '["k1:📝"]', `${largura}: busca nas anotações ${t.lista.buscaNaAnotacao} / ${t.lista.buscaNaAnotacaoAntiga}`);
    confere(t.lista.tituloIcone === 'Pediu para ligar depois das 18h.\nCombinou mandar o CRLV.' && t.lista.tituloPerigoso === PERIGOSO && t.lista.semHtmlInjetado, `${largura}: title do ícone / XSS na lista`);
    confere(!t.lista.avaliacaoNaLista, `${largura}: Apto/Inapto ainda aparece na lista`);
    await page.screenshot({ path: path.join(CAP, `cadastro_anotacoes_lista_${largura}.png`) });

    // Detalhes: bloco "Anotações", anotação antiga só leitura, XSS e quebras de linha; sem Apto/Inapto
    t.detalhes = await page.evaluate(async () => {
      await abrirModal('k1'); // eslint-disable-line no-undef
      await new Promise((res) => setTimeout(res, 100));
      const corpo = document.getElementById('modal-body-content');
      const caixa = corpo.querySelector('#anotacao-texto');
      const antiga = corpo.querySelector('#anotacao-antiga');
      const k1 = {
        legenda: corpo.querySelector('#secao-anotacoes legend').textContent,
        texto: caixa.value, maxlength: caixa.getAttribute('maxlength'), altura: caixa.getBoundingClientRect().height,
        contador: corpo.querySelector('#anotacao-contador').textContent,
        ultima: corpo.querySelector('#anotacao-ultima').innerText,
        antiga: antiga ? antiga.textContent : '(sem)', antigaEditavel: !!(antiga && antiga.querySelector('textarea, input')),
        avaliacao: !!corpo.querySelector('#secao-avaliacao, .selo-avaliacao, input[name="avaliacao"]') || /\b(Apto|Inapto)\b|Avaliação/.test(corpo.innerText),
        whatsapp: !!document.querySelector('#modal-footer-actions .btn-whatsapp')
      };
      await abrirModal('k2'); // eslint-disable-line no-undef
      await new Promise((res) => setTimeout(res, 100));
      const c2 = document.getElementById('modal-body-content');
      const k2 = { texto: c2.querySelector('#anotacao-texto').value, semHtmlInjetado: !c2.querySelector('img') && !window.__xss, antiga: !!c2.querySelector('#anotacao-antiga') };
      return { k1, k2 };
    });
    const d = t.detalhes;
    confere(d.k1.legenda === 'Anotações' && d.k1.texto === 'Pediu para ligar depois das 18h.\nCombinou mandar o CRLV.' && d.k1.maxlength === '2000' && d.k1.altura >= 150, `${largura}: bloco Anotações ${JSON.stringify(d.k1)}`);
    confere(d.k1.contador === '56/2000' && /Última anotação por gestao@teste\.local em \d{2}\/\d{2}\/\d{4}/.test(d.k1.ultima), `${largura}: contador/última ${d.k1.contador} ${d.k1.ultima}`);
    confere(d.k1.antiga === 'Anotação antiga: Conferido na GR' && !d.k1.antigaEditavel, `${largura}: anotação antiga ${d.k1.antiga}`);
    confere(!d.k1.avaliacao, `${largura}: Apto/Inapto ainda aparece nos detalhes`);
    confere(!d.k1.whatsapp, `${largura}: WhatsApp num cadastro pendente`);
    confere(d.k2.texto === PERIGOSO && d.k2.semHtmlInjetado && !d.k2.antiga, `${largura}: XSS nos detalhes`);

    // Salvar, editar e apagar (RPC anotar_cadastro); o status não muda
    t.salvar = await page.evaluate(async () => {
      await abrirModal('k5'); // eslint-disable-line no-undef
      await new Promise((res) => setTimeout(res, 100));
      const caixa = () => document.getElementById('anotacao-texto');
      const salvar = async (txt) => {
        caixa().value = txt;
        caixa().dispatchEvent(new Event('input', { bubbles: true }));
        const contador = document.getElementById('anotacao-contador').textContent;
        document.querySelector('#modal-body-content [data-acao="salvar-anotacao"]').click();
        await new Promise((res) => setTimeout(res, 250));
        const c = cadastros.find((x) => x.id === 'k5'); // eslint-disable-line no-undef
        const tr = Array.from(document.querySelectorAll('#driver-table-body tr')).find((l) => l.querySelector('[data-id="k5"]'));
        return { contador, rpc: window.__rpc[window.__rpc.length - 1], anotacoes: c.anotacoes, status: c.status,
          caixa: caixa().value, ultima: document.getElementById('anotacao-ultima').innerText, icone: !!tr.querySelector('.icone-anotacao') };
      };
      const antes = { ultima: document.getElementById('anotacao-ultima').innerText, contador: document.getElementById('anotacao-contador').textContent };
      const nova = await salvar('Primeira linha\nSegunda <i>linha</i>');
      const editada = await salvar('Texto editado');
      const apagada = await salvar('   ');
      // Contador no limite (o campo não passa de 2000)
      caixa().value = 'x'.repeat(2000);
      caixa().dispatchEvent(new Event('input', { bubbles: true }));
      const limite = { contador: document.getElementById('anotacao-contador').textContent, vermelho: document.getElementById('anotacao-contador').classList.contains('no-limite') };
      return { antes, nova, editada, apagada, limite, outrasRpc: window.__rpc.filter((x) => x.nome !== 'anotar_cadastro').map((x) => x.nome) };
    });
    const s = t.salvar;
    confere(s.antes.ultima === 'Ainda sem anotação.' && s.antes.contador === '0/2000', `${largura}: estado inicial ${JSON.stringify(s.antes)}`);
    confere(s.nova.rpc.args.p_id === 'k5' && s.nova.rpc.args.p_texto === 'Primeira linha\nSegunda <i>linha</i>' && s.nova.anotacoes === 'Primeira linha\nSegunda <i>linha</i>' &&
      s.nova.caixa === s.nova.anotacoes && s.nova.status === 'analise' && s.nova.icone && /admin@teste\.local/.test(s.nova.ultima) && s.nova.contador === '35/2000', `${largura}: salvar ${JSON.stringify(s.nova)}`);
    confere(s.editada.anotacoes === 'Texto editado' && s.editada.icone, `${largura}: editar ${JSON.stringify(s.editada)}`);
    confere(s.apagada.anotacoes === null && !s.apagada.icone && s.apagada.caixa === '' && s.apagada.status === 'analise', `${largura}: apagar ${JSON.stringify(s.apagada)}`);
    confere(s.limite.contador === '2000/2000' && s.limite.vermelho, `${largura}: contador no limite`);
    confere(!s.outrasRpc.length, `${largura}: outras RPCs ${s.outrasRpc}`);

    // WhatsApp: só aprovado; número com e sem 55; inválido desativado; não grava nada
    t.whats = await page.evaluate(async () => {
      const botao = async (id) => {
        await abrirModal(id); // eslint-disable-line no-undef
        await new Promise((res) => setTimeout(res, 80));
        const b = document.querySelector('#modal-footer-actions .btn-whatsapp');
        if (!b) return null;
        return { tag: b.tagName, href: b.getAttribute('href'), target: b.getAttribute('target'), rel: b.getAttribute('rel'), disabled: b.disabled === true, texto: b.textContent.trim(), title: b.getAttribute('title') };
      };
      const rpcAntes = window.__rpc.length;
      const res = { k2: await botao('k2'), k3: await botao('k3'), k4: await botao('k4'), k5: await botao('k5') };
      res.gravouAlgo = window.__rpc.length !== rpcAntes || window.__updates !== 0;
      return res;
    });
    const w = t.whats;
    const esperado2 = `https://wa.me/5514998580000?text=${encodeURIComponent(MSG)}`;
    confere(w.k2 && w.k2.tag === 'A' && w.k2.href === esperado2 && w.k2.target === '_blank' && w.k2.rel === 'noopener noreferrer' && w.k2.texto === 'Avisar no WhatsApp', `${largura}: WhatsApp sem 55 ${JSON.stringify(w.k2)}`);
    confere(w.k3 && w.k3.href.startsWith('https://wa.me/5511912345678?text=') && decodeURIComponent(w.k3.href.split('text=')[1]) === 'Olá, Ciclano! Aqui é da AJBorges Transportes. Seu cadastro foi aprovado. ✅', `${largura}: WhatsApp com 55 (não duplica) ${w.k3 && w.k3.href}`);
    confere(w.k4 && w.k4.tag === 'BUTTON' && w.k4.disabled && /Celular inválido/.test(w.k4.texto) && !w.k4.href, `${largura}: celular inválido ${JSON.stringify(w.k4)}`);
    confere(w.k5 === null, `${largura}: WhatsApp num cadastro em análise`);
    confere(!w.gravouAlgo, `${largura}: o WhatsApp gravou algo`);

    // Print dos detalhes do aprovado com anotação e o botão do WhatsApp
    await page.evaluate(async () => { document.getElementById('admin-toast')?.classList.remove('show'); await abrirModal('k2'); document.getElementById('secao-anotacoes').scrollIntoView({ block: 'start' }); }); // eslint-disable-line no-undef
    await espera(250);
    await page.screenshot({ path: path.join(CAP, `cadastro_anotacoes_modal_${largura}.png`) });
    await page.evaluate(() => { const b = document.querySelector('#modal-footer-actions .btn-whatsapp'); b && b.scrollIntoView({ block: 'end' }); });
    await espera(150);
    await page.screenshot({ path: path.join(CAP, `cadastro_whatsapp_${largura}.png`) });
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
