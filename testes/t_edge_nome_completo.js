// Edge function solicitar-cadastro: "Nome completo" do motorista num campo só (dados["motorista-nome"]).
// Roda no Node (o Node 24 tira os tipos do .ts) com o Supabase simulado em memória: nada vai para o banco.
// Só dados inventados (CPF de teste 523.169.159-30, nomes "de Teste").
// Confere: nome completo aceito e gravado (coluna nome e dados), sem "motorista-sobrenome"; uma palavra só,
// vazio e mais de 120 letras recusados; espaços das pontas e repetidos saem; ficha antiga (Nome + Sobrenome)
// continua aceita e é juntada com cuidado; a trava de CPF (erro 23505 cadastro_duplicado) segue igual.
// Uso: node testes/t_edge_nome_completo.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const RAIZ = process.env.RAIZ || path.resolve(__dirname, '..');
let falhas = 0;
const ok = (cond, msg, extra) => { console.log(`${cond ? 'OK  ' : 'FALHA'} ${msg}${extra !== undefined ? ` (${JSON.stringify(extra)})` : ''}`); if (!cond) falhas++; };

async function carregarEdge() {
  let src = fs.readFileSync(path.join(RAIZ, 'supabase/functions/solicitar-cadastro/index.ts'), 'utf8');
  src = src.replace(/^import \{ createClient \} from "npm:@supabase\/supabase-js@2";$/m,
    'const createClient = (...a: unknown[]) => (globalThis as any).__criarCliente(...a);');
  const arq = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'edge-nome-')), 'index.ts');
  fs.writeFileSync(arq, src);
  let handler = null;
  globalThis.Deno = {
    env: { get: (k) => ({ SUPABASE_URL: 'https://teste.invalid', SUPABASE_SERVICE_ROLE_KEY: 'chave-teste', LOGIN_PEPPER: 'pepper-teste' })[k] },
    serve: (fn) => { handler = fn; }
  };
  globalThis.__banco = { cadastros: [], urls: [], duplicado: false };
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
        then: (okf, erro) => executar(false).then(okf, erro)
      };
      const casa = (l) => q.filtros.every(([c, v]) => l[c] === v);
      async function executar(uma) {
        if (q.op === 'insert') {
          // Como o trigger do passo25: CPF já ativo -> 23505 cadastro_duplicado
          if (banco.duplicado) return { data: null, error: { code: '23505', message: 'cadastro_duplicado' } };
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

function corpo(dadosNome) {
  const pdf = (nome) => ({ nome, tipo: 'application/pdf', tamanho: 2048 });
  return {
    tipo: 'pf', tipologia: 'Toco (4×2)', email: null, aceite_lgpd: true, versao_politica: '2026-10-19',
    dados: { ...dadosNome, cpf: '523.169.159-30', celular: '(11) 90000-0000', 'rastreador-marca': 'Sascar', 'rastreador-id': 'TESTE-000123' },
    documentos: { cnh: [pdf('cnh.pdf')], selfie: [{ nome: 'selfie.jpg', tipo: 'image/jpeg', tamanho: 4096 }], crlv_1: [pdf('crlv.pdf')], rntrc: [pdf('rntrc.pdf')] }
  };
}

(async () => {
  const handler = await carregarEdge();
  const enviar = async (dadosNome, { duplicado = false } = {}) => {
    globalThis.__banco = { cadastros: [], urls: [], duplicado };
    const req = new Request('https://teste.invalid/functions/v1/solicitar-cadastro', { method: 'POST', body: JSON.stringify(corpo(dadosNome)), headers: { 'content-type': 'application/json' } });
    const r = await handler(req);
    const json = await r.json();
    const cad = globalThis.__banco.cadastros[0];
    return { status: r.status, erro: json.erro || '', faltando: json.faltando, nome: cad && cad.nome, dadosNome: cad && cad.dados['motorista-nome'], temSobrenome: !!cad && Object.hasOwn(cad.dados, 'motorista-sobrenome') };
  };

  console.log('--- Ficha nova: um campo só ---');
  let r = await enviar({ 'motorista-nome': 'Fulano de Teste' });
  ok(r.status === 200 && r.nome === 'Fulano de Teste' && r.dadosNome === 'Fulano de Teste' && !r.temSobrenome, 'nome completo aceito; coluna nome e dados["motorista-nome"] com o nome completo; sem sobrenome', r);
  r = await enviar({ 'motorista-nome': '   Fulano    de   Teste  ' });
  ok(r.status === 200 && r.nome === 'Fulano de Teste' && r.dadosNome === 'Fulano de Teste', 'tira espaços das pontas e repetidos', r);
  r = await enviar({ 'motorista-nome': 'Fulano' });
  ok(r.status === 400 && r.erro === 'Informe o nome completo' && r.nome === undefined, 'uma palavra só: recusado ("Informe o nome completo"), nada gravado', r);
  r = await enviar({ 'motorista-nome': '   ' });
  ok(r.status === 400 && /obrigatórios/.test(r.erro) && (r.faltando || []).includes('Nome completo'), 'vazio: "Preencha os campos obrigatórios" com "Nome completo"', r);
  r = await enviar({});
  ok(r.status === 400 && (r.faltando || []).includes('Nome completo') && !(r.faltando || []).includes('Sobrenome'), 'sem nome: falta "Nome completo" (não pede mais Sobrenome)', r);
  const n120 = `Fulano ${'a'.repeat(113)}`; // 120 letras
  r = await enviar({ 'motorista-nome': n120 });
  ok(r.status === 200 && r.nome === n120, '120 letras: aceito', { status: r.status, tam: (r.nome || '').length });
  r = await enviar({ 'motorista-nome': `${n120}b` });
  ok(r.status === 400 && /no máximo 120/.test(r.erro), '121 letras: recusado', r.erro);

  console.log('\n--- Ficha antiga aberta no navegador (Nome + Sobrenome) ---');
  const casos = [
    [{ 'motorista-nome': 'Fulano', 'motorista-sobrenome': 'de Teste' }, 'Fulano de Teste', 'nome + sobrenome'],
    [{ 'motorista-nome': 'Fulano de Teste', 'motorista-sobrenome': 'fulano de  TESTE' }, 'Fulano de Teste', 'iguais (maiúsculas/espaços): um só'],
    [{ 'motorista-nome': 'José de Teste', 'motorista-sobrenome': 'Jose de Teste' }, 'José de Teste', 'iguais (acento): um só'],
    [{ 'motorista-nome': 'Fulano', 'motorista-sobrenome': 'Fulano de Teste' }, 'Fulano de Teste', 'sobrenome contém o nome: o mais longo'],
    [{ 'motorista-nome': 'Fulano de Teste', 'motorista-sobrenome': 'de Teste' }, 'Fulano de Teste', 'nome contém o sobrenome: o mais longo']
  ];
  for (const [dados, esperado, msg] of casos) {
    r = await enviar(dados);
    ok(r.status === 200 && r.nome === esperado && r.dadosNome === esperado && !r.temSobrenome, `${msg} -> "${esperado}" (sobrenome não fica separado)`, r);
  }
  r = await enviar({ 'motorista-nome': 'Fulano', 'motorista-sobrenome': 'FULANO' });
  ok(r.status === 400 && r.erro === 'Informe o nome completo', 'nome e sobrenome iguais de uma palavra: recusado', r);

  console.log('\n--- Trava de CPF continua igual ---');
  r = await enviar({ 'motorista-nome': 'Fulano de Teste' }, { duplicado: true });
  ok(r.status === 409 && /Já existe um cadastro com este CPF em análise/.test(r.erro), 'CPF já ativo: mesma mensagem de cadastro duplicado', r);

  console.log(falhas ? `\n${falhas} FALHA(S)` : '\nTUDO OK');
  process.exit(falhas ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
