// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useSharedDailyPlan } from "./useSharedDailyPlan";
const mock=vi.hoisted(()=>({invoke:vi.fn()}));
vi.mock("../lib/bridge",()=>({isTauri:()=>true}));
vi.mock("@tauri-apps/api/core",()=>({invoke:mock.invoke}));
const basis={localDate:"2026-09-15",anchorAt:"2026-09-14T16:00:00.000Z",resetsAt:"2026-09-18T16:00:00.000Z",remainingPercent:80};
beforeEach(()=>{const items=new Map<string,string>();vi.stubGlobal("localStorage",{getItem:(k:string)=>items.get(k)??null,setItem:(k:string,v:string)=>items.set(k,v)});mock.invoke.mockReset();});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
it("keeps edits per person and sends the expected space and field revision",async()=>{
  const plan={basis,people:{alex:{value:10,revision:2},blair:{value:10,revision:1}},risk:{value:null,revision:0}};
  mock.invoke.mockImplementation(async(command,args)=>{
    if(command==="get_cloud_sync_status")return{config:{enabled:true,spaceId:"space-a",deviceId:"mac"}};
    const c=args.body.change;
    if(c){expect(args.body.spaceId).toBe("space-a");expect(c.expectedRevision).toBe(2);plan.people.alex={value:c.value,revision:3};}
    return{plan:structuredClone(plan)};
  });
  const {result}=renderHook(()=>useSharedDailyPlan(basis));
  await waitFor(()=>expect(result.current.plan).not.toBeNull());
  act(()=>result.current.change("person",12,"alex"));
  expect(result.current.plan?.people.blair.value).toBe(10);
  expect(result.current.pending).toBe(true);
  await waitFor(()=>expect(result.current.pending).toBe(false));
  expect(result.current.plan?.people.alex.value).toBe(12);
});
it("retains a conflicting draft and reports it instead of silently replacing it",async()=>{
  mock.invoke.mockImplementation(async(command,args)=>{
    if(command==="get_cloud_sync_status")return{config:{enabled:true,spaceId:"space-a",deviceId:"mac"}};
    if(args.body.change)throw new Error("cloud_plan_conflict");
    return{plan:{basis,people:{},risk:{value:null,revision:0}}};
  });
  const {result}=renderHook(()=>useSharedDailyPlan(basis));
  await waitFor(()=>expect(result.current.plan).not.toBeNull());
  act(()=>result.current.change("person",12,"alex"));
  await waitFor(()=>expect(result.current.error).toBe(true));
  expect(result.current.pending).toBe(true);
  expect(result.current.plan?.people.alex.value).toBe(12);
});
it("does not reuse yesterday's pending edits",async()=>{
  localStorage.setItem(`cockpit-plan-v1:space-a:2026-09-14:${basis.resetsAt}`,JSON.stringify({plan:{basis},pending:[{kind:"risk",value:99,expectedRevision:0}]}));
  mock.invoke.mockImplementation(async(command)=>command==="get_cloud_sync_status"?{config:{enabled:true,spaceId:"space-a",deviceId:"mac"}}:{plan:{basis,people:{},risk:{value:null,revision:0}}});
  const {result}=renderHook(()=>useSharedDailyPlan(basis));
  await waitFor(()=>expect(result.current.plan).not.toBeNull());
  expect(result.current.pending).toBe(false);
  expect(mock.invoke.mock.calls.some(([,args])=>args?.body?.change)).toBe(false);
});
