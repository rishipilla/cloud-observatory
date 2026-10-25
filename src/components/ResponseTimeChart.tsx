import {
  CartesianGrid, Legend, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis,
} from "recharts";

export interface ResponseTimeSeries {
  id: number;
  name: string;
  checks: { timestamp: number; elapsed_ms: number }[];
}

export function ResponseTimeChart({ series }: { series: ResponseTimeSeries[] }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <ScatterChart margin={{ top: 8, right: 12, left: -16, bottom: 0 }}>
        <CartesianGrid stroke="#26332e" strokeDasharray="3 5" vertical={false} />
        <XAxis
          type="number"
          dataKey="timestamp"
          domain={["dataMin", "dataMax"]}
          tick={{ fill: "#89978f", fontSize: 10 }}
          axisLine={false}
          tickLine={false}
          tickFormatter={(value) => new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
        />
        <YAxis
          type="number"
          dataKey="elapsed_ms"
          name="Response time"
          unit=" ms"
          tick={{ fill: "#89978f", fontSize: 10 }}
          axisLine={false}
          tickLine={false}
        />
        <Tooltip
          contentStyle={{ background: "#111a16", border: "1px solid #34443b", borderRadius: 8, color: "#edf5ef", fontSize: 12 }}
          labelStyle={{ color: "#a5b4aa" }}
          labelFormatter={(value) => new Date(Number(value)).toLocaleString()}
          formatter={(value) => [`${Number(value).toFixed(1)} ms`, "HTTP check duration"]}
        />
        <Legend wrapperStyle={{ color: "#a5b4aa", fontSize: 10 }} />
        {series.map((item, index) => (
          <Scatter
            key={item.id}
            name={item.name}
            data={item.checks}
            fill={["#57d994", "#7ab6ff", "#e4b66a", "#cf91ed"][index % 4]}
          />
        ))}
      </ScatterChart>
    </ResponsiveContainer>
  );
}
