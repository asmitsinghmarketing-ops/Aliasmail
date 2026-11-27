"use client";
import { Area, AreaChart, Bar, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { compact, shortDate } from "./ui";

export const CHART = { primary: "#0b6e4f", secondary: "#7cc7a6", tertiary: "#10231b", grid: "rgba(16, 35, 27, .08)", axis: "#94a09a" };

type Series = { key: string; name: string; color: string; format?: (v: number) => string };
type TipProps = { active?: boolean; label?: string; payload?: { dataKey?: string | number; value?: number | string }[] };

function Tip({ active, label, payload, series }: TipProps & { series: Series[] }) {
  if (!active || !payload?.length || !label) return null;
  return <div className="chartTip"><b>{shortDate(label)}</b>{series.map((s) => {
    const v = Number(payload.find((p) => p.dataKey === s.key)?.value ?? 0);
    return <div key={s.key}><i style={{ background: s.color }} />{s.name}: {s.format ? s.format(v) : v.toLocaleString()}</div>;
  })}</div>;
}

const axisProps = { tickLine: false, axisLine: false, tick: { fontSize: 11, fill: CHART.axis } } as const;

/** Overlapping area series over a daily x-axis. */
export function TrendChart({ data, series }: { data: Record<string, number | string>[]; series: Series[] }) {
  return <div className="chartBox"><ResponsiveContainer width="100%" height="100%">
    <AreaChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
      <defs>{series.map((s) => <linearGradient key={s.key} id={`g-${s.key}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={s.color} stopOpacity={0.28} /><stop offset="100%" stopColor={s.color} stopOpacity={0} /></linearGradient>)}</defs>
      <CartesianGrid vertical={false} stroke={CHART.grid} />
      <XAxis dataKey="date" {...axisProps} tickFormatter={shortDate} minTickGap={24} />
      <YAxis {...axisProps} width={44} tickFormatter={(v: number) => compact(v)} allowDecimals={false} />
      <Tooltip content={<Tip series={series} />} cursor={{ stroke: CHART.axis, strokeDasharray: "3 3" }} />
      {series.map((s) => <Area key={s.key} type="monotone" dataKey={s.key} stroke={s.color} strokeWidth={2} fill={`url(#g-${s.key})`} isAnimationActive={false} />)}
    </AreaChart>
  </ResponsiveContainer></div>;
}

/** Bars on the left axis with a line on the right axis (e.g. revenue vs orders). */
export function BarLineChart({ data, bar, line }: { data: Record<string, number | string>[]; bar: Series; line: Series }) {
  return <div className="chartBox"><ResponsiveContainer width="100%" height="100%">
    <ComposedChart data={data} margin={{ top: 8, right: 4, left: 0, bottom: 0 }}>
      <CartesianGrid vertical={false} stroke={CHART.grid} />
      <XAxis dataKey="date" {...axisProps} tickFormatter={shortDate} minTickGap={24} />
      <YAxis yAxisId="l" {...axisProps} width={52} tickFormatter={(v: number) => (bar.format ? bar.format(v) : compact(v))} />
      <YAxis yAxisId="r" orientation="right" {...axisProps} width={32} allowDecimals={false} />
      <Tooltip content={<Tip series={[bar, line]} />} cursor={{ fill: "rgba(11, 110, 79, .06)" }} />
      <Bar yAxisId="l" dataKey={bar.key} fill={bar.color} radius={[4, 4, 0, 0]} maxBarSize={22} isAnimationActive={false} />
      <Line yAxisId="r" type="monotone" dataKey={line.key} stroke={line.color} strokeWidth={2} dot={false} isAnimationActive={false} />
    </ComposedChart>
  </ResponsiveContainer></div>;
}
