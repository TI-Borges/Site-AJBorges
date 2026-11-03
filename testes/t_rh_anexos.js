// Anexos do Dashboard RH (R03) com o Supabase simulado: o supabase-js do CDN é trocado por um
// cliente falso. O banco (.schema('rh')) vai para um PGlite com R01 + R01b + R03; o Storage
// (.storage.from('rh-anexos')) é imitado no Node: confere limite e tipos do bucket como o serviço
// de Storage faz e grava em storage.objects com o papel authenticated e o JWT do usuário (quem
// barra é a RLS do R03). O link assinado é servido por este teste em /__assinado/<token>.
// Confere: envio com barra, lista (nome, tamanho, quem, quando), caminho sem o nome digitado,
// "Abrir" com link assinado de 60 s em nova aba (nunca link público), tipos e tamanho recusados
// antes de enviar, "Remover" = ativo false (arquivo fica), anexos antigos "sem arquivo",
// rh_restrito só com "Abrir" (e barrado pelo banco se forçar), nome com <img onerror> escapado,
// erro de rede, 390 px sem rolagem lateral.
// Uso: node testes/t_rh_anexos.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const puppeteer = require('puppeteer-core');
const { PGlite } = require('@electric-sql/pglite');
const { AUTH_SIMULADO, storageSimulado } = require('./rh_storage_simulado');

const RAIZ = path.resolve(__dirname, '..');
const RH = '/dashboard-rh/HTML/index.html';
const SUBS = {
  admin: '00000000-0000-0000-0000-0000000000c3',
  rh: '00000000-0000-0000-0000-0000000000a1',
  rh_restrito: '00000000-0000-0000-0000-0000000000b2'
};
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
let falhas = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'OK  ' : 'FALHA'} ${msg}`); if (!cond) falhas++; };
const esperar = (ms) => new Promise(r => setTimeout(r, ms));

const SUPABASE_FALSO = `
window.__chamadasStorage = [];
window.supabase = { createClient: () => {
  const SUBS = ${JSON.stringify(SUBS)};
  const papel = () => localStorage.getItem('teste_papel');
  const redeOff = () => localStorage.getItem('teste_rede_off') === '1';
  const erroRede = { data: null, error: { message: 'TypeError: Failed to fetch', details: '', hint: '', code: '' } };
  async function executar(pedido) {
    if (redeOff()) return erroRede;
    return window.__rhBanco(papel(), pedido);
  }
  function consulta(tabela) {
    const pedido = { tabela, op: 'select', valores: null, id: null };
    const q = {
      select() { return q; },
      insert(v) { pedido.op = 'insert'; pedido.valores = v; return q; },
      update(v) { pedido.op = 'update'; pedido.valores = v; return q; },
      eq(coluna, valor) { pedido.id = valor; return q; },
      then(ok, erro) { return executar(pedido).then(ok, erro); }
    };
    return q;
  }
  const storage = { from: (bucket) => ({
    async upload(caminho, arquivo, opcoes) {
      window.__chamadasStorage.push({ op: 'upload', bucket, caminho, opcoes, nome: arquivo.name });
      if (redeOff()) return { data: null, error: { name: 'StorageUnknownError', message: 'Failed to fetch' } };
      const bytes = new Uint8Array(await arquivo.arrayBuffer());
      let bin = '';
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      return window.__rhStorage(papel(), { op: 'upload', bucket, caminho, base64: btoa(bin),
        tipo: opcoes && opcoes.contentType, tamanho: arquivo.size, upsert: Boolean(opcoes && opcoes.upsert) });
    },
    async createSignedUrl(caminho, segundos) {
      window.__chamadasStorage.push({ op: 'assinar', bucket, caminho, segundos });
      return window.__rhStorage(papel(), { op: 'assinar', bucket, caminho, segundos });
    },
    getPublicUrl(caminho) {
      window.__chamadasStorage.push({ op: 'publico', bucket, caminho });
      return { data: { publicUrl: 'https://publico.invalido/' + caminho } };
    },
    async remove(caminhos) {
      window.__chamadasStorage.push({ op: 'remover', bucket, caminhos });
      return { data: [], error: null };
    }
  }) };
  return {
    auth: {
      getUser: async () => {
        const p = papel();
        return p ? { data: { user: { id: SUBS[p], email: p + '@teste.local', app_metadata: { role: p }, user_metadata: {} } }, error: null }
                 : { data: { user: null }, error: { message: 'sem sessão' } };
      },
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      signOut: async () => ({})
    },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }),
    schema: (nome) => ({ from: (tabela) => (nome === 'rh' ? consulta(tabela) : null) }),
    storage
  };
} };`;

// Tradução mínima do que o rh.js usa do PostgREST (igual ao t_rh_banco.js)
function montarSql(pedido) {
  const nome = /^[a-z_]+$/;
  if (!nome.test(pedido.tabela)) throw new Error('tabela inválida');
  const t = `rh.${pedido.tabela}`;
  if (pedido.op === 'select') return [`select coalesce(json_agg(x), '[]'::json) as j from ${t} x`, []];
  const linhas = Array.isArray(pedido.valores) ? pedido.valores : [pedido.valores];
  const cols = [...new Set(linhas.flatMap(Object.keys))];
  if (!cols.every(c => nome.test(c))) throw new Error('coluna inválida');
  if (pedido.op === 'insert') {
    return [`with r as (insert into ${t} (${cols}) select ${cols} from json_populate_recordset(null::${t}, $1::json) returning *)
             select coalesce(json_agg(r), '[]'::json) as j from r`, [JSON.stringify(linhas)]];
  }
  return [`with r as (update ${t} as alvo set ${cols.map(c => `${c} = s.${c}`)} from json_populate_record(null::${t}, $1::json) s
           where alvo.id = $2 returning alvo.*) select coalesce(json_agg(r), '[]'::json) as j from r`, [JSON.stringify(linhas[0]), pedido.id]];
}

const arquivos = new Map();    // caminho -> { tipo, bytes }
const assinaturas = new Map(); // token -> { caminho, expira }

function servidor() {
  const tipos = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
  return new Promise(res => {
    const srv = http.createServer((req, resp) => {
      const url = decodeURIComponent(req.url.split('?')[0]);
      if (url.startsWith('/__assinado/')) {
        const a = assinaturas.get(url.slice('/__assinado/'.length));
        const arq = a && Date.now() <= a.expira && arquivos.get(a.caminho);
        if (!arq) { resp.writeHead(400); return resp.end('link expirado ou inválido'); }
        resp.writeHead(200, { 'Content-Type': arq.tipo });
        return resp.end(arq.bytes);
      }
      const arq = path.join(RAIZ, url);
      fs.readFile(arq, (err, dados) => {
        if (err) { resp.writeHead(404); return resp.end(); }
        resp.writeHead(200, { 'Content-Type': tipos[path.extname(arq).toLowerCase()] || 'application/octet-stream' });
        resp.end(dados);
      });
    });
    srv.listen(0, () => res(srv));
  });
}

(async () => {
  const db = new PGlite();
  await db.exec(AUTH_SIMULADO + storageSimulado());
  for (const arq of ['R01_estrutura.sql', 'R01b_admin.sql', 'R03_anexos.sql']) {
    const sql = fs.readFileSync(path.join(RAIZ, 'supabase/sql/rh', arq), 'utf8');
    const ini = sql.indexOf('\nbegin;\n');
    await db.exec(sql.slice(ini, sql.indexOf('\ncommit;\n') + '\ncommit;\n'.length));
  }
  // Um processo com 2 etapas; a 2ª tem anexos antigos (só nomes, um deles com HTML)
  const NOME_ANTIGO_XSS = '<img src=x onerror="window.__xss=2">antigo.pdf';
  const semente = (await db.query(`
    with c as (insert into rh.colaboradores (nome, vinculo) values ('Ana Souza', 'CLT') returning id),
         p as (insert into rh.processos (colaborador_id, modelo_id, modelo_nome)
               select c.id, m.id, m.nome from c, rh.modelos m where m.chave = 'rescisao_clt' returning id),
         e1 as (insert into rh.etapas (processo_id, ordem, nome) select p.id, 1, 'Exame demissional' from p returning id),
         e2 as (insert into rh.etapas (processo_id, ordem, nome, anexos)
                select p.id, 2, 'Assinaturas', array['contrato-antigo.pdf', $1] from p returning id)
    select (select id from p) proc, (select id from e1) e1, (select id from e2) e2`, [NOME_ANTIGO_XSS])).rows[0];

  const srv = await servidor();
  const base = `http://127.0.0.1:${srv.address().port}`;
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: true, args: ['--no-sandbox']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1366, height: 900 });
  const erros = [];
  const dialogos = [];
  page.on('pageerror', e => erros.push(String(e)));
  page.on('dialog', d => { dialogos.push(d.message()); d.accept(); });
  await page.setRequestInterception(true);
  page.on('request', r => {
    const u = r.url();
    if (u.includes('@supabase/supabase-js')) return r.respond({ status: 200, contentType: 'text/javascript', body: SUPABASE_FALSO });
    if (!u.startsWith(base)) return r.respond({ status: 200, contentType: 'text/css', body: '' });
    r.continue();
  });

  let pendentes = 0;
  let atrasoEnvio = 0;
  const comoUsuario = (papel, fn) => db.transaction(async (tx) => {
    const claims = JSON.stringify({ sub: SUBS[papel], role: 'authenticated', email: `${papel}@teste.local`, app_metadata: { role: papel } });
    await tx.query(`select set_config('request.jwt.claims', $1, true)`, [claims]);
    await tx.query('set local role authenticated');
    return fn(tx);
  });
  await page.exposeFunction('__rhBanco', async (papel, pedido) => {
    pendentes++;
    try {
      const data = await comoUsuario(papel, async (tx) => {
        const [sql, params] = montarSql(pedido);
        return (await tx.query(sql, params)).rows[0].j;
      });
      return { data, error: null };
    } catch (e) {
      return { data: null, error: { message: e.message, code: e.code || '', details: e.detail || '' } };
    } finally {
      pendentes--;
    }
  });
  // Imitação do serviço de Storage: limite e tipos do bucket, depois insert com a RLS do usuário
  const erroStorage = (status, message) => ({ data: null, error: { name: 'StorageApiError', status, statusCode: String(status), message } });
  await page.exposeFunction('__rhStorage', async (papel, p) => {
    pendentes++;
    try {
      if (p.op === 'upload') {
        await esperar(atrasoEnvio);
        const b = (await db.query(`select * from storage.buckets where id = $1`, [p.bucket])).rows[0];
        if (!b) return erroStorage(400, 'Bucket not found');
        if (b.public) return erroStorage(500, 'TESTE: bucket público!');
        if (b.file_size_limit && p.tamanho > Number(b.file_size_limit)) return erroStorage(413, 'The object exceeded the maximum allowed size');
        if (b.allowed_mime_types && !b.allowed_mime_types.includes(p.tipo)) return erroStorage(415, `mime type ${p.tipo} is not supported`);
        await comoUsuario(papel, (tx) => tx.query(
          `insert into storage.objects (bucket_id, name, owner_id, metadata) values ($1, $2, $3, $4)`,
          [p.bucket, p.caminho, SUBS[papel], JSON.stringify({ size: p.tamanho, mimetype: p.tipo })]));
        arquivos.set(p.caminho, { tipo: p.tipo, bytes: Buffer.from(p.base64, 'base64') });
        return { data: { path: p.caminho }, error: null };
      }
      if (p.op === 'assinar') {
        const n = await comoUsuario(papel, async (tx) => (await tx.query(
          `select count(*)::int n from storage.objects where bucket_id = $1 and name = $2`, [p.bucket, p.caminho])).rows[0].n);
        if (!n) return erroStorage(400, 'Object not found');
        const token = crypto.randomUUID();
        assinaturas.set(token, { caminho: p.caminho, expira: Date.now() + p.segundos * 1000 });
        return { data: { signedUrl: `${base}/__assinado/${token}` }, error: null };
      }
      return erroStorage(400, 'operação desconhecida');
    } catch (e) {
      // O Storage devolve 403 para RLS e 409 para caminho repetido
      return erroStorage(e.code === '42501' ? 403 : (e.code === '23505' ? 409 : 500),
        e.code === '42501' ? 'new row violates row-level security policy' : e.message);
    } finally {
      pendentes--;
    }
  });
  const ocioso = async () => {
    for (let i = 0; i < 200; i++) {
      await esperar(60);
      if (pendentes === 0) { await esperar(150); if (pendentes === 0) return; }
    }
  };
  const aviso = () => page.evaluate(() => {
    const a = document.getElementById('rh-aviso-erro');
    return a.hidden ? '' : document.getElementById('rh-aviso-erro-texto').textContent;
  });
  const fecharAviso = () => page.evaluate(() => { document.getElementById('rh-aviso-erro').hidden = true; });
  const entrar = async (papel) => {
    await page.goto(`${base}/HTML/Login.html`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(p => { localStorage.clear(); localStorage.setItem('teste_papel', p); }, papel);
    await page.goto(`${base}${RH}`, { waitUntil: 'load' });
    await esperar(300);
    await ocioso();
    await page.click('#rh-nav-list .nav-link[data-view="processos"]');
    await esperar(150);
  };
  // Escolhe o arquivo no input da etapa (File criado no navegador: dá para usar nomes com < > ")
  const anexar = (etapaId, nome, tipo, conteudo) => page.evaluate((etapaId, nome, tipo, conteudo) => {
    const input = document.querySelector(`.etapa-card[data-etapa-id="${etapaId}"] .input-anexo-etapa`);
    const partes = typeof conteudo === 'number' ? [new Uint8Array(conteudo)] : [conteudo];
    const dt = new DataTransfer();
    dt.items.add(new File(partes, nome, tipo ? { type: tipo } : {}));
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, etapaId, nome, tipo, conteudo);
  const chamadas = () => page.evaluate(() => window.__chamadasStorage.slice());
  const card = (etapaId) => page.evaluate((etapaId) => {
    const c = document.querySelector(`.etapa-card[data-etapa-id="${etapaId}"]`);
    const vis = (el) => el && getComputedStyle(el).display !== 'none';
    return {
      titulo: c.querySelector('.etapa-subsecao:last-child .etapa-subsecao-titulo').textContent.trim(),
      itens: Array.from(c.querySelectorAll('.anexo-item')).map(li => ({
        nome: li.querySelector('.anexo-nome').textContent.trim(),
        meta: li.querySelector('.anexo-meta').textContent.replace(/\s+/g, ' ').trim(),
        abrir: vis(li.querySelector('[data-acao="abrir-anexo"]')),
        remover: vis(li.querySelector('[data-acao="remover-anexo"]'))
      })),
      antigos: Array.from(c.querySelectorAll('.anexo-antigo')).map(s => s.textContent.replace(/\s+/g, ' ').trim()),
      anexar: vis(c.querySelector('.label-upload-anexo')),
      barra: Array.from(c.querySelectorAll('.anexo-envio')).map(b => b.textContent.trim()),
      imgs: c.querySelectorAll('img').length
    };
  }, etapaId);
  const linhas = async (sql, params) => (await db.query(sql, params)).rows;

  // 1. Anexos antigos (só nome)
  console.log('\n--- Anexos antigos ---');
  await entrar('admin');
  let c2 = await card(semente.e2);
  ok(c2.antigos.length === 2 && c2.antigos.every(t => t.endsWith('registro antigo, sem arquivo')),
    `antigos aparecem como "registro antigo, sem arquivo" ${JSON.stringify(c2.antigos)}`);
  ok(c2.antigos[1].includes('<img') && c2.imgs === 0 && !(await page.evaluate(() => window.__xss)),
    'nome antigo com <img onerror> aparece como texto');
  ok(c2.itens.length === 0 && c2.titulo === 'Anexos (2)', `antigos sem "Abrir" (${c2.titulo})`);

  // 2. Envio de PDF pelo admin, com barra de envio
  console.log('\n--- Admin anexa ---');
  atrasoEnvio = 700;
  await anexar(semente.e1, 'ASO Ana Souza.pdf', 'application/pdf', '%PDF-1.4 conteudo do ASO');
  await esperar(250);
  let c1 = await card(semente.e1);
  ok(c1.barra.length === 1 && /Enviando "ASO Ana Souza\.pdf" \(24 bytes\)/.test(c1.barra[0]), `barra de envio durante o envio: ${JSON.stringify(c1.barra)}`);
  await ocioso();
  atrasoEnvio = 0;
  c1 = await card(semente.e1);
  ok(c1.barra.length === 0, 'barra some depois do envio');
  ok(c1.itens.length === 1 && c1.itens[0].nome === '📎 ASO Ana Souza.pdf', `lista mostra o nome ${JSON.stringify(c1.itens)}`);
  ok(/^24 bytes • enviado por admin@teste\.local em \d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/.test(c1.itens[0].meta),
    `lista mostra tamanho, quem e quando: "${c1.itens[0].meta}"`);
  const up = (await chamadas()).find(x => x.op === 'upload');
  ok(up.bucket === 'rh-anexos' && up.opcoes.upsert === false && up.opcoes.contentType === 'application/pdf',
    `upload no rh-anexos sem upsert e com contentType (${JSON.stringify(up.opcoes)})`);
  ok(new RegExp(`^${semente.proc}/${semente.e1}/${UUID}\\.pdf$`).test(up.caminho) && !/ASO|Ana/.test(up.caminho),
    `caminho <processo>/<etapa>/<uuid>.pdf, sem o nome digitado (${up.caminho})`);
  const reg = (await linhas(`select * from rh.anexos`))[0];
  ok(reg && reg.caminho === up.caminho && reg.nome_original === 'ASO Ana Souza.pdf' && reg.criado_por === SUBS.admin
    && reg.criado_por_email === 'admin@teste.local' && Number(reg.tamanho) === 24 && reg.tipo === 'application/pdf',
    'no banco: rh.anexos com caminho, nome original, quem enviou, tamanho e tipo');

  // 3. Abrir: link assinado de 60 s em nova aba
  console.log('\n--- Abrir ---');
  const abrir = async (etapaId) => {
    const popup = new Promise(res => browser.once('targetcreated', t => res(t)));
    await page.click(`.etapa-card[data-etapa-id="${etapaId}"] [data-acao="abrir-anexo"]`);
    const alvo = await popup;
    for (let i = 0; i < 50 && !alvo.url().includes('/__assinado/'); i++) await esperar(60);
    const aba = await alvo.page();
    const semOpener = aba ? await aba.evaluate(() => window.opener === null) : false;
    if (aba) await aba.close();
    // PDF abre no visualizador do Chrome (sem texto na página): confere o conteúdo baixando o link
    const texto = alvo.url().startsWith(base) ? await (await fetch(alvo.url())).text() : '';
    return { url: alvo.url(), texto, semOpener };
  };
  const aberto = await abrir(semente.e1);
  const assinar = (await chamadas()).filter(x => x.op === 'assinar').pop();
  ok(aberto.url.startsWith(`${base}/__assinado/`) && aberto.texto.includes('conteudo do ASO'),
    `"Abrir" abre o arquivo em nova aba (${aberto.url.replace(base, '')})`);
  ok(assinar && assinar.segundos === 60 && assinar.caminho === up.caminho, 'createSignedUrl com 60 segundos');
  ok(aberto.semOpener, 'a aba nova não tem acesso à página (opener = null)');

  // 4. JPG sem tipo informado (vale a extensão) e nome com <img onerror>
  console.log('\n--- Outros envios ---');
  await anexar(semente.e1, 'Foto do documento.JPG', '', 'jpg-falso');
  await ocioso();
  const NOME_XSS = '<img src=x onerror="window.__xss=1">contrato.png';
  await anexar(semente.e1, NOME_XSS, 'image/png', 'png-falso');
  await ocioso();
  c1 = await card(semente.e1);
  const ups = (await chamadas()).filter(x => x.op === 'upload');
  ok(ups[1] && /\.jpg$/.test(ups[1].caminho) && ups[1].opcoes.contentType === 'image/jpeg', 'JPG sem tipo do navegador: tipo pela extensão (image/jpeg, .jpg)');
  ok(c1.itens.length === 3 && c1.itens[2].nome === `📎 ${NOME_XSS}` && c1.imgs === 0 && !(await page.evaluate(() => window.__xss)),
    'nome com <img onerror> aparece como texto (escapeHtml)');
  ok((await linhas(`select count(*)::int n from rh.anexos where nome_original = $1`, [NOME_XSS]))[0].n === 1, 'no banco: nome original guardado como veio');
  ok(!(await aviso()), `nenhum aviso de erro ${await aviso()}`);

  // 5. Tipos e tamanho recusados antes de enviar
  console.log('\n--- Recusados ---');
  const antes = (await chamadas()).filter(x => x.op === 'upload').length;
  const recusas = [];
  for (const [nome, tipo, conteudo] of [
    ['planilha.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'x'],
    ['programa.exe', '', 'x'],
    ['pagina.pdf', 'text/html', '<script>'],
    ['ASO grande.pdf', 'application/pdf', 11 * 1024 * 1024],
    ['vazio.pdf', 'application/pdf', 0]
  ]) {
    await fecharAviso();
    await anexar(semente.e1, nome, tipo, conteudo);
    await ocioso();
    recusas.push(await aviso());
  }
  console.log('  ' + recusas.join('\n  '));
  ok(recusas.slice(0, 3).every(t => /não foi anexado: só são aceitos arquivos PDF, JPG ou PNG/.test(t)), 'xlsx, exe e "pdf" que é HTML: recusados (só PDF, JPG ou PNG)');
  ok(/"ASO grande\.pdf" tem 11 MB e não foi anexado: o limite é 10 MB por arquivo/.test(recusas[3]), 'arquivo de 11 MB: recusado com o limite de 10 MB');
  ok(/vazio/.test(recusas[4]), 'arquivo vazio: recusado');
  ok((await chamadas()).filter(x => x.op === 'upload').length === antes, 'nenhum dos recusados foi enviado');
  await fecharAviso();

  // 6. Remover: ativo = false, arquivo continua no bucket
  console.log('\n--- Remover ---');
  await page.click(`.etapa-card[data-etapa-id="${semente.e1}"] .anexo-item:nth-child(1) [data-acao="remover-anexo"]`);
  await ocioso();
  c1 = await card(semente.e1);
  const removido = (await linhas(`select a.ativo, (select count(*)::int from storage.objects o where o.name = a.caminho) arquivos,
      (select count(*)::int from rh.auditoria u where u.tabela = 'anexos' and u.registro_id = a.id) auditoria
    from rh.anexos a where a.nome_original = 'ASO Ana Souza.pdf'`))[0];
  ok(dialogos.some(d => /Remover "ASO Ana Souza\.pdf".*continua guardado/.test(d)), 'pede confirmação antes de remover');
  ok(c1.itens.length === 2 && !c1.itens.some(i => i.nome.includes('ASO Ana Souza')), 'some da lista');
  ok(removido.ativo === false && removido.arquivos === 1 && removido.auditoria === 1, `no banco: ativo = false, arquivo no bucket, 1 linha de auditoria ${JSON.stringify(removido)}`);
  ok(!(await chamadas()).some(x => x.op === 'remover' || x.op === 'publico'), 'nunca chamou remove() nem getPublicUrl()');

  // 7. Erro de rede no envio
  console.log('\n--- Rede ---');
  await page.evaluate(() => localStorage.setItem('teste_rede_off', '1'));
  await anexar(semente.e1, 'Sem rede.pdf', 'application/pdf', 'x');
  await ocioso();
  c1 = await card(semente.e1);
  ok(/Sem conexão com o servidor/.test(await aviso()) && c1.barra.length === 0, `sem rede: aviso e a barra some ("${await aviso()}")`);
  await page.evaluate(() => localStorage.removeItem('teste_rede_off'));
  await fecharAviso();

  // 8. rh_restrito: só "Abrir"
  console.log('\n--- rh_restrito ---');
  await entrar('rh_restrito');
  c1 = await card(semente.e1);
  ok(c1.itens.length === 2 && c1.itens.every(i => i.abrir && !i.remover) && !c1.anexar,
    `restrito vê "Abrir", sem "Remover" e sem "Anexar" ${JSON.stringify({ anexar: c1.anexar, itens: c1.itens.map(i => [i.abrir, i.remover]) })}`);
  const abertoRestrito = await abrir(semente.e1);
  ok(abertoRestrito.url.includes('/__assinado/') && !(await aviso()), 'restrito abre o anexo (link assinado)');
  // Forçando a tela: o input escondido manda o arquivo; o Storage (RLS) barra
  await page.evaluate(() => document.body.classList.remove('rh-papel-restrito'));
  await anexar(semente.e1, 'Do restrito.pdf', 'application/pdf', 'x');
  await ocioso();
  c1 = await card(semente.e1);
  const nada = (await linhas(`select (select count(*)::int from storage.objects where bucket_id = 'rh-anexos') objetos,
      (select count(*)::int from rh.anexos) anexos`))[0];
  ok(/Sem permissão/.test(await aviso()) && c1.barra.length === 0, `restrito forçando envio: "${await aviso()}"`);
  ok(nada.objetos === 3 && nada.anexos === 3, `no banco: nada novo ${JSON.stringify(nada)}`);

  // 9. 390 px
  console.log('\n--- 390 px ---');
  await entrar('admin');
  await page.setViewport({ width: 390, height: 844 });
  await esperar(200);
  const l = await page.evaluate((e1) => {
    const c = document.querySelector(`.etapa-card[data-etapa-id="${e1}"]`);
    const sub = c.querySelector('.etapa-subsecao:last-child');
    sub.scrollIntoView();
    const fora = Array.from(sub.querySelectorAll('button, .label-upload-anexo, .anexo-nome, .anexo-antigo'))
      .filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && (r.left < 0 || r.right > window.innerWidth); });
    return { rolagem: document.documentElement.scrollWidth > window.innerWidth, fora: fora.length };
  }, semente.e1);
  ok(!l.rolagem && l.fora === 0, `390px: sem rolagem lateral e nada do bloco de anexos para fora da tela ${JSON.stringify(l)}`);
  await page.evaluate((e1) => document.querySelector(`.etapa-card[data-etapa-id="${e1}"] .etapa-subsecao:last-child`)
    .scrollIntoView({ block: 'center' }), semente.e1);
  await esperar(150);
  await page.screenshot({ path: path.join(RAIZ, 'testes/capturas/rh_anexos_390.png') });
  console.log('  captura: testes/capturas/rh_anexos_390.png');

  ok(erros.length === 0, `sem erros de JS ${erros.length ? JSON.stringify(erros) : ''}`);
  await browser.close(); srv.close();
  console.log(`\n${falhas ? falhas + ' FALHA(S)' : 'TUDO OK'}`);
  process.exit(falhas ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
