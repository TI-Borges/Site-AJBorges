// Viagem em andamento (passo 17): rascunho no banco + cópia no celular por motorista, salvamento
// automático (3 s, troca de aba, sem internet), card "Viagem em andamento", fotos (redução, ⏳/✓/⚠️,
// sem sinal, remover, aviso em 360 px), lixeira, envio na mesma ficha (data_envio = agora, sino) e a
// aba "Em andamento" da gestão.
// O Supabase é falso (localStorage '__banco_falso', sobrevive às recargas) e imita o que o passo 17
// faz no banco: id RASC-... no rascunho, 1 rascunho por motorista, RLS por motorista, motorista só
// altera rascunho, regras do envio só em 'pendente', número e data_envio no envio, Storage com
// apagar só do próprio rascunho. '__sem_rede' = 1 faz o banco falhar sem tirar a rede da página.
const { abrir } = require('./harness');

const A = { role: 'motorista', nome: 'Motorista A', id: 'aaaaaaaa-0000-0000-0000-00000000000a', cpf: '11122233344' };
const B = { role: 'motorista', nome: 'Motorista B', id: 'bbbbbbbb-0000-0000-0000-00000000000b', cpf: '55566677788' };
const C = { role: 'motorista', nome: 'Motorista C', id: 'cccccccc-0000-0000-0000-00000000000c', cpf: '99900011122' };
const GESTAO = { role: 'admin', nome: 'Gestão Teste', id: 'dddddddd-0000-0000-0000-00000000000d', email: 'g@x' };

function supabaseFalso() {
  const CHAVE = '__banco_falso';
  const ler = () => { try { return JSON.parse(localStorage.getItem(CHAVE)) || null; } catch (e) { return null; } };
  const banco = () => ler() || { fichas: [], arquivos: {}, seq: 0, log: [] };
  const gravar = (b) => localStorage.setItem(CHAVE, JSON.stringify(b));
  const usuario = () => { try { return JSON.parse(localStorage.getItem('teste_usuario')) || {}; } catch (e) { return {}; } };
  const semRede = () => !navigator.onLine || localStorage.getItem('__sem_rede') === '1';
  const falhaRede = { data: null, error: { message: 'TypeError: Failed to fetch' } };
  const erroRegra = (message) => ({ data: null, error: { code: 'P0001', message } });
  const ehAdmin = () => ['admin', 'diretoria'].includes(usuario().role);
  const agora = () => new Date().toISOString();
  const placaOk = (p) => /^[A-Z]{3}[0-9][A-Z0-9][0-9]{2}$/.test(String(p || '').toUpperCase().replace(/[^A-Z0-9]/g, ''));
  const iso = (v) => (v === null || v === undefined || v === '' ? null : v);
  const km = (v) => { const d = String(v ?? '').replace(/\D/g, ''); return d ? Number(d) : null; };

  // O que o trigger faz com a linha do motorista (só o que a tela usa)
  function aplicarTrigger(linha, valor) {
    for (const c of ['data_saida', 'data_chegada']) {
      const v = iso(valor[c]);
      if (v !== null && !/^\d{4}-\d{2}-\d{2}$/.test(v)) return { error: { code: '22007', message: `invalid input syntax for type date: "${v}"` } };
      linha[c] = v;
    }
    const dc = valor.dados_completos || {};
    Object.assign(linha, {
      placas: placaOk(valor.placas) ? String(valor.placas).toUpperCase().replace(/[^A-Z0-9]/g, '') : null,
      km_saida: km(dc.kmSaida), km_chegada: km(dc.kmEntrada),
      destino_inicial: iso(valor.destino_inicial), destino_final: iso(valor.destino_final),
      valor_adiantamento: valor.valor_adiantamento || 0,
      abastecimentos: valor.abastecimentos || [], comprovantes: valor.comprovantes || [], despesas_extras: valor.despesas_extras || [],
      dados_completos: { ...dc, fretes: dc.fretes || [] },
      atualizado_em: agora()
    });
    return null;
  }

  function validarEnvio(l) {
    if (!l.placas) return 'Informe a placa principal (ex.: ABC-1D23).';
    if (!l.data_saida || !l.data_chegada) return 'Informe a data de saída e a data de chegada.';
    if (l.data_chegada < l.data_saida) return 'A data de chegada não pode ser antes da data de saída.';
    if (l.km_saida === null || l.km_chegada === null) return 'Informe o KM de saída e o KM de chegada.';
    return null;
  }

  class Consulta {
    constructor(tabela) { this.t = tabela; this.op = 'select'; this.filtros = []; this.desc = []; }
    select(cols, opts) { if (this.op === 'select') { this.cols = cols; this.opts = opts || {}; } this.retorna = true; this.desc.push(`select ${cols}`); return this; }
    insert(v) { this.op = 'insert'; this.valor = v; return this; }
    update(v) { this.op = 'update'; this.valor = v; return this; }
    eq(c, v) { this.filtros.push(r => String(r[c]) === String(v)); this.desc.push(`eq ${c} ${v}`); return this; }
    neq(c, v) { this.filtros.push(r => r[c] !== v); return this; }
    gt(c, v) { this.filtros.push(r => r[c] > v); return this; }
    not(c, op, v) { if (op === 'is' && v === null) this.filtros.push(r => r[c] !== null && r[c] !== undefined); return this; }
    order(c, o) { this.ordem = [c, o && o.ascending === false ? -1 : 1]; return this; }
    limit(n) { this.lim = n; return this; }
    maybeSingle() { this.unico = true; return this; }
    then(ok, falhou) { return Promise.resolve().then(() => this.executar()).then(ok, falhou); }
    executar() {
      if (semRede()) return falhaRede;
      if (this.t !== 'fichas_viagem') return { data: this.unico ? null : [], error: null, count: 0 };
      const b = banco();
      const u = usuario();
      const visivel = (r) => ehAdmin() || r.motorista_id === u.id;
      if (this.op === 'insert') {
        const v = this.valor;
        const linha = { ...v, motorista_id: u.id, motorista: u.nome, data_envio: agora(), iniciada_em: agora() };
        if (v.status === 'rascunho') {
          if (b.fichas.some(f => f.motorista_id === u.id && f.status === 'rascunho')) return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "fichas_viagem_um_rascunho_por_motorista"' } };
          linha.id = 'RASC-' + Math.random().toString(16).slice(2) + Date.now().toString(16);
        }
        const erro = aplicarTrigger(linha, v);
        if (erro) return erro;
        if (linha.status === 'pendente') { const m = validarEnvio(linha); if (m) return erroRegra(m); }
        b.fichas.push(linha);
        b.log.push(`insert ${linha.status}`);
        gravar(b);
        return { data: [linha], error: null };
      }
      let linhas = b.fichas.filter(visivel).filter(r => this.filtros.every(f => f(r)));
      if (this.op === 'update') {
        // RLS de update do motorista (passo 17): só o próprio rascunho
        if (!ehAdmin()) linhas = linhas.filter(r => r.status === 'rascunho' && r.motorista_id === u.id);
        const saida = [];
        for (const r of linhas) {
          const novo = { ...r };
          if (ehAdmin()) { Object.assign(novo, this.valor); } else {
            if (r.status !== 'rascunho') return erroRegra('Acesso negado: esta ficha já foi enviada e não pode ser alterada.');
            novo.status = this.valor.status;
            const erro = aplicarTrigger(novo, this.valor);
            if (erro) return erro;
            if (novo.status === 'pendente') {
              const m = validarEnvio(novo);
              if (m) return erroRegra(m);
              b.seq += 1;
              novo.id = `AJB-2026-${String(b.seq).padStart(3, '0')}`;
              novo.data_envio = agora();
            }
          }
          Object.keys(r).forEach(k => delete r[k]);
          Object.assign(r, novo);
          saida.push(r);
        }
        b.log.push(`update ${saida.map(s => s.status).join(',') || '(0 linhas)'}`);
        gravar(b);
        return { data: saida, error: null };
      }
      if (this.ordem) { const [c, s] = this.ordem; linhas.sort((x, y) => (x[c] > y[c] ? s : x[c] < y[c] ? -s : 0)); }
      const total = linhas.length;
      if (this.lim) linhas = linhas.slice(0, this.lim);
      if (this.unico) return { data: linhas[0] || null, error: null };
      return { data: linhas, error: null, count: total };
    }
  }

  // Storage: pasta <usuário>/<ficha>/; apagar só do próprio rascunho (policy do passo 17)
  const storage = {
    from: () => ({
      async upload(caminho, file) {
        const atraso = Number(localStorage.getItem('__atraso_upload') || 0);
        if (atraso) await new Promise(r => setTimeout(r, atraso));
        if (semRede()) return falhaRede;
        let dims = '';
        try { const img = await createImageBitmap(file); dims = `${img.width}x${img.height}`; } catch (e) { dims = '(não é imagem)'; }
        const b = banco();
        if (!caminho.startsWith(usuario().id + '/')) return { error: { message: 'new row violates row-level security policy' } };
        b.arquivos[caminho] = { size: file.size, type: file.type, dims };
        gravar(b);
        return { data: { path: caminho }, error: null };
      },
      async remove(caminhos) {
        if (semRede()) return falhaRede;
        const b = banco();
        const u = usuario();
        const apagados = caminhos.filter(c => {
          const [dono, ficha] = c.split('/');
          return b.arquivos[c] && dono === u.id && b.fichas.some(f => f.id === ficha && f.motorista_id === u.id && f.status === 'rascunho');
        });
        apagados.forEach(c => delete b.arquivos[c]);
        gravar(b);
        return { data: apagados.map(name => ({ name })), error: null };
      },
      async list(pasta) {
        if (semRede()) return falhaRede;
        return { data: Object.keys(banco().arquivos).filter(c => c.startsWith(pasta + '/')).map(c => ({ name: c.slice(pasta.length + 1) })), error: null };
      },
      async createSignedUrl(caminho) {
        if (semRede()) return falhaRede;
        // 1x1 PNG no lugar do link assinado
        return { data: { signedUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==#' + encodeURIComponent(caminho) }, error: null };
      }
    })
  };

  const canal = { on() { return canal; }, subscribe() { return canal; } };
  const cliente = {
    from: (t) => new Consulta(t),
    rpc: async (nome) => {
      if (semRede()) return falhaRede;
      if (nome === 'veiculo_do_motorista') return { data: [{ tipo_veiculo: 'carreta', comissao_alim_carreta: null, comissao_alim_rodotrem: null }], error: null };
      if (nome === 'reservar_numero_ficha') { const b = banco(); b.seq += 1; gravar(b); return { data: `AJB-2026-${String(b.seq).padStart(3, '0')}`, error: null }; }
      return { data: [], error: null };
    },
    storage,
    channel: () => canal,
    auth: {
      getUser: async () => ({ data: { user: { id: usuario().id, email: usuario().email || '' } }, error: null }),
      getSession: async () => ({ data: { session: null } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      signOut: async () => ({ error: null })
    }
  };
  window.supabase = { createClient: () => cliente };
  // Chart.js (CDN) não carrega no teste: sem ele o dashboard pararia antes de ligar as abas
  const grafico = new Proxy(function () {}, { get: (t, k) => (k === Symbol.toPrimitive ? () => 0 : grafico), apply: () => grafico, construct: () => grafico, set: () => true });
  window.Chart = grafico;
  // O ajbAoAutenticar de teste chama a página na hora; o de verdade espera o DOM e o servidor
  // (o dashboard tem const declarada depois da chamada)
  let aoAutenticar = null;
  Object.defineProperty(window, 'ajbAoAutenticar', {
    configurable: true,
    get: () => aoAutenticar,
    set: (fn) => { aoAutenticar = (...args) => setTimeout(() => fn(...args), 0); }
  });
}

(async () => {
  const { srv, base, browser, page, erros } = await abrir({ largura: 1280 });
  await page.evaluateOnNewDocument(supabaseFalso);
  const espera = (ms) => new Promise(r => setTimeout(r, ms));
  const FICHA = `${base}/HTML/relatorio-viagem.html?novo=true`;
  const r = {};

  const entrar = async (u) => {
    await page.goto(`${base}/HTML/Login.html`, { waitUntil: 'domcontentloaded' });
    await page.evaluate((u) => localStorage.setItem('teste_usuario', JSON.stringify(u)), u);
    await page.goto(FICHA, { waitUntil: 'load' });
    await espera(700);
  };
  const digitar = async (sel, txt) => { await page.focus(sel); await page.keyboard.type(txt); };
  const mudar = (sel, v) => page.$eval(sel, (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }, v);
  const bancoFalso = () => page.evaluate(() => JSON.parse(localStorage.getItem('__banco_falso') || '{"fichas":[],"arquivos":{},"seq":0,"log":[]}'));
  const rascunhoDe = async (u) => (await bancoFalso()).fichas.find(f => f.motorista_id === u.id && f.status === 'rascunho') || null;
  const copiaDe = (u) => page.evaluate((id) => JSON.parse(localStorage.getItem(`ajborges_rascunho_viagem_${id}`) || 'null'), u.id);
  const tela = () => page.evaluate(() => ({
    card: document.getElementById('card-viagem-andamento').hidden ? '(escondido)' : document.getElementById('card-viagem-andamento').innerText.replace(/\s+/g, ' ').trim(),
    indicador: document.getElementById('estado-salvamento-rascunho').hidden ? '(escondido)' : document.getElementById('estado-salvamento-rascunho').textContent,
    kmSaida: document.getElementById('km-saida').value,
    kmChegada: document.getElementById('km-chegada').value,
    dataSaida: document.getElementById('data-saida').value,
    destinoInicial: document.getElementById('destino-inicial').value,
    adiantamento: document.getElementById('valor-adiantamento').value,
    abast1: ['posto_ml_1', 'combustivel_ml_1', 'valor_ml_1', 'litros_ml_1'].map(n => document.querySelector(`[name="${n}"]`).value).join(' | '),
    despesa2: `${document.getElementById('ml-despesa-desc-2').value} ${document.getElementById('ml-despesa-valor-2').value}`.trim(),
    vermelhos: document.querySelectorAll('[aria-invalid="true"], .erro-campo-celular').length,
    anexos: Array.from(document.querySelectorAll('#lista-anexos-preview-ml .item-anexo-card')).map(c =>
      `${c.querySelector('.item-anexo-nome').textContent} [${c.querySelector('.item-anexo-estado')?.textContent || '-'}]${c.querySelector('img') ? ' (miniatura)' : ''}`)
  }));
  const resumoLinha = (l) => l && ({
    id: l.id.replace(/^RASC-.*/, 'RASC-…'), status: l.status, km_saida: l.km_saida, km_chegada: l.km_chegada, data_saida: l.data_saida,
    destino_inicial: l.destino_inicial, valor_adiantamento: l.valor_adiantamento,
    abastecimentos: (l.abastecimentos || []).length, despesa2: (l.despesas_extras || [])[1] ? `${l.despesas_extras[1].desc} ${l.despesas_extras[1].valor}`.trim() : '',
    comprovantes: (l.comprovantes || []).length
  });

  await page.goto(`${base}/HTML/Login.html`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());

  // 0. Chave antiga (igual para todos do aparelho) é migrada uma vez para o motorista logado e apagada
  await page.evaluate(() => localStorage.setItem('ajborges_relatorio_viagem_ml_draft', JSON.stringify({ cabecalho: { kmSaida: '55.555' }, anexos: [{ name: 'x.jpg', size: 1 }] })));
  await page.goto(`${base}/HTML/Login.html`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((u) => localStorage.setItem('teste_usuario', JSON.stringify(u)), C);
  await page.goto(FICHA, { waitUntil: 'load' });
  await espera(1500);
  r.migracaoChaveAntiga = {
    tela: (await tela()).kmSaida,
    chaveAntigaApagada: await page.evaluate(() => localStorage.getItem('ajborges_relatorio_viagem_ml_draft') === null),
    banco: resumoLinha(await rascunhoDe(C)),
    copiaDoCelularApagada: (await copiaDe(C)) === null
  };

  // 1. Só KM e data de saída -> 3 s -> banco; sair e entrar -> card com os dados
  await entrar(A);
  r.portalSemRascunho = (await tela()).card;
  await digitar('#km-saida', '100000');
  await digitar('#data-saida', '01102026');
  await espera(1200);
  r.antesDos3s = resumoLinha(await rascunhoDe(A)) || '(ainda não gravou)';
  await espera(2800);
  r.depoisDos3s = { banco: resumoLinha(await rascunhoDe(A)), tela: await tela() };
  await entrar(A);
  r.voltouAoPortal = await tela();

  // 2. Outro dia: um abastecimento e uma despesa -> acumulam
  await page.select('[name="posto_ml_1"]', 'Marília - Posto Esmeralda');
  await page.select('[name="combustivel_ml_1"]', 'diesel_s10');
  await digitar('[name="valor_ml_1"]', '60000');
  await digitar('[name="litros_ml_1"]', '2000000'); // 2.000 L: aviso de litros, mas salva
  await page.select('#ml-despesa-desc-2', 'Borracharia');
  await digitar('#ml-despesa-valor-2', '15000');
  await espera(3800);
  r.avisoLitros = await page.evaluate(() => document.querySelector('[name="litros_ml_1"]').closest('td').innerText.includes('Confira') || !!document.querySelector('.aviso-litros-linha, .litros-fora-limite, [data-litros-alerta]'));
  await entrar(A);
  r.outroDia = { banco: resumoLinha(await rascunhoDe(A)), tela: await tela() };

  // 3. Troca de aba: grava na hora (antes dos 3 s)
  const logAntes = (await bancoFalso()).log.length;
  await digitar('#km-chegada', '101500');
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  });
  await espera(600);
  r.trocaDeAba = { gravacoes: (await bancoFalso()).log.length - logAntes, km_chegada: (await rascunhoDe(A)).km_chegada };

  // 4. Sem internet: salvo só no celular; o sinal volta -> banco
  await page.setOfflineMode(true);
  await mudar('#destino-inicial', 'Marília - SP');
  await espera(3600);
  r.semInternet = { indicador: (await tela()).indicador, copiaNoCelular: !!(await copiaDe(A)), bancoDestino: (await rascunhoDe(A)).destino_inicial };
  await page.setOfflineMode(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await espera(1200);
  r.sinalVoltou = { indicador: (await tela()).indicador, copiaNoCelular: !!(await copiaDe(A)), bancoDestino: (await rascunhoDe(A)).destino_inicial };

  // 5. Fechar sem internet (o banco falha) e abrir de novo com sinal: volta da cópia do celular
  await page.evaluate(() => localStorage.setItem('__sem_rede', '1'));
  await digitar('#valor-adiantamento', '50000');
  await espera(3600);
  r.fechouSemInternet = { indicador: (await tela()).indicador, copia: (await copiaDe(A))?.dados?.cabecalho?.valorAdiantamento, banco: (await rascunhoDe(A)).valor_adiantamento };

  // 6. Outro motorista no mesmo navegador (a cópia de A continua no aparelho): não vê nada de A
  await page.evaluate(() => localStorage.removeItem('__sem_rede'));
  await entrar(B);
  r.motoristaB = { tela: await tela(), copiaDeAContinua: !!(await copiaDe(A)), rascunhoDeBNoBanco: !!(await rascunhoDe(B)),
    bLeRascunhoDeA: await page.evaluate(async () => (await window.supabaseClient.from('fichas_viagem').select('*').eq('status', 'rascunho')).data.length) };
  await mudar('#destino-inicial', 'Santos - SP');
  await digitar('#data-saida', '20102026');
  await espera(3600);
  r.motoristaBGravou = resumoLinha(await rascunhoDe(B));

  await entrar(A);
  await espera(800);
  r.abriuDeNovoComSinal = { tela: await tela(), banco: resumoLinha(await rascunhoDe(A)), copiaApagada: (await copiaDe(A)) === null };

  // Fotos
  const anexar = (tipo, largura, altura, qualidade, nome) => page.evaluate(async (tipo, largura, altura, qualidade, nome) => {
    const c = document.createElement('canvas');
    c.width = largura; c.height = altura;
    const ctx = c.getContext('2d');
    const g = ctx.createLinearGradient(0, 0, largura, altura);
    g.addColorStop(0, '#f8f4e8'); g.addColorStop(1, '#c9d6e8');
    ctx.fillStyle = g; ctx.fillRect(0, 0, largura, altura);
    // "Nota fiscal": texto e linhas, com ruído leve de foto
    ctx.fillStyle = '#222';
    for (let i = 0; i < 40; i++) { ctx.font = `${Math.round(altura / 45)}px sans-serif`; ctx.fillText(`POSTO ESMERALDA  DIESEL S10  ${i + 1}  R$ 6,${String(i).padStart(2, '0')}`, largura * 0.08, altura * (0.06 + i * 0.022)); }
    const img = ctx.getImageData(0, 0, largura, altura);
    for (let i = 0; i < img.data.length; i += 4) { const n = (Math.random() - 0.5) * 40; img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n; }
    ctx.putImageData(img, 0, 0);
    const blob = await new Promise(res => c.toBlob(res, tipo, qualidade));
    const file = new File([blob], nome, { type: tipo });
    const dt = new DataTransfer();
    dt.items.add(file);
    const input = document.getElementById('input-arquivos-despesas-ml');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return file.size;
  }, tipo, largura, altura, qualidade, nome);

  await page.evaluate(() => localStorage.setItem('__atraso_upload', '900'));
  const tamanhoPequena = await anexar('image/png', 900, 700, undefined, 'nota-posto.png');
  await espera(450);
  r.fotoEnviando = (await tela()).anexos;
  await espera(1800);
  r.fotoSalva = { tela: (await tela()).anexos, tamanhoOriginal: tamanhoPequena };
  await espera(3200);
  await entrar(A);
  await espera(600);
  r.fotoDepoisDeRecarregar = { tela: (await tela()).anexos, banco: (await rascunhoDe(A)).comprovantes.map(a => a.name) };

  await page.evaluate(() => localStorage.setItem('__atraso_upload', '0'));
  const tamanhoGrande = await anexar('image/jpeg', 4000, 3000, 0.97, 'foto-cupom-grande.jpg');
  await espera(4000);
  const arquivos = (await bancoFalso()).arquivos;
  const grande = Object.entries(arquivos).find(([c]) => c.includes('foto-cupom-grande'));
  r.fotoGrande = { original: `${(tamanhoGrande / 1024 / 1024).toFixed(1)} MB`, enviada: grande ? `${Math.round(grande[1].size / 1024)} KB, ${grande[1].dims}, ${grande[1].type}` : '(não subiu)', tela: (await tela()).anexos.filter(a => a.includes('grande')) };

  await page.setOfflineMode(true);
  await anexar('image/jpeg', 1200, 900, 0.9, 'sem-sinal.jpg');
  await espera(800);
  r.fotoSemSinal = (await tela()).anexos.filter(a => a.includes('sem-sinal'));
  await page.setOfflineMode(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await espera(2000);
  r.fotoSinalVoltou = (await tela()).anexos.filter(a => a.includes('sem-sinal'));

  // Falha de envio (não é falta de sinal): ⚠️ e tocar tenta de novo
  await page.evaluate(() => {
    const st = window.supabaseClient.storage;
    const original = st.from;
    let vezes = 0;
    st.from = () => { const b = original(); const up = b.upload; b.upload = async (...a) => (vezes++ === 0 ? { error: { message: 'erro 500' } } : up(...a)); return b; };
  });
  await anexar('image/png', 400, 300, undefined, 'falhou-uma-vez.png');
  await espera(1200);
  r.fotoFalhou = (await tela()).anexos.filter(a => a.includes('falhou'));
  await page.evaluate(() => Array.from(document.querySelectorAll('.item-anexo-card.anexo-falhou')).forEach(c => c.click()));
  await espera(1500);
  r.fotoTocouDeNovo = (await tela()).anexos.filter(a => a.includes('falhou'));

  // Remover: o arquivo sai do Storage
  const caminhoRemovido = Object.keys((await bancoFalso()).arquivos).find(c => c.includes('sem-sinal'));
  await page.evaluate(() => {
    const card = Array.from(document.querySelectorAll('#lista-anexos-preview-ml .item-anexo-card')).find(c => c.textContent.includes('sem-sinal'));
    card.querySelector('.btn-remover-anexo').click();
  });
  await espera(3800);
  r.fotoRemovida = { noStorage: caminhoRemovido in (await bancoFalso()).arquivos, noRascunho: (await rascunhoDe(A)).comprovantes.map(a => a.name), tela: (await tela()).anexos.length };

  // Aviso vermelho em 360 px
  await page.setViewport({ width: 360, height: 780 });
  await espera(300);
  r.avisoFotos360 = await page.evaluate(() => {
    const el = document.getElementById('aviso-fotos-rascunho');
    const cs = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return `${el.hidden ? 'ESCONDIDO' : 'visível'} | cor ${cs.color} | ${cs.fontSize} ${cs.fontWeight} | ${Math.round(rect.left)}→${Math.round(rect.right)} px de ${window.innerWidth} | rolagem horizontal: ${document.documentElement.scrollWidth > window.innerWidth ? 'SIM' : 'não'} | texto: ${el.innerText.replace(/\s+/g, ' ').trim()}`;
  });
  r.lixeiraE360 = await page.evaluate(() => {
    const b = document.getElementById('btn-apagar-tudo-rascunho').getBoundingClientRect();
    const s = document.getElementById('btn-salvar-rascunho-ml').getBoundingClientRect();
    return `lixeira ${Math.round(b.width)}x${Math.round(b.height)} dentro da tela: ${b.right <= window.innerWidth}; salvar e continuar ${Math.round(s.width)}px dentro: ${s.right <= window.innerWidth}`;
  });
  await page.setViewport({ width: 1280, height: 900 });

  // "Salvar e continuar depois": grava e volta para o início com o card
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.click('#btn-salvar-rascunho-ml');
  await espera(1500);
  r.salvarEContinuar = { toast: await page.$eval('.toast-mensagem', e => e.textContent), topo: await page.evaluate(() => window.scrollY < 50), card: (await tela()).card };

  // 7. Lixeira: modal -> apagar -> campos vazios, fotos fora do Storage, card some, rascunho vazio no banco
  const idAntesLixeira = (await rascunhoDe(A)).id;
  await page.click('#btn-apagar-tudo-rascunho');
  await espera(300);
  r.modalLixeira = await page.evaluate(() => {
    const m = document.getElementById('modal-apagar-tudo');
    return `${m.classList.contains('ativo') ? 'aberto' : 'FECHADO'}: ${m.innerText.replace(/\s+/g, ' ').trim()}`;
  });
  await page.click('#btn-apagar-tudo-confirmar');
  await espera(1500);
  const depoisLixeira = await rascunhoDe(A);
  r.lixeira = {
    tela: await tela(),
    arquivosDeANoStorage: Object.keys((await bancoFalso()).arquivos).filter(c => c.startsWith(A.id)).length,
    banco: resumoLinha(depoisLixeira), mesmaLinha: depoisLixeira && depoisLixeira.id === idAntesLixeira,
    copia: await copiaDe(A)
  };
  await entrar(A);
  r.lixeiraDepoisDeRecarregar = (await tela()).card;

  // 8. Envio: incompleto bloqueia (validações de hoje); completo vira 'pendente' na mesma ficha
  await digitar('#km-saida', '100000');
  await digitar('#data-saida', '01102026');
  await espera(3600);
  const rasc = await rascunhoDe(A);
  // data_envio do rascunho no passado (o começo da viagem)
  await page.evaluate((id) => { const b = JSON.parse(localStorage.getItem('__banco_falso')); const f = b.fichas.find(x => x.id === id); f.data_envio = new Date(Date.now() - 3 * 864e5).toISOString(); localStorage.setItem('__banco_falso', JSON.stringify(b)); }, rasc.id);
  const antesDoEnvio = new Date().toISOString();
  await page.click('#btn-finalizar-relatorio-ml');
  await espera(500);
  r.envioIncompleto = { toast: await page.$eval('.toast-mensagem', e => e.textContent), vermelhos: (await tela()).vermelhos,
    revisao: await page.$eval('#modal-revisar-envio', m => m.classList.contains('ativo')), status: (await rascunhoDe(A))?.status };
  await digitar('#placas', 'ABC1D23');
  await digitar('#km-chegada', '101500');
  await digitar('#data-chegada', '05102026');
  await mudar('#destino-inicial', 'Marília - SP');
  await digitar('#valor-adiantamento', '0');
  await page.select('[name="posto_ml_1"]', 'Marília - Posto Esmeralda');
  await page.select('[name="combustivel_ml_1"]', 'diesel_s10');
  await digitar('[name="valor_ml_1"]', '60000');
  await digitar('[name="litros_ml_1"]', '100000');
  await page.click('#btn-finalizar-relatorio-ml');
  await espera(500);
  r.revisaoAbriu = await page.$eval('#modal-revisar-envio', m => m.classList.contains('ativo'));
  await page.click('#btn-revisar-confirmar');
  await espera(2000);
  const b = await bancoFalso();
  const enviada = b.fichas.find(f => f.motorista_id === A.id && f.status === 'pendente');
  r.envioCompleto = {
    modal: await page.$eval('#modal-protocolo-com-login', m => m.classList.contains('ativo') ? `aberto: ${document.getElementById('modal-num-protocolo-com-login').textContent}` : 'FECHADO'),
    ficha: enviada && `${enviada.id} ${enviada.status}`,
    mesmaFicha: !!enviada && enviada.iniciada_em === rasc.iniciada_em && !b.fichas.some(f => f.id === rasc.id),
    rascunhosDeA: b.fichas.filter(f => f.motorista_id === A.id && f.status === 'rascunho').length,
    dataEnvioAgora: !!enviada && enviada.data_envio >= antesDoEnvio,
    copiaApagada: (await copiaDe(A)) === null,
    botoesDoRascunho: await page.evaluate(() => ['btn-salvar-rascunho-ml', 'btn-apagar-tudo-rascunho', 'aviso-fotos-rascunho'].map(id => document.getElementById(id).hidden ? 'escondido' : 'VISÍVEL').join(', '))
  };
  // Depois de enviada não volta a ser rascunho ao sair da página
  await page.goto(`${base}/HTML/Login.html`, { waitUntil: 'domcontentloaded' });
  r.depoisDeSair = { rascunhosDeA: (await bancoFalso()).fichas.filter(f => f.motorista_id === A.id && f.status === 'rascunho').length };

  // 9. Gestão: rascunho fora da lista padrão e dos totais; aparece em "Em andamento"; sino conta o envio
  await page.evaluate((u, desde) => {
    localStorage.setItem('teste_usuario', JSON.stringify(u));
    localStorage.setItem(`ajborges_notificacoes_frota_${u.id}`, desde);
  }, GESTAO, antesDoEnvio);
  await page.goto(`${base}/HTML/dashboard-admin.html`, { waitUntil: 'load' });
  await espera(1500);
  r.gestao = await page.evaluate(() => ({
    // eslint-disable-next-line no-undef
    fichas: appState.fichas.map(f => `${f.id} ${f.status}`),
    contadorTodas: document.getElementById('contador-tab-todas').textContent,
    contadorPendentes: document.getElementById('contador-tab-pendentes').textContent,
    contadorEmAndamento: document.getElementById('contador-tab-andamento').textContent,
    linhasListaPadrao: Array.from(document.querySelectorAll('#tabela-fichas-body tr')).map(tr => tr.cells[0].textContent.trim()),
    sino: document.querySelector('#btn-notif-sino .notif-contador')?.hidden ? '(sem número)' : document.querySelector('#btn-notif-sino .notif-contador')?.textContent
  }));
  await page.click('#tab-fichas-andamento');
  await espera(800);
  r.gestaoEmAndamento = await page.evaluate(() => ({
    linhas: Array.from(document.querySelectorAll('#tabela-andamento-body tr')).map(tr => Array.from(tr.cells).map(td => td.textContent.trim()).join(' | ')),
    cabecalho: Array.from(document.querySelectorAll('#tabela-andamento-gestao th')).map(th => th.textContent.trim()).join(' | '),
    listaPadraoEscondida: getComputedStyle(document.getElementById('tabela-fichas-gestao').closest('.tabela-fichas-responsive')).display === 'none',
    botoesDeAcao: document.querySelectorAll('#tabela-andamento-wrap button, #tabela-andamento-wrap a').length,
    info: document.getElementById('tabela-info-registros').textContent
  }));

  // (o auth.js de teste não tem limparDadosLocais, que o login.js chama no Login.html)
  r.erros = erros.filter(e => !/Chart is not defined|limparDadosLocais/.test(e));
  console.log(JSON.stringify(r, null, 2));
  await browser.close(); srv.close();
})().catch(e => { console.error(e); process.exit(1); });
