import { BarChart, Bar, Cell, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";

export default function WellnessTrendChart({ data, c, activeColor }) {
  return (
    <ResponsiveContainer width="100%" height={160}>
      <BarChart data={data} margin={{ top:18, right:4, left:4, bottom:0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={c.cardB} vertical={false} />
        <XAxis dataKey="label" tick={{ fill:c.muted, fontSize:10 }} axisLine={false} tickLine={false} />
        <YAxis domain={[0,100]} hide />
        <Tooltip formatter={v=>`${v}/100`} contentStyle={{ background:c.card, border:`1px solid ${c.cardB}`, borderRadius:12, fontSize:11, color:c.white }} cursor={{ fill:c.surface }} />
        <Bar dataKey="score" radius={[6,6,0,0]} maxBarSize={28} label={{ position:"top", fill:c.muted, fontSize:10, fontFamily:"'Space Grotesk',sans-serif" }}>
          {data.map((e,i) => <Cell key={i} fill={e.label==="Today" ? activeColor : activeColor+"33"} />)}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
