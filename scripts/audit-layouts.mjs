#!/usr/bin/env node
/** Opt-in live layout lab. Only creates/resets its own dedicated test boards. */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

export const MODES = ["tidy", "flow", "LR", "TB", "group", "grid", "timeline", "kanban", "matrix", "swimlane", "cluster"];
const LABELS = ["整齐化", "流程", "横向分层", "纵向分层", "类型分区", "网格", "时间线", "看板", "四象限", "泳道", "子图分簇"];

export function layoutFixture() {
  const types = ["text", "task", "text", "task", "data", "task", "todo", "text", "task", "data", "text", "task", "data", "quote", "task", "data", "todo", "text"];
  const names = ["需求入口", "澄清问题", "调研材料", "方案分支", "实验指标", "汇合评审", "上线清单", "独立项目入口", "实施任务", "项目指标", "第二独立入口", "交付任务", "增长指标", "阅读摘录", "后续任务", "留存指标", "个人待办", "独立笔记"];
  const sizes = [[280,180],[370,200],[220,260],[440,180],[300,250],[550,200],[260,320],[310,190],[700,180],[300,260],[230,170],[410,280],[300,260],[380,180],[320,240],[300,260],[270,210],[460,190]];
  let seed = 20260905, taskIndex = 0;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const cards = types.map((type, i) => {
    const card = { id: `c_lab_${i}`, type, title: `${String(i + 1).padStart(2, "0")} · ${names[i]}`, content: `虚构测试内容。尺寸 ${sizes[i][0]}×${sizes[i][1]}；用于验证布局，不会发起执行。`, x: Math.round(random() * 1500), y: Math.round(random() * 1100), w: sizes[i][0], h: sizes[i][1], z: i+1, color: ["blue","amber","violet","green","rose","slate"][i % 6], createdBy: "agent", createdAt: Date.UTC(2026, 0, 1 + Math.floor(i / 4), 12) };
    if (type === "task") { const n = taskIndex++; card.task = { goal: "布局测试，不发起任务", priority: ["high","low","urgent","medium","none","high"][n], status: ["idea","issued","running","done","idea","done"][n] }; }
    if (type === "data") card.data = { specId: "metric-snapshot", fields: { metric: names[i], value: i * 7, delta: i - 8, period: "虚构统一口径", measuredAt: Date.UTC(2026, 0, 1 + i % 3, 12) } };
    if (type === "todo") card.todo = { items: [{ id: `todo_${i}`, text: "校验间距", done: i % 2 === 0 }, { id: `todo_next_${i}`, text: "查看撤销", done: false }] };
    if (type === "quote") card.quote = { source: "虚构来源" };
    return card;
  });
  cards.push({ id: "c_lab_frame", type: "frame", title: "固定分组框 · 整理不移动", x: 0, y: 0, w: 520, h: 420, z: 0, color: "slate", frame: { collapsed: false }, createdBy: "agent", createdAt: 1 });
  cards.push({ id: "c_lab_fixed", type: "text", title: "框内固定卡 · 必须保持位置", content: "自由卡不应盖住这个固定区域。", x: 50, y: 90, w: 280, h: 180, z: 1, color: "slate", frameId: "c_lab_frame", createdBy: "agent", createdAt: 1 });
  const pairs = [[0,1],[0,2],[1,5],[2,3],[3,4],[4,5],[5,6],[7,8],[8,9],[10,11],[11,12]];
  return { cards, edges: pairs.map(([a,b],i) => ({ id:`e_lab_${i}`,from:`c_lab_${a}`,to:`c_lab_${b}`,kind:"enables",label:"前置",weight:1+i%5 })), viewport: { x: 100, y: 100, zoom: 0.6 } };
}

const intersects = (a,b) => a.x < b.x+b.w-1e-7 && a.x+a.w > b.x+1e-7 && a.y < b.y+b.h-1e-7 && a.y+a.h > b.y+1e-7;
const geometry = (cards) => cards.map(({id,x,y,w,h,frameId}) => ({id,x,y,w,h,frameId})).sort((a,b)=>a.id.localeCompare(b.id));
const semantic = (cards) => cards.map(({x,y,updatedAt,...rest})=>rest).sort((a,b)=>a.id.localeCompare(b.id));
export function assessLayout(before, after, repeated, mode) {
  const frames = new Set(before.cards.filter(c=>c.type==="frame").map(c=>c.id));
  const free = after.cards.filter(c=>c.type!=="frame" && !frames.has(c.frameId));
  const fixed = after.cards.filter(c=>!free.includes(c));
  const overlap=[];
  for(let i=0;i<free.length;i++)for(let j=i+1;j<free.length;j++)if(intersects(free[i],free[j]))overlap.push([free[i].id,free[j].id]);
  const blocked=free.flatMap(a=>fixed.filter(b=>intersects(a,b)).map(b=>[a.id,b.id]));
  const byId=new Map(after.cards.map(c=>[c.id,c]));
  const backwards=["flow","LR","TB"].includes(mode) ? before.edges.filter(e=>{const a=byId.get(e.from),b=byId.get(e.to);return a&&b&&(mode==="TB" ? b.y < a.y+a.h-1e-7 : b.x < a.x+a.w-1e-7);}).length : null;
  const result={mode,cards:free.length,overlapPairs:overlap.length,fixedOverlapPairs:blocked.length,fixedUnchanged:JSON.stringify(geometry(before.cards.filter(c=>c.type==="frame"||frames.has(c.frameId))))===JSON.stringify(geometry(fixed)),semanticsUnchanged:JSON.stringify(semantic(before.cards))===JSON.stringify(semantic(after.cards))&&JSON.stringify(before.edges)===JSON.stringify(after.edges),idempotent:JSON.stringify(geometry(after.cards))===JSON.stringify(geometry(repeated.cards)),finite:after.cards.every(c=>[c.x,c.y].every(n=>Number.isFinite(n)&&Math.abs(n)<=100000)),backwardsEdges:backwards};
  result.ok=!result.overlapPairs&&!result.fixedOverlapPairs&&result.fixedUnchanged&&result.semanticsUnchanged&&result.idempotent&&result.finite&&(backwards===null||backwards===0);
  return result;
}

async function main() {
  const args=process.argv.slice(2), option=(name)=>{const i=args.indexOf(name);return i<0?null:args[i+1];};
  if(!args.includes("--write")) { console.log("只读预览：为11种整理模式创建专用测试板并保留结果。执行需 --write --base <origin> --token-file <file> --out <private-output-directory>；同一out重复运行会复用测试板，拒绝覆盖外部编辑。");return; }
  const base=option("--base"), tokenFile=option("--token-file");
  if(!base||!tokenFile)throw new Error("请显式给出 --base 和 --token-file");
  const origin=new URL(base).origin, token=fs.readFileSync(tokenFile,"utf8").trim();
  const out=path.resolve(option("--out")||fs.mkdtempSync(path.join(os.tmpdir(),"blotboard-layout-lab-")));fs.mkdirSync(out,{recursive:true,mode:0o700});
  const stateFile=path.join(out,"state.json");const state=fs.existsSync(stateFile)?JSON.parse(fs.readFileSync(stateFile,"utf8")):{origin,run:Date.now().toString(36),cases:{}};
  if(state.origin!==origin)throw new Error("输出目录属于另一台部署");
  const save=()=>fs.writeFileSync(stateFile,JSON.stringify(state,null,2),{mode:0o600});
  const api=async(method,route,body)=>{const r=await fetch(origin+route,{method,redirect:"error",headers:{"x-auth-key":token,"content-type":"application/json"},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(30000)});const data=await r.json();if(!r.ok)throw new Error(`${method} ${route}: HTTP ${r.status}`);return data;};
  const health=await api("GET","/api/health");
  if(health.service!=="blotboard")throw new Error("目标不是Blotboard，拒绝创建测试数据");
  const caps=await api("GET","/api/capabilities");
  if(!MODES.every(mode=>caps.layouts?.some(item=>item.mode===mode)))throw new Error("目标部署没有完整的11种整理模式");
  if(!state.root){state.root=(await api("POST","/api/boards",{name:"整理算法实验室 · 11种模式对照",group:"算法审查测试"})).board.id;save();}
  const results=[];
  for(let i=0;i<MODES.length;i++){
    const mode=MODES[i];let record=state.cases[mode];
    if(!record){record={id:(await api("POST","/api/boards",{name:`整理测试 ${String(i+1).padStart(2,"0")} · ${LABELS[i]} (${mode})`,parentId:state.root})).board.id};state.cases[mode]=record;save();}
    const latest=(await api("GET",`/api/boards/${record.id}`)).board;
    if(record.updatedAt&&latest.updatedAt!==record.updatedAt)throw new Error(`测试板 ${mode} 被外部编辑，停止覆盖`);
    const before=(await api("PUT",`/api/boards/${record.id}/whole`,{...latest,...layoutFixture()})).board;
    await api("POST",`/api/boards/${record.id}/tidy`,{mode});const after=(await api("GET",`/api/boards/${record.id}`)).board;
    await api("POST",`/api/boards/${record.id}/tidy`,{mode});const repeated=(await api("GET",`/api/boards/${record.id}`)).board;
    const result=assessLayout(before,after,repeated,mode);record.updatedAt=repeated.updatedAt;record.result=result;save();results.push(result);
    fs.writeFileSync(path.join(out,`${mode}.json`),JSON.stringify({before,after,repeated,result},null,2),{mode:0o600});
    console.log(JSON.stringify(result));
  }
  const current=(await api("GET",`/api/boards/${state.root}`)).board;
  if(state.rootUpdatedAt&&current.updatedAt!==state.rootUpdatedAt)throw new Error("实验室总览被外部编辑，停止覆盖");
  const cards=[{id:"c_lab_intro",type:"text",title:"整理算法实验室 · 11种模式实测",content:"每个子板包含同一组虚构乱序卡：18张异形自由卡、分支/汇合/独立子图与孤卡，以及必须保留的分组框和框内卡。通过真实 API 连续整理两次，验证重叠、固定区、内容保留与稳定性。\n\n点击下方子板查看实际结果；历史面板可用于回看整理前状态。此区域专用于测试，没有修改业务画板。",x:40,y:40,w:1100,h:280,color:"blue"}];
  for(let i=0;i<results.length;i++){const r=results[i];cards.push({id:`c_lab_mode_${i}`,type:"board",title:`${r.ok?"✓":"待修"} ${LABELS[i]}`,content:`自由卡 ${r.cards}；重叠 ${r.overlapPairs}；覆盖固定区 ${r.fixedOverlapPairs}；重复稳定 ${r.idempotent?"是":"否"}；内容完整 ${r.semanticsUnchanged?"是":"否"}`,boardRef:{boardId:state.cases[r.mode].id,name:LABELS[i]},x:40+(i%3)*400,y:380+Math.floor(i/3)*330,w:360,h:290,color:r.ok?"green":"rose"});}
  const rootAfter=(await api("PUT",`/api/boards/${state.root}/whole`,{...current,cards,edges:[],viewport:{x:40,y:40,zoom:0.65}})).board;state.rootUpdatedAt=rootAfter.updatedAt;save();
  fs.writeFileSync(path.join(out,"results.json"),JSON.stringify(results,null,2));console.log(`测试画板：${origin}/?board=${state.root}`);
  if(results.some(r=>!r.ok))process.exitCode=1;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(error.message);process.exitCode=1;});
