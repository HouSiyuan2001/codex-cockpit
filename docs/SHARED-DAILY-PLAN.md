# Shared daily plan (.35)

## User-visible rules

- One Cloudflare space represents one shared Codex account. This version does not verify that every member actually uses the same provider account.
- The account recommendation is independent of personal comfort fitting. Existing per-person feedback and cost-share-based percentage fitting are preserved; this version does not use their estimated knee as a hard account-wide cap or introduce additional Token-to-quota calibration.
- Automatic personal plans are the account recommendation divided by the number of configured people with devices. Each manual override replaces only that person's share; it never reallocates someone else's share.
- Example: total recommendation 20%, two people initially 10% each; one chooses 12%, the other stays 10%. Show an over-recommendation warning for the total 22%, without clamping it.
- The daily ring compares shared account consumption with the sum of personal plans. The slider changes only the current device owner's personal plan. Comfort selection does not change plan ownership.
- Manual reset risk and automatic/manual mode are shared. In automatic mode, clients retain the existing website-risk source; devices can temporarily differ if that source is unavailable or stale. This is not an authoritative cloud risk forecast.

## Formula and baseline

For baseline balance R, exact days to natural reset D, remaining fraction of the Beijing calendar day f, and reset-risk probability p:

`U = min(R, R / D * f)`

`shared recommendation = min(R, U + (R - U) * p² * f)`

Round the final recommendation to one decimal. No personal comfort knee or weekend multiplier applies. The control-center heatmap uses the same formula; its shared-account color scale is 0 through baseline balance, not a person's fitted knee.

The first authenticated device to create that day/cycle record seeds a fixed baseline derived from its midnight/first-observation history and its existing local manual-risk preference (if enabled). This does not prove there was an exact midnight snapshot. All subsequent clients reuse the stored basis. New Beijing days and changed natural reset timestamps start new records; personal manual choices do not carry over automatically.

## Transport and failure behavior

`POST /v2/daily-plan` requires the existing device token. Migration `0004_daily_plans.sql` is additive. Records are scoped by space, Beijing date, and canonical reset timestamp. A member may edit only a person whose configured device list includes that member; any member may adjust shared risk.

Personal and risk revisions are independent. Row-level compare-and-swap prevents lost updates, while stale edits to the same field return 409. The frontend polls every 15 seconds, debounces edits by 400 ms, caches drafts by space/day/cycle, retries network failures, and stops automatic replay after a conflict. The user must explicitly reconfirm a conflicted value. The native bridge checks the expected space before using credentials, preventing drafts from being sent into a newly selected space.

Only numeric plan settings and baseline metadata are added to the cloud payload. Provider credentials remain native/read-only. Existing task summaries, comfort observations, and group/pricing sync remain unchanged.

Offline, an already loaded shared plan retains its local draft. First-time offline clients without a cached shared record cannot submit a shared edit. Other devices must also install .35 for plan synchronization; .34 does not call this endpoint. Old cloud plan records are retained; automated retention cleanup is not implemented yet.
