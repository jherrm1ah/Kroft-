import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from "recharts";
import { fmtCur } from "./format.js";

export default function CategoryPieChart({ data, pieColors, c, currency }) {
  return (
    <ResponsiveContainer width={140} height={140} style={{ flexShrink:0 }}>
      <PieChart>
        <Pie data={data} dataKey="amt" nameKey="cat" innerRadius={38} outerRadius={62} paddingAngle={2} stroke="none">
          {data.map((d, i) => <Cell key={d.cat} fill={pieColors[i % pieColors.length]} />)}
        </Pie>
        <Tooltip formatter={(v, n) => [fmtCur(v, currency), n]} contentStyle={{ background:c.card, border:`1px solid ${c.cardB}`, borderRadius:12, fontSize:11, color:c.white }} />
      </PieChart>
    </ResponsiveContainer>
  );
}
