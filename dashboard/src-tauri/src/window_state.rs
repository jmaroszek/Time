use tauri::{PhysicalPosition, PhysicalSize, Runtime, WebviewWindow};

const MIN_EFFECTIVE_WIDTH: f64 = 500.0;
const MIN_EFFECTIVE_HEIGHT: f64 = 480.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Rect {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

impl Rect {
    fn intersects(self, other: Self) -> bool {
        let self_right = i64::from(self.x) + i64::from(self.width);
        let self_bottom = i64::from(self.y) + i64::from(self.height);
        let other_right = i64::from(other.x) + i64::from(other.width);
        let other_bottom = i64::from(other.y) + i64::from(other.height);

        i64::from(self.x) < other_right
            && self_right > i64::from(other.x)
            && i64::from(self.y) < other_bottom
            && self_bottom > i64::from(other.y)
    }
}

fn validated_bounds(
    saved: Rect,
    monitors: &[Rect],
    primary_work_area: Option<Rect>,
    minimum_width: u32,
    minimum_height: u32,
) -> Rect {
    let mut restored = Rect {
        width: saved.width.max(minimum_width),
        height: saved.height.max(minimum_height),
        ..saved
    };

    if monitors.is_empty() || monitors.iter().any(|monitor| restored.intersects(*monitor)) {
        return restored;
    }

    if let Some(work_area) = primary_work_area {
        // Keep an oversized window anchored to the work area instead of
        // centring it to a negative offset. Windows can still resize it down
        // through the native edges or the custom caption controls.
        let x_offset = work_area.width.saturating_sub(restored.width) / 2;
        let y_offset = work_area.height.saturating_sub(restored.height) / 2;
        restored.x = work_area
            .x
            .saturating_add(i32::try_from(x_offset).unwrap_or(i32::MAX));
        restored.y = work_area
            .y
            .saturating_add(i32::try_from(y_offset).unwrap_or(i32::MAX));
    }

    restored
}

/// The plugin restores before application setup while the window is hidden.
/// This final pass protects against stale coordinates and pre-contract window
/// sizes even if the monitor topology changes between save and restore.
pub fn validate_restored_window<R: Runtime>(window: &WebviewWindow<R>) -> tauri::Result<()> {
    // Maximization is restored by the plugin. Moving or resizing a maximized
    // window here would replace the normal bounds Windows should return to.
    if window.is_maximized()? {
        return Ok(());
    }

    let scale = window.scale_factor()?;
    let inner_size = window.inner_size()?;
    let outer_size = window.outer_size()?;
    let outer_position = window.outer_position()?;
    let monitors = window.available_monitors()?;
    let primary = window.primary_monitor()?;

    let minimum_width = (MIN_EFFECTIVE_WIDTH * scale).ceil() as u32;
    let minimum_height = (MIN_EFFECTIVE_HEIGHT * scale).ceil() as u32;
    let monitor_rects = monitors
        .iter()
        .map(|monitor| Rect {
            x: monitor.position().x,
            y: monitor.position().y,
            width: monitor.size().width,
            height: monitor.size().height,
        })
        .collect::<Vec<_>>();
    let primary_work_area = primary.map(|monitor| {
        let work_area = monitor.work_area();
        Rect {
            x: work_area.position.x,
            y: work_area.position.y,
            width: work_area.size.width,
            height: work_area.size.height,
        }
    });
    let validated = validated_bounds(
        Rect {
            x: outer_position.x,
            y: outer_position.y,
            width: outer_size.width,
            height: outer_size.height,
        },
        &monitor_rects,
        primary_work_area,
        minimum_width,
        minimum_height,
    );

    if inner_size.width < minimum_width || inner_size.height < minimum_height {
        window.set_size(PhysicalSize::new(
            inner_size.width.max(minimum_width),
            inner_size.height.max(minimum_height),
        ))?;
    }
    if validated.x != outer_position.x || validated.y != outer_position.y {
        window.set_position(PhysicalPosition::new(validated.x, validated.y))?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{validated_bounds, Rect};

    const PRIMARY: Rect = Rect {
        x: 0,
        y: 0,
        width: 1920,
        height: 1040,
    };

    #[test]
    fn clamps_saved_dimensions_to_the_effective_minimum() {
        let restored = validated_bounds(
            Rect {
                x: 20,
                y: 30,
                width: 320,
                height: 240,
            },
            &[PRIMARY],
            Some(PRIMARY),
            500,
            480,
        );

        assert_eq!(
            restored,
            Rect {
                x: 20,
                y: 30,
                width: 500,
                height: 480,
            }
        );
    }

    #[test]
    fn preserves_a_partially_visible_saved_window() {
        let saved = Rect {
            x: 1850,
            y: 980,
            width: 900,
            height: 600,
        };

        assert_eq!(
            validated_bounds(saved, &[PRIMARY], Some(PRIMARY), 500, 480),
            saved
        );
    }

    #[test]
    fn recenters_disconnected_monitor_coordinates_in_primary_work_area() {
        let restored = validated_bounds(
            Rect {
                x: -20_000,
                y: -20_000,
                width: 900,
                height: 600,
            },
            &[PRIMARY],
            Some(PRIMARY),
            500,
            480,
        );

        assert_eq!(
            restored,
            Rect {
                x: 510,
                y: 220,
                width: 900,
                height: 600,
            }
        );
    }

    #[test]
    fn missing_monitor_information_keeps_position_but_still_clamps_size() {
        assert_eq!(
            validated_bounds(
                Rect {
                    x: -500,
                    y: 80,
                    width: 200,
                    height: 300,
                },
                &[],
                None,
                500,
                480,
            ),
            Rect {
                x: -500,
                y: 80,
                width: 500,
                height: 480,
            }
        );
    }
}
