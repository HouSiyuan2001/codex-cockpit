# Windows widget motion

Opening a capsule near a screen edge moves and grows its native window. Moving
that window while WebView2/DWM still presents the previous compact backing frame
can briefly display a displaced capsule or a square corner. Correct final DOM
coordinates alone do not establish that the presented frames were correct.

The Windows path changes the native origin and size once with `SetWindowPos`
and `SWP_NOCOPYBITS`, while DWM temporarily cloaks the window. The frontend
prepares a paused, uniformly rounded clip at the outgoing capsule's screen
anchor, releases the matching native frame ticket, then starts the compositor
tween. Text fades without geometric scaling. Collapse runs the visual phase
before shrinking the native window.

Viewport readiness and paint waits are bounded because a cloaked WebView can
suspend animation frames. A native 1.2-second watchdog releases a matching
ticket even if the renderer stops. Stale requests cannot reveal a newer masked
frame or apply an obsolete collapse; failure and reduced-motion paths clean up
the temporary surface. Only the outgoing compact surface is cloned, is inert,
and remains inside the same process.

The path is gated to the Windows native WebView. macOS/Linux retain their native
geometry path and existing 60 ms collapse grace period. Windows uses 280 ms to
avoid accidental close/reopen around the morph. Provider access, stored data,
update sources, and sync are unchanged.

## Regression coverage

- Rounded clipping on left/top and right/bottom anchors, high DPI and negative
  monitor origins.
- Screen-anchor compensation before viewport resize/invoke completion.
- First-frame pause/reveal/play ordering and bounded waits with suspended rAF.
- Reduced motion, rendering errors, cancellation, and obsolete collapse intent.
- Native collapse planning uses the same geometry as the final application.

## Native acceptance

The same animation implementation was exercised in a locally built Windows x64
application before rebasing onto v0.3.4. The requesting user confirmed the final
appearance and click behavior. A desktop recording was used after DOM-only
sampling missed a DWM-cached frame. No private recording or runtime data is
included in this contribution.

The rebased source still needs native acceptance on mixed-DPI/multiple physical
monitors and a macOS/Linux regression pass. Automated/browser tests cannot
replace those checks. This source contribution does not publish an installer.

Manual checks: open/close from the center and each screen edge, drag and repeat,
re-enter during the close grace period, rapidly toggle direction, open/close
control center, enable reduced motion, hide/show, and restart. Check that the
capsule returns to the same anchor, all corners remain rounded, controls remain
reachable, and no invisible/ghost surface is retained.
