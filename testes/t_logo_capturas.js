// Prints do logo (header público e barra lateral) em 1366 e 390 px, para comparar antes/depois.
// Uso: node testes/t_logo_capturas.js <sufixo>   -> testes/capturas/logo_<sufixo>_<largura>.png e sidebar_<sufixo>_<largura>.png
// Também mede quantos pixels do logo o border-radius do <img> corta (canto onde fica o pé do A de "LOGÍSTICA").
const path = require('path');
const { abrir } = require('./harness');
const SUF = process.argv[2] || 'atual';
const CAP = path.join(__dirname, 'capturas');

(async () => {
  const { srv, base, browser, page } = await abrir({});
  for (const largura of [1366, 390]) {
    await page.setViewport({ width: largura, height: 800 });
    await page.goto(`${base}/HTML/Login.html`, { waitUntil: 'load' });
    const caixa = await page.$eval('.logotipo-AJBorges img', i => { const r = i.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
    // Pixels do logo que o border-radius esconde: compara o desenho com e sem o arredondamento
    const corte = await page.evaluate(async () => {
      const img = document.querySelector('.logotipo-AJBorges img');
      const raio = parseFloat(getComputedStyle(img).borderTopLeftRadius) || 0;
      const w = Math.round(img.getBoundingClientRect().width), h = Math.round(img.getBoundingClientRect().height);
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const x = c.getContext('2d'); x.imageSmoothingQuality = 'high'; x.drawImage(img, 0, 0, w, h);
      const d = x.getImageData(0, 0, w, h).data; let cortados = 0, alfaCortado = 0;
      for (let py = 0; py < h; py++) for (let px = 0; px < w; px++) {
        const cx = px < raio ? raio : px > w - raio ? w - raio : px, cy = py < raio ? raio : py > h - raio ? h - raio : py;
        if ((px + 0.5 - cx) ** 2 + (py + 0.5 - cy) ** 2 > raio * raio) { const a = d[(py * w + px) * 4 + 3]; if (a > 0) { cortados++; alfaCortado += a; } }
      }
      return { raio, src: img.currentSrc.split('/').pop(), cortados, alfa: Math.round(alfaCortado / 255) };
    });
    console.log(`${largura}px header: ${corte.src} ${Math.round(caixa.w)}x${Math.round(caixa.h)} border-radius=${corte.raio}px pixels do desenho cortados=${corte.cortados} (área ~${corte.alfa})`);
    await page.screenshot({ path: path.join(CAP, `logo_${SUF}_${largura}.png`), clip: { x: 0, y: 0, width: largura, height: largura === 390 ? 240 : 112 } });
    // Zoom de 4x só no logo, para ver o A de "LOGÍSTICA"
    await page.setViewport({ width: largura, height: 800, deviceScaleFactor: 4 });
    await page.goto(`${base}/HTML/Login.html`, { waitUntil: 'load' });
    await (await page.$('.logotipo-AJBorges img')).screenshot({ path: path.join(CAP, `logo_${SUF}_${largura}_zoom.png`) });
    await page.setViewport({ width: largura, height: 800, deviceScaleFactor: 1 });
    // Barra lateral (dashboard-admin) — no celular abre a gaveta
    {
      await page.goto(`${base}/HTML/dashboard-admin.html`, { waitUntil: 'load' });
      await page.evaluate(() => { localStorage.setItem('teste_usuario', JSON.stringify({ role: 'admin', nome: 'Admin Teste', id: 'a1' })); });
      await page.goto(`${base}/HTML/dashboard-admin.html`, { waitUntil: 'load' });
      await new Promise(r => setTimeout(r, 400));
      if (largura < 900) await page.evaluate(() => { const b = document.getElementById('btn-mobile-menu'); if (b) b.click(); });
      await new Promise(r => setTimeout(r, 400));
      const marca = await page.$('.ajb-sidebar .sidebar-brand') || await page.$('.ajb-sidebar .brand-logo-wrapper');
      const info = await page.$eval('.ajb-sidebar .brand-logo', i => `${i.currentSrc.split('/').pop()} ${Math.round(i.getBoundingClientRect().width)}x${Math.round(i.getBoundingClientRect().height)}`).catch(() => 'sem logo');
      console.log(`${largura}px barra lateral: ${info}`);
      await page.setViewport({ width: largura, height: 800, deviceScaleFactor: 3 });
      await new Promise(r => setTimeout(r, 300));
      if (marca) await marca.screenshot({ path: path.join(CAP, `sidebar_${SUF}_${largura}.png`) }).catch(e => console.log('sidebar sem print:', e.message));
      await page.setViewport({ width: largura, height: 800, deviceScaleFactor: 1 });
    }
  }
  await browser.close(); srv.close();
})().catch(e => { console.error(e); process.exit(1); });
