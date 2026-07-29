import { useEffect, useRef } from "react";
import * as echarts from "echarts";

export type EChartsOption = echarts.EChartsCoreOption;

export default function EChart({
  option,
  height,
  onClick,
}: {
  option: EChartsOption;
  height: number;
  onClick?: (params: echarts.ECElementEvent) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);

  useEffect(() => {
    const container = containerRef.current!;
    const chart = echarts.init(container, undefined, { renderer: "canvas" });
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
