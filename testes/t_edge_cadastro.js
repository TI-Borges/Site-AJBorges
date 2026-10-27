// Edge function solicitar-cadastro rodando no Node (o Node 24 tira os tipos do .ts), com o Supabase
// simulado em memória: nada vai para o banco nem para o bucket. Só dados inventados (CPF de teste
// 523.169.159-30, nomes "de Teste"). Confere o que ela aceita e recusa e o que grava no cadastro.
// Uso: node testes/t_edge_cadastro.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const RAIZ = process.env.RAIZ || path.resolve(__dirname, '..');

async function carregarEdge() {
  let src = fs.readFileSync(path.join(RAIZ, 'supabase/functions/solicitar-cadastro/index.ts'), 'utf8');
  src = src.replace(/^import \{ createClient \} from "npm:@supabase\/supabase-js@2";$/m,
    'const createClient = (...a: unknown[]) => (globalThis as any).__criarCliente(...a);');
  const arq = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'edge-cad-')), 'index.ts');
  fs.writeFileSync(arq, src);
  let handler = null;
  globalThis.Deno = {
    env: { get: (k) => ({ SUPABASE_URL: 'https://teste.invalid', SUPABASE_SERVICE_ROLE_KEY: 'chave-teste', LOGIN_PEPPER: 'pepper-teste' })[k] },
    serve: (fn) => { handler = fn; }
  };
  globalThis.__banco = { cadastros: [], urls: [] };
  globalThis.__criarCliente = () => {
    const banco = globalThis.__banco;
    const tabela = () => {
      const q = { filtros: [], op: 'select', valores: null };
      const api = {
        select: () => api,
        eq: (c, v) => { q.filtros.push([c, v]); return api; },
        insert: (v) => { q.op = 'insert'; q.valores = v; return api; },
        update: (v) => { q.op = 'update'; q.valores = v; return api; },
        delete: () => { q.op = 'delete'; return api; },
        single: async () => executar(true),
        then: (ok, erro) => executar(false).then(ok, erro)
      };
      const casa = (l) => q.filtros.every(([c, v]) => l[c] === v);
      async function executar(uma) {
        if (q.op === 'insert') {
          const linha = { id: `cad-teste-${banco.cadastros.length + 1}`, ...q.valores };
          banco.cadastros.push(linha);
          return { data: { id: linha.id }, error: null };
        }
        const linhas = banco.cadastros.filter(casa);
        if (q.op === 'update') { linhas.forEach((l) => Object.assign(l, q.valores)); return { data: uma ? (linhas[0] ? { id: linhas[0].id } : null) : linhas, error: null }; }
        if (q.op === 'delete') { banco.cadastros = banco.cadastros.filter((l) => !casa(l)); return { data: uma ? linhas[0] || null : linhas, error: null }; }
        return { data: uma ? linhas[0] || null : linhas.map((l) => ({ id: l.id, status: l.status })), error: null };
      }
      return api;
    };
    return {
      rpc: async () => ({ data: [{ esta_bloqueado: false }], error: null }),
      from: () => tabela(),
      storage: { from: () => ({ createSignedUploadUrl: async (p) => { banco.urls.push(p); return { data: { path: p, token: `token-${banco.urls.length}` }, error: null }; } }) }
    };
  };
  await import(pathToFileURL(arq).href);
  return handler;
}

// Corpo válido do formulário novo (PF, Toco): CNH, CRLV e RNTRC em PDF, a selfie em foto e sem comprovante
function corpoValido(extra = {}) {
  const pdf = (nome) => ({ nome, tipo: 'application/pdf', tamanho: 2048 });
  return {
    tipo: 'pf', tipologia: 'Toco (4×2)', email: null, aceite_lgpd: true, versao_politica: '2026-10-19',
    dados: { 'motorista-nome': 'Fulano', 'motorista-sobrenome': 'de Teste', cpf: '523.169.159-30', celular: '(11) 90000-0000',
      'rastreador-marca': 'Sascar', 'rastreador-id': 'TESTE-000123' },
    documentos: { cnh: [pdf('cnh.pdf')], selfie: [{ nome: 'selfie.jpg', tipo: 'image/jpeg', tamanho: 4096 }], crlv_1: [pdf('crlv.pdf')], rntrc: [pdf('rntrc.pdf')] },
    ...extra
  };
}

(async () => {
  const handler = await carregarEdge();
  const enviar = async (corpo) => {
    globalThis.__banco = { cadastros: [], urls: [] };
    const req = new Request('https://teste.invalid/functions/v1/solicitar-cadastro', { method: 'POST', body: JSON.stringify(corpo), headers: { 'content-type': 'application/json' } });
    const r = await handler(req);
    const json = await r.json();
    return { status: r.status, erro: json.erro, uploads: (json.uploads || []).map((u) => u.path.split('/').pop()), cadastro: globalThis.__banco.cadastros[0] };
  };
  const pdf = (nome) => ({ nome, tipo: 'application/pdf', tamanho: 2048 });
  const foto = (nome) => ({ nome, tipo: 'image/jpeg', tamanho: 2048 });
  const base = corpoValido();
  const casos = {
    'aceita: Toco com CNH, CRLV e RNTRC em PDF, sem comprovante': base,
    'aceita: com o comprovante em PDF': corpoValido({ documentos: { ...base.documentos, residencia: [pdf('conta.pdf')] } }),
    'recusa: foto na CNH': corpoValido({ documentos: { ...base.documentos, cnh: [foto('cnh.jpg')] } }),
    'recusa: foto no CRLV': corpoValido({ documentos: { ...base.documentos, crlv_1: [foto('crlv.jpg')] } }),
    'recusa: foto no RNTRC': corpoValido({ documentos: { ...base.documentos, rntrc: [foto('rntrc.jpg')] } }),
    'recusa: foto no comprovante': corpoValido({ documentos: { ...base.documentos, residencia: [foto('conta.jpg')] } }),
    'recusa: sem a CNH': corpoValido({ documentos: { selfie: base.documentos.selfie, crlv_1: base.documentos.crlv_1, rntrc: base.documentos.rntrc } }),
    'recusa: sem a selfie': corpoValido({ documentos: { cnh: base.documentos.cnh, crlv_1: base.documentos.crlv_1, rntrc: base.documentos.rntrc } }),
    'recusa: selfie em PDF': corpoValido({ documentos: { ...base.documentos, selfie: [pdf('selfie.pdf')] } }),
    'recusa: 2 selfies': corpoValido({ documentos: { ...base.documentos, selfie: [foto('a.jpg'), foto('b.jpg')] } }),
    'aceita: selfie em PNG': corpoValido({ documentos: { ...base.documentos, selfie: [{ nome: 'selfie.png', tipo: 'image/png', tamanho: 4096 }] } }),
    'recusa: Cavalo 6×2 só com o CRLV do cavalo': corpoValido({ tipologia: 'Cavalo 6×2' }),
    'aceita: Cavalo 6×2 com os 2 CRLVs': corpoValido({ tipologia: 'Cavalo 6×2', documentos: { ...base.documentos, crlv_2: [pdf('carreta.pdf')] } }),
    'recusa: sem_pdf na CNH': corpoValido({ sem_pdf: { cnh: true } }),
    'recusa: sem_pdf no comprovante': corpoValido({ sem_pdf: { residencia: true } }),
    'recusa: sem_pdf no CRLV': corpoValido({ sem_pdf: { crlv_1: true } }),
    'recusa: campo digitado da CNH (cnh-registro)': corpoValido({ dados: { ...base.dados, 'cnh-registro': '12345678900' } }),
    'recusa: campo digitado do CRLV (crlv1-placa)': corpoValido({ dados: { ...base.dados, 'crlv1-placa': 'ABC1D23' } }),
    'recusa: campo digitado do endereço (mot-cep)': corpoValido({ dados: { ...base.dados, 'mot-cep': '00000-000' } }),
    'recusa: arquivo com tamanho 0': corpoValido({ documentos: { ...base.documentos, cnh: [{ nome: 'cnh.pdf', tipo: 'application/pdf', tamanho: 0 }] } }),
    'recusa: arquivo com mais de 10 MB': corpoValido({ documentos: { ...base.documentos, cnh: [{ nome: 'cnh.pdf', tipo: 'application/pdf', tamanho: 10 * 1024 * 1024 + 1 }] } }),
    'recusa: sem rastreador': corpoValido({ dados: { 'motorista-nome': 'Fulano', 'motorista-sobrenome': 'de Teste', cpf: '523.169.159-30', celular: '(11) 90000-0000' } }),
    'recusa: sem o código do rastreador': corpoValido({ dados: { ...base.dados, 'rastreador-id': '' } }),
    'recusa: código do rastreador com 41 caracteres': corpoValido({ dados: { ...base.dados, 'rastreador-id': 'X'.repeat(41) } }),
    'aceita: PJ com rastreador e dados da empresa': corpoValido({ tipo: 'pj', dados: { ...base.dados, 'nome-empresa': 'Transportes de Teste', cnpj: '00.000.000/0001-91', 'telefone-empresa': '(11) 3000-0000', responsavel: 'Fulano de Teste' } }),
    'recusa: celular com 9 dígitos': corpoValido({ dados: { ...base.dados, celular: '(11) 9000-000' } }),
    'recusa: sem celular': corpoValido({ dados: { ...base.dados, celular: '' } })
  };
  const r = {};
  for (const [nome, corpo] of Object.entries(casos)) {
    const res = await enviar(corpo);
    const esperaAceitar = nome.startsWith('aceita');
    const ok = esperaAceitar ? res.status === 200 : res.status >= 400;
    r[nome] = `${ok ? 'OK ' : 'ERRO'} ${res.status} ${res.erro || ''}${res.uploads.length ? ` | uploads: ${res.uploads.join(', ')}` : ''}`;
  }
  // O que fica gravado no cadastro novo
  const gravado = (await enviar(corpoValido({ tipologia: 'Cavalo 6×2', documentos: { ...base.documentos, crlv_2: [pdf('carreta.pdf')] } }))).cadastro;
  r.gravado = {
    chavesDeDados: Object.keys(gravado.dados).sort(),
    _papeis: gravado.dados._papeis, _so_pdf: gravado.dados._so_pdf, temSemPdf: Object.hasOwn(gravado.dados, '_sem_pdf'),
    celular: gravado.celular, sem_carreta: gravado.sem_carreta,
    documentos: gravado.documentos.map((d) => `${d.campo}:${d.tipo}`)
  };
  console.log(JSON.stringify(r, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
