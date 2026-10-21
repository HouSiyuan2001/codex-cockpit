//! Rounded-window fallback for X11 desktops without a compositing manager.
//! Composited desktops retain WebKit's full alpha channel and shadows.
use gtk::{cairo, prelude::*};
use std::sync::atomic::{AtomicBool, Ordering};
use std::{cell::Cell, rc::Rc};

static COMPOSITED: AtomicBool = AtomicBool::new(true);

pub fn supports_geometry_animation() -> bool {
    COMPOSITED.load(Ordering::Relaxed)
}

fn rounded_rows(width: i32, height: i32) -> Vec<(i32, i32, i32)> {
    let inset = 4;
    let w = width - 2 * inset;
    let h = height - 2 * inset;
    if w <= 0 || h <= 0 {
        return Vec::new();
    }
    let radius = 28_f64.min(f64::from(w.min(h)) / 2.0);
    (0..h)
        .map(|y| {
            let edge = (radius - (f64::from(y) + 0.5))
                .max(f64::from(y) + 0.5 - (f64::from(h) - radius))
                .max(0.0);
            let cut = (radius - (radius * radius - edge * edge).max(0.0).sqrt()).round() as i32;
            (inset + cut, inset + y, w - 2 * cut)
        })
        .collect()
}

fn update_shape(window: &gtk::ApplicationWindow, previous: &Cell<Option<(i32, i32, bool)>>) {
    let Some(surface) = window.window() else {
        return;
    };
    let allocation = window.allocation();
    let signature = (
        allocation.width(),
        allocation.height(),
        surface.screen().is_composited(),
    );
    COMPOSITED.store(signature.2, Ordering::Relaxed);
    if previous.get() == Some(signature) {
        return;
    }
    previous.set(Some(signature));
    if signature.2 {
        surface.shape_combine_region(None, 0, 0);
        return;
    }
    let region = cairo::Region::create();
    for (x, y, width) in rounded_rows(allocation.width(), allocation.height()) {
        if width > 0 {
            let _ = region.union_rectangle(&cairo::RectangleInt::new(x, y, width, 1));
        }
    }
    surface.shape_combine_region(Some(&region), 0, 0);
}

pub fn install(window: &gtk::ApplicationWindow) {
    let previous = Rc::new(Cell::new(None));
    let resized = previous.clone();
    window.connect_size_allocate(move |window, _| update_shape(window, &resized));
    let mapped = previous.clone();
    window.connect_map(move |window| {
        mapped.set(None);
        update_shape(window, &mapped);
    });
    if let Some(screen) = gtk::prelude::WidgetExt::screen(window) {
        let weak = window.downgrade();
        let changed = previous.clone();
        screen.connect_composited_changed(move |_| {
            if let Some(window) = weak.upgrade() {
                update_shape(&window, &changed);
            }
        });
    }
    update_shape(window, &previous);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shape_tracks_compact_and_expanded_sizes_without_clipping_the_center() {
        for (width, height) in [(96, 48), (528, 362), (568, 608)] {
            let rows = rounded_rows(width, height);
            assert_eq!(rows.len(), (height - 8) as usize);
            assert!(rows
                .iter()
                .all(|&(x, y, w)| x >= 4 && y >= 4 && x + w <= width - 4));
            assert_eq!(rows[rows.len() / 2].2, width - 8);
            assert_eq!(rows.first().unwrap().2, rows.last().unwrap().2);
        }
        assert!(rounded_rows(0, 0).is_empty());
    }
}
