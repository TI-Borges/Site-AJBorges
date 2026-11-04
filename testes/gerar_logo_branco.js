// Gera os logos brancos a partir de Imagens/LOGO EM BRANCO_original.png (2324x1573, fundo transparente, só branco).
// Uso (na raiz): node testes/gerar_logo_branco.js   -> Imagens/logo-header-branco-1x/2x.png e logo-brand-branco-1x/2x.png
// Não redesenha nem muda a cor: só acrescenta margem transparente de 3% (a base de "LOGÍSTICA" e a perna do A
// encostam na borda do original) e reduz por média de área (alfa pré-multiplicado). Node puro, sem dependências.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const RAIZ = path.resolve(__dirname, '..');
const ORIGEM = path.join(RAIZ, 'Imagens', 'LOGO EM BRANCO_original.png');
// Tamanhos em que o <img> aparece: header 100px de altura (CSS .logotipo-AJBorges img) e barra lateral 24x16 (.brand-logo)
// margem: 3% da altura em 1x, no mínimo 1px (na barra lateral 3% de 16px daria meio pixel e o traço tocaria a borda); 2x = dobro
const SAIDAS = [
  { nome: 'logo-header-branco-1x.png', altura: 100, margem: 3, reforco: true },
  { nome: 'logo-header-branco-2x.png', altura: 200, margem: 6, reforco: false },
  { nome: 'logo-brand-branco-1x.png', caixa: [24, 16], margem: 1, reforco: true },
  { nome: 'logo-brand-branco-2x.png', caixa: [48, 32], margem: 2, reforco: true },
];

function lerPng(arq) {
  const b = fs.readFileSync(arq); let p = 8, W, H, idat = [];
  while (p < b.length) {
    const n = b.readUInt32BE(p), t = b.toString('ascii', p + 4, p + 8), d = b.slice(p + 8, p + 8 + n);
    if (t === 'IHDR') { W = d.readUInt32BE(0); H = d.readUInt32BE(4); if (d[8] !== 8 || d[9] !== 6 || d[12]) throw new Error('esperado PNG RGBA 8 bits sem entrelaçamento'); }
    if (t === 'IDAT') idat.push(d);
    p += 12 + n;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat)), st = W * 4, px = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) {
    const f = raw[y * (st + 1)], o = y * (st + 1) + 1;
    for (let x = 0; x < st; x++) {
      const v = raw[o + x], a = x >= 4 ? px[y * st + x - 4] : 0, u = y ? px[(y - 1) * st + x] : 0, c = x >= 4 && y ? px[(y - 1) * st + x - 4] : 0;
      let r;
      if (f === 0) r = v; else if (f === 1) r = v + a; else if (f === 2) r = v + u; else if (f === 3) r = v + ((a + u) >> 1);
      else { const q = a + u - c, pa = Math.abs(q - a), pb = Math.abs(q - u), pc = Math.abs(q - c); r = v + (pa <= pb && pa <= pc ? a : pb <= pc ? u : c); }
      px[y * st + x] = r & 255;
    }
  }
  return { W, H, px };
}

const TAB_CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function gravarPng(arq, W, H, px) {
  const crc = b => { let c = 0xffffffff; for (const x of b) c = TAB_CRC[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const bloco = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const raw = Buffer.alloc((W * 4 + 1) * H);
  for (let y = 0; y < H; y++) px.copy(raw, y * (W * 4 + 1) + 1, y * W * 4, (y + 1) * W * 4);
  const ih = Buffer.alloc(13); ih.writeUInt32BE(W, 0); ih.writeUInt32BE(H, 4); ih[8] = 8; ih[9] = 6;
  fs.writeFileSync(arq, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), bloco('IHDR', ih), bloco('IDAT', zlib.deflateSync(raw, { level: 9 })), bloco('IEND', Buffer.alloc(0))]));
}

// Pesos de média de área de um eixo: cada pixel de saída cobre [i*s, (i+1)*s) do eixo de origem (s = origem/saída)
function pesos(nOrig, nSaida, desloc, escala) {
  const lista = [];
  for (let i = 0; i < nSaida; i++) {
    const a = (i - desloc) * escala, b = (i + 1 - desloc) * escala, w = [];
    for (let k = Math.max(0, Math.floor(a)); k < Math.min(nOrig, Math.ceil(b)); k++) {
      const cob = Math.min(b, k + 1) - Math.max(a, k); if (cob > 0) w.push([k, cob / escala]);
    }
    lista.push(w);
  }
  return lista;
}

// Reduz a imagem para caber em WxH menos a margem m, centralizada; alfa pré-multiplicado para não escurecer as bordas
function reduzir(img, W, H, m) {
  const esc = Math.max(img.W / (W - 2 * m), img.H / (H - 2 * m));
  const wx = pesos(img.W, W, (W - img.W / esc) / 2, esc), wy = pesos(img.H, H, (H - img.H / esc) / 2, esc);
  const tmp = new Float64Array(W * img.H * 4);
  for (let y = 0; y < img.H; y++) for (let x = 0; x < W; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (const [k, w] of wx[x]) { const i = (y * img.W + k) * 4, al = img.px[i + 3] / 255 * w; r += img.px[i] * al; g += img.px[i + 1] * al; b += img.px[i + 2] * al; a += al; }
    const j = (y * W + x) * 4; tmp[j] = r; tmp[j + 1] = g; tmp[j + 2] = b; tmp[j + 3] = a;
  }
  const out = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (const [k, w] of wy[y]) { const j = (k * W + x) * 4; r += tmp[j] * w; g += tmp[j + 1] * w; b += tmp[j + 2] * w; a += tmp[j + 3] * w; }
    const o = (y * W + x) * 4;
    if (a > 0) { out[o] = Math.round(r / a); out[o + 1] = Math.round(g / a); out[o + 2] = Math.round(b / a); }
    out[o + 3] = Math.round(Math.min(1, a) * 255);
  }
  return out;
}

const orig = lerPng(ORIGEM);
console.log(`original ${orig.W}x${orig.H}`);

for (const s of SAIDAS) {
  const [W, H] = s.caixa || [Math.round(orig.W * (s.altura - 2 * s.margem) / orig.H) + 2 * s.margem, s.altura];
  const px = reduzir(orig, W, H, s.margem);
  // Reforça o alfa dos traços finos (perna do A de "LOGÍSTICA" não fica translúcida sobre o azul); a cor continua branca
  if (s.reforco) for (let i = 3; i < px.length; i += 4) px[i] = Math.round((1 - Math.pow(1 - px[i] / 255, 1.6)) * 255);
  gravarPng(path.join(RAIZ, 'Imagens', s.nome), W, H, px);
  console.log(`${s.nome} ${W}x${H} (margem ${s.margem}px)`);
}
