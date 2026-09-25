import { ComposedChart, Bar, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend } from "recharts";
import { fmtCur } from "./format.js";

export default function MonthlyTrendChart({ data, c, currency }) {
  return (
    <ResponsiveContainer width="100%" height={190}>
      <ComposedChart data={data}>
        <CartesianGrid strokeDasharray="3 3" stroke={c.cardB} vertical={false} />
        <XAxis dataKey="label" tick={{ fill:c.muted, fontSize:10 }} axisLine={false} tickLine={false} />
        <YAxis tick={{ fill:c.muted, fontSize:10 }} axisLine={false} tickLine={false} tickFormatter={v=>fmtCur(0,currency).replace(/0\.00/,"").trim()+v} />
        <Tooltip formatter={v=>fmtCur(v,currency)} contentStyle={{ background:c.card, border:`1px solid ${c.cardB}`, borderRadius:12, fontSize:11, color:c.white }} />
        <Legend wrapperStyle={{ fontSize:10, color:c.muted }} formatter={v=>({income:"Income",expenses:"Expenses",net:"Net"}[v]||v)} />
        <Bar dataKey="income" fill={c.positive} radius={[4,4,0,0]} opacity={.9} />
        <Bar dataKey="expenses" fill={c.negative} radius={[4,4,0,0]} opacity={.9} />
        <Line type="monotone" dataKey="net" stroke={c.accent} strokeWidth={2} dot={{ r:3, fill:c.accent }} />
      </ComposedChart>
    </ResponsiveContainer>
  );
}
