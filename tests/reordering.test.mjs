import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const output = ts.transpileModule(readFileSync(new URL("../lib/steps/reordering.ts", import.meta.url), "utf8"), {
  compilerOptions: {module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020},
}).outputText;
const context = vm.createContext({exports:{}}); vm.runInContext(output,context);
const {insertionAt,destinationForSlot,moveToPosition} = context.exports;
const rows=[{top:100,bottom:200,left:0,right:600},{top:200,bottom:500,left:0,right:600},{top:500,bottom:700,left:0,right:600}];
const list={top:100,bottom:700,left:0,right:600};

for(const [y,slot,top] of [[100,0,0],[160,1,100],[250,1,100],[400,2,400],[550,2,400],[690,3,600]]) {
  test(`insertion uses measured variable-height row boundaries at y=${y}`,()=>{
    const result=insertionAt({x:100,y},list,rows); assert.equal(result.slot,slot); assert.equal(result.top,top);
  });
}

test("outside-list cancellation and empty lists have no insertion target",()=>{
  for(const point of [{x:-1,y:200},{x:601,y:200},{x:100,y:99},{x:100,y:701},{x:NaN,y:200},{x:100,y:Infinity}]) assert.equal(insertionAt(point,list,rows),null);
  assert.equal(insertionAt({x:100,y:200},list,[]),null);
});

test("scroll-adjusted geometry keeps the line on the real boundary",()=>{
  const scrolledRows=rows.map(row=>({...row,top:row.top-300,bottom:row.bottom-300}));
  const target=insertionAt({x:100,y:250},{...list,top:list.top-300,bottom:list.bottom-300},scrolledRows);
  assert.equal(target.slot,2); assert.equal(target.top,400);
});

test("gap-to-destination conversion handles source removal in both directions",()=>{
  const ids=["a","b","c"];
  assert.equal(destinationForSlot(ids,"c",0),1);
  assert.equal(destinationForSlot(ids,"a",3),3);
  assert.equal(destinationForSlot(ids,"b",3),3);
  assert.equal(destinationForSlot(ids,"b",0),1);
  assert.equal(destinationForSlot(ids,"b",1),2);
  assert.equal(destinationForSlot(ids,"b",2),2);
  assert.equal(destinationForSlot(ids,"unknown",0),null);
  assert.equal(destinationForSlot(ids,"a",4),null);
});

test("optimistic moves keep stable UUIDs/content and never mutate confirmed data",()=>{
  const steps=["a","b","c"].map((id,i)=>({id,step_order:i+1,name:id,prompt_template:`  ${id}\n`}));
  const before=structuredClone(steps); const next=moveToPosition(steps,"c",1);
  assert.deepEqual(Array.from(next,step=>step.id),["c","a","b"]);
  assert.deepEqual(Array.from(next,step=>step.step_order),[1,2,3]);
  assert.deepEqual(steps,before);
  for(const step of next) assert.equal(step.prompt_template,steps.find(original=>original.id===step.id).prompt_template);
  assert.equal(moveToPosition(steps,"b",2),steps);
  assert.equal(moveToPosition(steps,"unknown",1),steps);
});

test("the actual drag list supports server rendering with accessible rail controls",async()=>{
  const React=await import("react");
  const jsx=await import("react/jsx-runtime");
  const {renderToString}=await import("react-dom/server");
  const dnd=await import("@dnd-kit/react");
  const dom=await import("@dnd-kit/dom");
  function load(path,imports={}) {
    const code=ts.transpileModule(readFileSync(new URL(`../${path}`,import.meta.url),"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,jsx:ts.JsxEmit.ReactJSX}}).outputText;
    const testModule={exports:{}};
    vm.runInNewContext(`(function(require,module,exports){${code}\n})`)(name=>{assert.ok(Object.hasOwn(imports,name),name);return imports[name];},testModule,testModule.exports);
    return testModule.exports;
  }
  const chainModel=load("lib/chains/model.ts");
  const model=load("lib/steps/model.ts",{"@/lib/chains/model":chainModel});
  const controls=load("components/steps/step-move-controls.tsx",{"react/jsx-runtime":jsx});
  const list=load("components/steps/step-reorder-list.tsx",{
    react:React,"react/jsx-runtime":jsx,"next/link":{default:props=>React.createElement("a",{href:props.href,className:props.className},props.children)},
    "@dnd-kit/react":dnd,"@dnd-kit/dom":dom,"@/lib/steps/model":model,"@/lib/steps/reordering":context.exports,
    "./step-move-controls":controls,"@/app/(protected)/chains/[id]/steps/actions":{moveStep(){},reorderStep(){}},
    "@/components/chains/chain-success-notice":{useDismissChainSuccess:()=>()=>{}},
  }).default;
  const html=renderToString(React.createElement(list,{chainId:"chain",steps:[{id:"stable-uuid",name:"Generate joke",prompt_template:"Literal text",step_order:1}]}));
  assert.match(html,/Move Generate joke up/);assert.match(html,/Move Generate joke down/);assert.match(html,/Drag Generate joke to reorder/);
  assert.equal((html.match(/<circle/g)||[]).length,6);
  assert.match(html,/data-step-row="stable-uuid"/);
});
