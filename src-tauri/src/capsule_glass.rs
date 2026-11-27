use std::cell::RefCell;

use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject};
use objc2::{msg_send, MainThreadMarker};
use objc2_app_kit::{
    NSAppearance, NSAppearanceNameAqua, NSAppearanceNameDarkAqua, NSView, NSWindow,
    NSWindowOrderingMode,
};
use objc2_foundation::{NSPoint, NSRect, NSSize};

thread_local! {
    // The floating widget is the only window that takes this material.
    static GLASS: RefCell<Option<Retained<NSView>>> = const { RefCell::new(None) };
}

#[derive(serde::Deserialize)]
pub(crate) struct CapsuleGlassFrame {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    radius: f64,
    dark: bool,
}

#[tauri::command]
pub(crate) async fn set_capsule_glass(
    window: tauri::WebviewWindow,
    frame: Option<CapsuleGlassFrame>,
) -> bool {
    if window.label() != "widget" {
        return false;
    }

    let (sender, receiver) = tokio::sync::oneshot::channel();
    let widget = window.clone();
    if window
        .run_on_main_thread(move || {
            let _ = sender.send(update_glass(&widget, frame));
        })
        .is_err()
    {
        return false;
    }
    receiver.await.unwrap_or(false)
}

fn update_glass(window: &tauri::WebviewWindow, frame: Option<CapsuleGlassFrame>) -> bool {
    GLASS.with_borrow_mut(|glass| {
        let Some(frame) = frame else {
            if let Some(view) = glass.take() {
                view.removeFromSuperview();
            }
            return false;
        };
        let Some(class) = AnyClass::get(c"NSGlassEffectView") else {
            return false;
        };
        let (Some(_), Ok(native)) = (MainThreadMarker::new(), window.ns_window()) else {
            return false;
        };
        let Some(parent) = (unsafe { &*native.cast::<NSWindow>() }).contentView() else {
            return false;
        };

        let bounds = parent.bounds();
        let y = if parent.isFlipped() {
            frame.y
        } else {
            bounds.size.height - frame.y - frame.height
        };
        let rect = NSRect::new(
            NSPoint::new(frame.x, y),
            NSSize::new(frame.width, frame.height),
        );
        if ![frame.x, y, frame.width, frame.height, frame.radius]
            .into_iter()
            .all(f64::is_finite)
            || frame.width <= 0.0
            || frame.height <= 0.0
        {
            return false;
        }

        let radius = frame.radius.clamp(0.0, frame.width.min(frame.height) / 2.0);
        let appearance = NSAppearance::appearanceNamed(unsafe {
            if frame.dark {
                NSAppearanceNameDarkAqua
            } else {
                NSAppearanceNameAqua
            }
        });
        let view = glass.get_or_insert_with(|| {
            // Resolve the class at runtime so older macOS versions can still run the widget.
            let view: Retained<NSView> = unsafe { msg_send![class, new] };
            // NSGlassEffectViewStyleClear retains more detail at the edge.
            let object: &AnyObject = view.as_ref();
            unsafe {
                let _: () = msg_send![object, setStyle: 1isize];
            }
            parent.addSubview_positioned_relativeTo(&view, NSWindowOrderingMode::Below, None);
            view
        });
        view.setFrame(rect);
        let object: &AnyObject = view.as_ref();
        unsafe {
            let _: () = msg_send![object, setCornerRadius: radius];
            let _: () = msg_send![object, setAppearance: appearance.as_deref()];
        }
        true
    })
}
