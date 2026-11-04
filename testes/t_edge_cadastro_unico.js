// Edge function solicitar-cadastro com o trigger do passo25 simulado no banco em memória: o CPF do motorista
// (PF ou PJ) e o CNPJ (PJ) só têm um cadastro ativo (não recusado). Nada vai para o banco nem para o bucket.
// Só dados inventados (CPFs de teste gerados aqui, nomes "de Teste").
// Uso: node testes/t_edge_cadastro_unico.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const RAIZ = process.env.RAIZ || path.resolve(__dirname, '..');

// CPF válido a partir de 9 dígitos
function cpfDe(base) {
  const dig = (s, p) => { let t = 0; for (let i = 0; i < s.length; i++) t += Number(s[i]) * (p - i); const r = (t * 10) % 11; return r === 10 ? 0 : r; };
  const d1 = dig(base, 10);
  return base + d1 + dig(base + d1, 11);
}
const CPF_A = cpfDe('523169159'); // 52316915930
const CPF_B = cpfDe('111444777');
const CPF_C = cpfDe('333666999');
const formatar = (c) => c.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');

async function carregarEdge() {
  let src = fs.readFileSync(path.join(RAIZ, 'supabase/functions/solicitar-cadastro/index.ts'), 'utf8');
  src = src.replace(/^import \{ createClient \} from "npm:@supabase\/supabase-js@2";$/m,
    'const createClient = (...a: unknown[]) => (globalThis as any).__criarCliente(...a);');
  const arq = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'edge-unico-')), 'index.ts');
  fs.writeFileSync(arq, src);
  let handler = null;
  globalThis.Deno = {
    env: { get: (k) => ({ SUPABASE_URL: 'https://teste.invalid', SUPABASE_SERVICE_ROLE_KEY: 'chave-teste', LOGIN_PEPPER: 'pepper-teste' })[k] },
    serve: (fn) => { handler = fn; }
  };
  globalThis.__banco = { cadastros: [], urls: [], selects: 0, falharInsert: null };
  // O mesmo que public.cadastro_agregado_unico() faz no insert: CPF do motorista em qualquer tipo,
  // depois o CNPJ entre PJ. Devolve 'CPF', 'CNPJ' ou null
  const dig = (v) => String(v || '').replace(/\D/g, '');
  const cnpjDe = (l) => (l.tipo === 'pj' ? dig((l.dados || {}).cnpj) : '');
  const duplicado = (nova) => {
    if (nova.status === 'recusado') return null;
    const ativos = globalThis.__banco.cadastros.filter((l) => l.status !== 'recusado');
    if (dig(nova.cpf) && ativos.some((l) => dig(l.cpf) === dig(nova.cpf))) return 'CPF';
    if (cnpjDe(nova) && ativos.some((l) => cnpjDe(l) === cnpjDe(nova))) return 'CNPJ';
    return null;
  };
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
          if (banco.falharInsert) return { data: null, error: banco.falharInsert };
          const doc = duplicado(q.valores);
          if (doc) {
            return { data: null, error: { code: '23505', message: `cadastro_duplicado: já existe um cadastro ativo com este ${doc}`, details: null, hint: null } };
          }
          const linha = { id: `cad-teste-${banco.cadastros.length + 1}`, ...q.valores };
          banco.cadastros.push(linha);
          return { data: { id: linha.id }, error: null };
        }
        const linhas = banco.cadastros.filter(casa);
        if (q.op === 'update') { linhas.forEach((l) => Object.assign(l, q.valores)); return { data: uma ? (linhas[0] ? { id: linhas[0].id } : null) : linhas, error: null }; }
        if (q.op === 'delete') { banco.cadastros = banco.cadastros.filter((l) => !casa(l)); return { data: uma ? linhas[0] || null : linhas, error: null }; }
        banco.selects++;
        return { data: uma ? linhas[0] || null : linhas, error: null };
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

function corpo(tipo, cpf, nome, cnpj) {
  const pdf = (n) => ({ nome: n, tipo: 'application/pdf', tamanho: 2048 });
  return {
    tipo, tipologia: 'Toco (4×2)', email: null, aceite_lgpd: true, versao_politica: '2026-10-19',
    dados: {
      'motorista-nome': nome, 'motorista-sobrenome': 'de Teste', cpf, celular: '(11) 90000-0000',
      'rastreador-marca': 'Sascar', 'rastreador-id': 'TESTE-000123',
      ...(tipo === 'pj' ? { 'nome-empresa': 'Empresa de Teste', cnpj, 'telefone-empresa': '(11) 3000-0000', responsavel: 'Responsável de Teste' } : {})
    },
    documentos: { cnh: [pdf('cnh.pdf')], selfie: [{ nome: 'selfie.jpg', tipo: 'image/jpeg', tamanho: 4096 }], crlv_1: [pdf('crlv.pdf')], rntrc: [pdf('rntrc.pdf')] }
  };
}

const MSG_CPF = 'Já existe um cadastro com este CPF em análise. Aguarde o retorno da nossa equipe ou fale com a gente pelo WhatsApp (14) 99858-4705.';
const MSG_CNPJ = 'Já existe um cadastro com este CNPJ em análise. Aguarde o retorno da nossa equipe ou fale com a gente pelo WhatsApp (14) 99858-4705.';

(async () => {
  const handler = await carregarEdge();
  const banco = globalThis.__banco;
  const enviar = async (c) => {
    const antes = { cadastros: banco.cadastros.length, urls: banco.urls.length };
    const req = new Request('https://teste.invalid/functions/v1/solicitar-cadastro', { method: 'POST', body: JSON.stringify(c), headers: { 'content-type': 'application/json' } });
    const r = await handler(req);
    const texto = await r.text();
    const json = JSON.parse(texto);
    return { status: r.status, erro: json.erro, texto, uploads: (json.uploads || []).length,
      novosCadastros: banco.cadastros.length - antes.cadastros, novasUrls: banco.urls.length - antes.urls };
  };

  const r = {};
  const res = {};
  res.primeiro = await enviar(corpo('pf', formatar(CPF_A), 'Fulano'));
  res.segundo = await enviar(corpo('pf', formatar(CPF_A), 'Outro Nome'));
  res.semPontuacao = await enviar(corpo('pf', CPF_A, 'Fulano'));
  res.comEspacos = await enviar(corpo('pf', ` ${CPF_A.slice(0, 3)} ${CPF_A.slice(3, 6)} ${CPF_A.slice(6, 9)} ${CPF_A.slice(9)} `, 'Fulano'));
  // A gestão recusa o primeiro: a pessoa pode enviar de novo
  banco.cadastros[0].status = 'recusado';
  res.depoisDeRecusar = await enviar(corpo('pf', CPF_A, 'Fulano'));
  res.deNovoComONovoAtivo = await enviar(corpo('pf', formatar(CPF_A), 'Fulano'));
  // PJ: a regra é o CNPJ
  res.pjPrimeiro = await enviar(corpo('pj', formatar(CPF_B), 'Ciclano', '11.222.333/0001-81'));
  res.pjMesmoCnpj = await enviar(corpo('pj', formatar(CPF_C), 'Beltrano', '11222333000181'));
  // O CPF do motorista vale em qualquer tipo: outra empresa com o mesmo motorista é bloqueada,
  // e um PF ativo bloqueia uma PJ com o mesmo CPF de motorista
  res.pjOutroCnpjMesmoMotorista = await enviar(corpo('pj', formatar(CPF_B), 'Ciclano', '11.222.333/0002-62'));
  res.pjComCpfDeUmPf = await enviar(corpo('pj', CPF_A, 'Fulano', '44.555.666/0001-77'));
  res.pfComCpfDoMotoristaDaPj = await enviar(corpo('pf', CPF_B, 'Ciclano'));
  res.pjCpfECnpjNovos = await enviar(corpo('pj', formatar(CPF_C), 'Beltrano', '44.555.666/0001-77'));
  // Outro erro do banco: não vira a mensagem de duplicado
  banco.falharInsert = { code: 'XX000', message: 'falha simulada' };
  res.outroErroDoBanco = await enviar(corpo('pf', cpfDe('222555888'), 'Fulano'));
  banco.falharInsert = { code: '23505', message: 'duplicate key value violates unique constraint "outra"' };
  res.unicoQueNaoEDoTrigger = await enviar(corpo('pf', cpfDe('222555889'), 'Fulano'));
  banco.falharInsert = null;

  for (const [k, v] of Object.entries(res)) r[k] = `${v.status} ${v.erro || 'ok'} | uploads=${v.uploads} cadastros+${v.novosCadastros} urls+${v.novasUrls}`;
  const bloqueado = (v, msg) => v.status === 409 && v.erro === msg && v.uploads === 0 && v.novosCadastros === 0 && v.novasUrls === 0;
  const aceito = (v) => v.status === 200 && v.novosCadastros === 1 && v.uploads === 4;
  // A resposta do bloqueio não traz nada do cadastro existente (nome, CPF, id, situação)
  const vaza = (v) => /Fulano|Ciclano|Beltrano|cad-teste|pendente|recusado|aprovado/i.test(v.texto) || v.texto.includes(CPF_A) || v.texto.includes(CPF_A.slice(0, 3) + '.');
  r.semConsultaAntesDoInsert = banco.selects === 0;
  const ok = aceito(res.primeiro) && bloqueado(res.segundo, MSG_CPF) && bloqueado(res.semPontuacao, MSG_CPF) &&
    bloqueado(res.comEspacos, MSG_CPF) && aceito(res.depoisDeRecusar) && bloqueado(res.deNovoComONovoAtivo, MSG_CPF) &&
    aceito(res.pjPrimeiro) && bloqueado(res.pjMesmoCnpj, MSG_CNPJ) && bloqueado(res.pjOutroCnpjMesmoMotorista, MSG_CPF) &&
    bloqueado(res.pjComCpfDeUmPf, MSG_CPF) && bloqueado(res.pfComCpfDoMotoristaDaPj, MSG_CPF) && aceito(res.pjCpfECnpjNovos) &&
    res.outroErroDoBanco.status === 503 && res.outroErroDoBanco.erro !== MSG_CPF &&
    res.unicoQueNaoEDoTrigger.status === 503 && res.unicoQueNaoEDoTrigger.erro !== MSG_CPF &&
    ![res.segundo, res.semPontuacao, res.comEspacos, res.deNovoComONovoAtivo, res.pjMesmoCnpj].some(vaza) &&
    r.semConsultaAntesDoInsert;
  console.log(JSON.stringify(r, null, 2));
  console.log(ok ? 'OK' : 'FALHOU');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
