import { useCallback, useEffect, useRef, useState } from "react";
import { isTauri } from "../lib/bridge";
import type { SharedDailyPlan, SharedPlanBasis } from "../lib/sharedDailyPlan";
type Change = { kind: "person" | "risk"; personId?: string; value: number | null; expectedRevision: number };
interface Cache { plan: SharedDailyPlan | null; pending: Change[]; blocked?: boolean }
export function useSharedDailyPlan(basis: SharedPlanBasis | null, initialRisk: number | null = null) {
  const [scope, setScope] = useState<{spaceId:string;deviceId:string} | null>(null);
  const [scopeReady, setScopeReady] = useState(() => !isTauri());
  const [cache, setCache] = useState<Cache>({plan:null,pending:[]});
  const [error, setError] = useState(false);
  const latest = useRef({basis,cache}); latest.current={basis,cache};
  const busy = useRef(false);
  const editTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(()=>()=>{if(editTimer.current)clearTimeout(editTimer.current);},[]);
  const key = scope && basis ? `cockpit-plan-v1:${scope.spaceId}:${basis.localDate}:${basis.resetsAt}` : null;
  const activeKey = useRef(key); activeKey.current=key;
  useEffect(()=>{ if (!isTauri()) return; let active=true;
    const readScope=()=>import("@tauri-apps/api/core").then(({invoke})=>invoke<{config?: {enabled:boolean;spaceId:string;deviceId:string}}>("get_cloud_sync_status")).then(s=>{if(active) setScope(s.config?.enabled?s.config:null);}).catch(()=>{if(active)setError(true);}).finally(()=>{if(active)setScopeReady(true);});
    void readScope(); const timer=window.setInterval(()=>void readScope(),15000);
    return ()=>{active=false;window.clearInterval(timer);};
  },[]);
  const persist = useCallback((next:Cache, target:string) => { if(activeKey.current!==target)return; latest.current.cache=next; setCache(next); try {localStorage.setItem(target,JSON.stringify(next));}catch{setError(true);} },[]);
  useEffect(()=>{setError(false); let next:Cache={plan:null,pending:[]}; if(key) {try {const saved=JSON.parse(localStorage.getItem(key) || "null"); if(saved?.plan?.basis?.localDate===basis?.localDate && Array.isArray(saved.pending)) next=saved;}catch{/* keep a clean cache */}} latest.current.cache=next;setCache(next);},[key]);
  const refresh = useCallback(async()=>{
    const target=key, b=latest.current.basis;
    if(!target || !b || busy.current)return;
    busy.current=true;
    try {
      const {invoke}=await import("@tauri-apps/api/core");
      // Always fetch first. Failed/conflicting edits stay local until explicitly changed.
      const response=await invoke<{plan:SharedDailyPlan}>("exchange_daily_plan",{body:{basis:b,spaceId:scope?.spaceId,initialRisk}});
      if(activeKey.current!==target)return;
      let next={...latest.current.cache,plan:response.plan}; persist(next,target);
      if(!next.blocked && next.pending.length) {
        const change=next.pending[0];
        const result=await invoke<{plan:SharedDailyPlan}>("exchange_daily_plan",{body:{basis:b,change,spaceId:scope?.spaceId}});
        if(activeKey.current!==target)return;
        next={...latest.current.cache,plan:result.plan,pending:latest.current.cache.pending.filter(c=>c!==change).map(c=>c.kind===change.kind && c.personId===change.personId ? {...c,expectedRevision:(c.kind==="risk"?result.plan.risk:result.plan.people[c.personId!]).revision}:c)};persist(next,target);
      }
      setError(!!next.blocked);
    } catch(e) {
      if(activeKey.current===target){setError(true);if(String(e).includes("conflict"))persist({...latest.current.cache,blocked:true},target);}
    } finally {busy.current=false;}
  },[key,persist,scope?.spaceId,initialRisk]);
  useEffect(()=>{void refresh();const timer=window.setInterval(()=>void refresh(),15000);return()=>window.clearInterval(timer);},[refresh]);
  const change = useCallback((kind:Change["kind"], value:number|null, personId?:string)=>{
    if(!key || !latest.current.cache.plan){setError(true);return;}
    const state=latest.current.cache;
    const field=kind==="risk"?state.plan!.risk:state.plan!.people[personId!];
    const pending=state.pending.filter(c=>!(c.kind===kind && c.personId===personId));
    pending.push({kind,value,personId,expectedRevision:field?.revision??0});
    persist({...state,pending,blocked:false},key);
    if(editTimer.current)clearTimeout(editTimer.current);
    editTimer.current=setTimeout(()=>void refresh(),400);
  },[key,persist,refresh]);
  let plan=cache.plan;
  if(plan && plan.basis.localDate===basis?.localDate && plan.basis.resetsAt===basis.resetsAt){
    plan={...plan,people:{...plan.people}};
    for(const c of cache.pending)if(c.kind==="risk")plan.risk={value:c.value,revision:c.expectedRevision};else plan.people[c.personId!]={value:c.value,revision:c.expectedRevision};
  }else plan=null;
  return {plan,deviceId:scope?.deviceId??null,connected:!!scope,scopeReady,error,conflict:!!cache.blocked,pending:cache.pending.length>0,change};
}
