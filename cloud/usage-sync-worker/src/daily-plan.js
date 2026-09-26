const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: {"content-type":"application/json","cache-control":"no-store"} });
export async function dailyPlan(request, env, member) {
  const text = await request.text();
  if (text.length > 8192) return reply({ok:false,error:"plan_invalid"},400);
  let body;
  try {body=JSON.parse(text);} catch {return reply({ok:false,error:"plan_invalid"},400);}
  const b = body?.basis;
  const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0,10);
  const percent = n => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 100;
  if (!b || b.localDate !== today || !percent(b.remainingPercent) || !Number.isFinite(Date.parse(b.anchorAt)) || !Number.isFinite(Date.parse(b.resetsAt)) || Date.parse(b.resetsAt) <= Date.now() || Date.parse(b.anchorAt) > Date.now() + 300000 || new Date(Date.parse(b.anchorAt) + 8 * 3600000).toISOString().slice(0,10) !== today) return reply({ok:false,error:"plan_invalid"},400);
  const basis = {localDate:today,anchorAt:b.anchorAt,remainingPercent:b.remainingPercent,resetsAt:b.resetsAt};
  if (Date.parse(b.resetsAt) > Date.now() + 8 * 86400000) return reply({ok:false,error:"plan_invalid"},400);
  basis.anchorAt = new Date(b.anchorAt).toISOString();
  basis.resetsAt = new Date(b.resetsAt).toISOString();
  // Canonical timestamps prevent equivalent timezone strings creating extra cycles.
  b.resetsAt = basis.resetsAt;
  const initialRisk = body.initialRisk ?? null;
  if (initialRisk !== null && !percent(initialRisk)) return reply({ok:false,error:"plan_invalid"},400);
  await env.DB.prepare("INSERT OR IGNORE INTO daily_plans(space_id,day,cycle,value) VALUES(?,?,?,?)").bind(member.space_id,today,b.resetsAt,JSON.stringify({basis,people:{},risk:{value:initialRisk,revision:0}})).run();
  for (let attempt=0; attempt<4; attempt++) {
    const row = await env.DB.prepare("SELECT value,revision FROM daily_plans WHERE space_id=? AND day=? AND cycle=?").bind(member.space_id,today,b.resetsAt).first();
    const plan = JSON.parse(row.value);
    if (!body.change) return reply({ok:true,plan});
    const c = body.change;
    if (!["person","risk"].includes(c.kind) || !(c.value === null || percent(c.value)) || !Number.isSafeInteger(c.expectedRevision) || c.expectedRevision < 0) return reply({ok:false,error:"plan_invalid"},400);
    let field;
    if(c.kind === "person") {
      const space = await env.DB.prepare("SELECT group_settings FROM spaces WHERE id=?").bind(member.space_id).first();
      const group = JSON.parse(space.group_settings || '{"groups":[]}').groups.find(g=>g.id===c.personId);
      if (!group || !group.deviceIds.includes(member.device_id)) return reply({ok:false,error:"plan_person_denied"},403);
      field = plan.people[c.personId] ?? {value:null,revision:0};
    } else field = plan.risk;
    // Independent per-person revisions: one person's edit never invalidates or changes another's.
    if(field.revision !== c.expectedRevision) return reply({ok:false,error:"plan_conflict",plan},409);
    const updated = {value:c.value,revision:field.revision+1};
    if(c.kind === "risk") plan.risk=updated; else plan.people[c.personId]=updated;
    const result = await env.DB.prepare("UPDATE daily_plans SET value=?,revision=revision+1 WHERE space_id=? AND day=? AND cycle=? AND revision=?").bind(JSON.stringify(plan),member.space_id,today,b.resetsAt,row.revision).run();
    if(result.meta.changes===1) return reply({ok:true,plan});
  }
  return reply({ok:false,error:"plan_conflict"},409);
}
