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
    const chart = echarts.init(containerRef.current!, undefined, { renderer: "canvas" });
    chartRef.current = chart;
    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(containerRef.current!);
    return () => {
      ro.disconnect();
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

  return <div ref={containerRef} style={{ height, width: "100%" }} />;
}
