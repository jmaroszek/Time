import { useEffect, useRef } from "react";
import {
  init,
  use,
  type ECElementEvent,
  type ECharts,
  type EChartsCoreOption,
} from "echarts/core";
import { BarChart, CustomChart, HeatmapChart, LineChart } from "echarts/charts";
import {
  AxisPointerComponent,
  CalendarComponent,
  GridComponent,
  LegendComponent,
  TooltipComponent,
  VisualMapContinuousComponent,
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";

export type EChartsOption = EChartsCoreOption;

/**
 * Every series type and component this app's charts declare, and nothing else.
 *
 * The package's default entry registers all of them — pie, map, graph, radar,
 * the toolbox, both data-zoom flavours — which left about 510 KB of minified
 * JavaScript in the bundle for the WebView to parse on every cold start and
 * never run. Registration is explicit instead, so the cost tracks what is
 * actually drawn.
 *
 * A chart that renders blank after gaining a new option is the symptom of a
 * type missing from this list.
 */
use([
  BarChart,
  CustomChart,
  HeatmapChart,
  LineChart,
  // Drives tooltip.trigger "axis". TooltipComponent installs it anyway; naming
  // it keeps the list a complete account of what the options rely on.
  AxisPointerComponent,
  CalendarComponent,
  GridComponent,
  LegendComponent,
  TooltipComponent,
  // Continuous only: every visualMap here is a min/max ramp, none piecewise.
  VisualMapContinuousComponent,
  CanvasRenderer,
]);

export default function EChart({
  option,
  height,
  onClick,
}: {
  option: EChartsOption;
  height: number;
  onClick?: (params: ECElementEvent) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<ECharts | null>(null);

  useEffect(() => {
    const container = containerRef.current!;
    const chart = init(container, undefined, { renderer: "canvas" });
    chartRef.current = chart;
    let resizeFrame = 0;
    const resize = () => {
      window.cancelAnimationFrame(resizeFrame);
      resizeFrame = window.requestAnimationFrame(() => {
        const bounds = container.getBoundingClientRect();
        if (bounds.width <= 0 || bounds.height <= 0) return;
        // WebView2 can deliver several intermediate window sizes while the
        // native edge is being dragged. Passing the settled content box
        // explicitly prevents ECharts from retaining an earlier canvas width.
        chart.resize({
          width: Math.floor(bounds.width),
          height: Math.floor(bounds.height),
        });
      });
    };
    const ro = new ResizeObserver(resize);
    ro.observe(container);
    window.addEventListener("resize", resize);
    resize();

    // ECharts 6.1 does not clear its delayed-show timer on globalout. Cancel
    // that one private timer at the chart boundary while leaving native item
    // and axis tooltip handling intact. Remove this shim when ECharts does so.
    const cancelPendingTooltip = () => {
      type InternalComponentModel = object;
      const internalChart = chart as unknown as {
        getModel: () => {
          getComponent: (mainType: string) => InternalComponentModel | null;
        };
        getViewOfComponentModel: (component: InternalComponentModel) => {
          _showTimout?: number | null;
        } | null;
      };
      const model = internalChart.getModel().getComponent("tooltip");
      if (!model) return;
      const view = internalChart.getViewOfComponentModel(model);
      if (view?._showTimout != null) {
        window.clearTimeout(view._showTimout);
        view._showTimout = null;
      }
    };
    chart.getZr().on("globalout", cancelPendingTooltip);

    return () => {
      cancelPendingTooltip();
      chart.getZr().off("globalout", cancelPendingTooltip);
      ro.disconnect();
      window.removeEventListener("resize", resize);
      window.cancelAnimationFrame(resizeFrame);
      chart.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    chartRef.current?.setOption(option, { notMerge: true });
  }, [option]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    chart.off("click");
    if (onClick) chart.on("click", onClick);
  }, [onClick, option]);

  return (
    <div
      ref={containerRef}
      className="min-w-0 max-w-full"
      style={{ height, width: "100%" }}
    />
  );
}
