/**
 * Collect the read-mode empirical dataset for the Educational Accessibility paper, from the live article:
 * https://artaquest.com/research/?journal=seasonality&submission=9 — measures the reading typography
 * (prose body, hierarchy, links, etc.) per APCA Lc on the real background, both themes, + screenshots.
 * Writes analysis/reading-experiment/paper/data/readmode-<theme>.json + figures/.
 */
import { writeFileSync, mkdirSync } from "node:fs";
const PW="/Users/arash/.artaquest-dev/playwright-suite/node_modules/playwright/index.mjs";
const URL_="https://artaquest.com/research/?journal=seasonality&submission=9";
const DATA=new URL("../analysis/reading-experiment/paper/data/",import.meta.url).pathname;
const FIG=new URL("../analysis/reading-experiment/paper/figures/",import.meta.url).pathname;
mkdirSync(DATA,{recursive:true}); mkdirSync(FIG,{recursive:true});

function collect(){
  const sx=c=>Math.pow(c/255,2.4),aY=a=>0.2126729*sx(a[0])+0.7151522*sx(a[1])+0.072175*sx(a[2]),clB=y=>y>=0.022?y:y+Math.pow(0.022-y,1.414);
  const lc=(t,b)=>{const Yt=clB(aY(t)),Yb=clB(aY(b));if(Math.abs(Yb-Yt)<5e-4)return 0;let S,o;if(Yb>Yt){S=(Math.pow(Yb,.56)-Math.pow(Yt,.57))*1.14;o=S<.1?0:S-.027;}else{S=(Math.pow(Yb,.65)-Math.pow(Yt,.62))*1.14;o=S>-.1?0:S+.027;}return Math.abs(o*100);};
  const par=s=>{const m=(s||"").match(/rgba?\(([^)]+)\)/i);if(!m)return[0,0,0];const x=m[1].split(",").map(Number);return[x[0]|0,x[1]|0,x[2]|0];};
  const bgOf=el=>{let n=el;while(n&&n!==document.documentElement){const m=(getComputedStyle(n).backgroundColor||"").match(/rgba?\(([^)]+)\)/i);if(m){const x=m[1].split(",").map(Number);if(x[3]===undefined||x[3]>.05)return[x[0]|0,x[1]|0,x[2]|0];}n=n.parentElement;}return par(getComputedStyle(document.body).backgroundColor);};
  const px=s=>parseFloat(s)||0;
  const cv=document.createElement("canvas").getContext("2d");
  const measure=el=>{const cs=getComputedStyle(el);cv.font=`${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;const w=cv.measureText("abcdefghijklmnopqrstuvwxyz ".repeat(2)).width/54;return w?Math.round(el.clientWidth/w):null;};
  const hex=a=>"#"+a.map(v=>(v|0).toString(16).padStart(2,"0")).join("");
  const info=el=>{if(!el)return null;const cs=getComputedStyle(el),fg=par(cs.color),bg=bgOf(el);return{px:+px(cs.fontSize).toFixed(1),weight:+cs.fontWeight,lineHeight:+(px(cs.lineHeight)/px(cs.fontSize)).toFixed(2),color:hex(fg),bg:hex(bg),lc:+lc(fg,bg).toFixed(1),measure:measure(el),text:(el.textContent||"").trim().slice(0,46)};};
  const bad=el=>el.closest("table,thead,tbody,tr,aside,nav,figure,pre,code,header,footer,.aq-read-abstract");
  const proses=[...document.querySelectorAll("p")].filter(p=>(p.textContent||"").trim().length>180&&!bad(p));
  const pick=s=>[...document.querySelectorAll(s)].filter(e=>(e.textContent||"").trim().length>2)[0];
  const r=document.documentElement;
  return {theme:r.getAttribute("data-theme"),contrast:r.getAttribute("data-contrast"),
    prose: proses.slice(0,3).map(info),
    h1:info(pick("h1")), lead:info(pick(".aq-read-abstract p, .lead")),
    h2:info([...document.querySelectorAll("h2")].find(h=>px(getComputedStyle(h).fontSize)>=18)),
    h3:info([...document.querySelectorAll("h3")].find(h=>px(getComputedStyle(h).fontSize)>=16)),
    link:info(pick("article a[href^='#'], .aq-article-body a, main a")),
    blockquote:info(pick("blockquote")), figcaption:info(pick("figcaption")),
    table:info(pick("td")), code:info(pick("code, pre")),
    reference:info(pick("li[id^=ref-], #references li")),
    columnWidthPx: proses[0]?proses[0].clientWidth:null, paragraphCount:proses.length,
    docHeight:r.scrollHeight, sections:document.querySelectorAll("h1,h2,h3").length};
}

const {chromium}=await import(PW);
const b=await chromium.connectOverCDP("http://127.0.0.1:9222");
const ctx=b.contexts()[0]; const p=await ctx.newPage(); await p.setViewportSize({width:1280,height:900});
await p.goto("https://artaquest.com/",{waitUntil:"domcontentloaded"});
for(const theme of ["dark","light"]){
  await p.evaluate(t=>{localStorage.setItem("aq_theme",t);localStorage.setItem("aq_contrast","3");localStorage.setItem("ay_lang","en");},theme);
  await p.goto(URL_,{waitUntil:"domcontentloaded"}); await p.waitForTimeout(3800);
  const d=await p.evaluate(collect);
  writeFileSync(DATA+`readmode-${theme}.json`,JSON.stringify({url:URL_,collected:"paper-data",...d},null,1));
  await p.evaluate(()=>window.scrollTo(0,0)); await p.waitForTimeout(400);
  await p.screenshot({path:FIG+`article_${theme}_top.png`,fullPage:false});
  const body=d.prose[0];
  console.log(`[${theme}] body ${body.px}px lh${body.lineHeight} Lc${body.lc} measure${body.measure}ch col${d.columnWidthPx}px | h1 ${d.h1?.px}px Lc${d.h1?.lc} | link Lc${d.link?.lc}(${d.link?.color}) | ${d.sections} sections, ${d.docHeight}px`);
}
await p.close();await b.close();
console.log("→ wrote paper/data/readmode-{dark,light}.json + paper/figures/");
