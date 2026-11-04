// Gera os logos prateados transparentes a partir de Imagens/logo-variacao-prata-platina.png (fundo opaco #3d3d90).
// Uso (na raiz): node testes/gerar_logo_prata.js . Imagens   -> logo-header-prata-1x/2x.png e logo-brand-prata-1x/2x.png
const path=require('path'),fs=require('fs');process.chdir(process.argv[2]);const SAIDA=process.argv[3];
const { abrir } = require(path.resolve('testes/harness.js'));
(async()=>{
 const {srv,base,browser,page}=await abrir();
 await page.goto(base+'/HTML/politica-privacidade.html');
 const r=await page.evaluate(async()=>{
  const img=new Image();img.src='/Imagens/logo-variacao-prata-platina.png';await img.decode();
  const W=img.naturalWidth,H=img.naturalHeight;const c=document.createElement('canvas');c.width=W;c.height=H;const x=c.getContext('2d');x.drawImage(img,0,0);
  const id=x.getImageData(0,0,W,H),d=id.data;const BG=[61,61,144];
  // caixa do desenho (pixels claros) + folga de 4px: fora dela é fundo (tira as linhas claras da borda do arquivo)
  let x0=W,y0=H,x1=0,y1=0;for(let y=0;y<H;y++)for(let X=0;X<W;X++){if(d[(y*W+X)*4]>150){x0=Math.min(x0,X);x1=Math.max(x1,X);y0=Math.min(y0,y);y1=Math.max(y1,y);}}
  x0-=4;y0-=4;x1+=4;y1+=4;
  for(let y=0;y<H;y++)for(let X=0;X<W;X++){const i=(y*W+X)*4;
   if(X<x0||X>x1||y<y0||y>y1){d[i+3]=0;continue;}
   // alfa pela "azulidade": fundo tem B-R=83, a prata tem B-R~15 (independe do brilho da faceta)
   const dif=d[i+2]-d[i];let a=(83-dif)/68;a=Math.max(0,Math.min(1,a));
   if(a<0.04){d[i+3]=0;continue;}
   for(let k=0;k<3;k++){d[i+k]=Math.max(0,Math.min(255,Math.round((d[i+k]-(1-a)*BG[k])/a)));}
   d[i+3]=Math.round(a*255);}
  x.putImageData(id,0,0);
  // recorta a caixa real (alfa>0)
  let a0=W,b0=H,a1=0,b1=0;for(let y=0;y<H;y++)for(let X=0;X<W;X++){if(d[(y*W+X)*4+3]>0){a0=Math.min(a0,X);a1=Math.max(a1,X);b0=Math.min(b0,y);b1=Math.max(b1,y);}}
  const cw=a1-a0+1,ch=b1-b0+1;
  function gerar(altura){
   // margem de 3% da altura em volta (nada encosta na borda do arquivo)
   const m=Math.round(altura*0.03);const hc=altura-2*m;const wc=Math.round(cw*hc/ch);const w=wc+2*m;
   // reduz em etapas de 1/2 para não perder os traços finos (perna do A)
   let src=document.createElement('canvas');src.width=cw;src.height=ch;src.getContext('2d').drawImage(c,a0,b0,cw,ch,0,0,cw,ch);
   while(src.height/2>hc){const t=document.createElement('canvas');t.width=Math.round(src.width/2);t.height=Math.round(src.height/2);const tx=t.getContext('2d');tx.imageSmoothingQuality='high';tx.drawImage(src,0,0,t.width,t.height);src=t;}
   const o=document.createElement('canvas');o.width=w;o.height=altura;const ox=o.getContext('2d');ox.imageSmoothingQuality='high';ox.drawImage(src,0,0,src.width,src.height,m,m,wc,hc);
   // 1x (até 100px): reforça o alfa dos traços finos (perna do A de LOGÍSTICA não fica translúcida)
   if(altura<=100){const od=ox.getImageData(0,0,w,altura),p=od.data;for(let i=3;i<p.length;i+=4){const a=p[i]/255;p[i]=Math.round((1-Math.pow(1-a,1.6))*255);}ox.putImageData(od,0,0);}
   return {w,h:altura,url:o.toDataURL('image/png')};}
  return {caixa:[a0,b0,cw,ch],h100:gerar(100),h200:gerar(200),h16:gerar(16),h32:gerar(32),h48:gerar(48)};
 });
 console.log('caixa',r.caixa);
 for(const [k,nome] of [['h100','logo-header-prata-1x.png'],['h200','logo-header-prata-2x.png'],['h16','logo-brand-prata-1x.png'],['h32','logo-brand-prata-2x.png']]){fs.writeFileSync(path.join(SAIDA,nome),Buffer.from(r[k].url.split(',')[1],'base64'));console.log(nome,r[k].w+'x'+r[k].h);}
 await browser.close();srv.close();
})();
