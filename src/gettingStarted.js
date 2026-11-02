// The first two minutes: right after sign-up KROFT asks what someone wants it for, opens that
// part of the app, and Home shows three steps for that goal that tick themselves off as they're
// done (from the person's real data, nothing to mark by hand). Pure: give it the data, it says
// what's done.

export const GOALS = [
  {
    id: "paid", label: "Get paid", sub: "Invoices, quotes and clients",
    steps: [
      { id: "details", t: "Add how clients pay you", done: d => !!(d.invoiceSettings?.bankName || d.invoiceSettings?.accountNumber || d.invoiceSettings?.otherPayment?.trim()) },
      { id: "invoice", t: "Create your first invoice", done: d => (d.invoices || []).length > 0 },
      { id: "send", t: "Send it to your client", done: d => (d.invoices || []).some(i => i.status && i.status !== "draft") },
    ],
  },
  {
    id: "money", label: "Track my money", sub: "Income, expenses and budgets",
    steps: [
      { id: "entry", t: "Add an income or expense", done: d => (d.income || []).length + (d.expenses || []).length > 0 },
      { id: "budget", t: "Set a monthly budget", done: d => Object.values(d.budgets || {}).some(v => Number(v) > 0) },
      { id: "bill", t: "Add a bill you have to pay", done: d => (d.bills || []).length > 0 },
    ],
  },
  {
    id: "projects", label: "Run projects", sub: "Milestones, clients and project money",
    steps: [
      { id: "project", t: "Create a project", done: d => (d.projects || []).length > 0 },
      { id: "milestone", t: "Add a milestone with a due date", done: d => (d.projects || []).some(p => (p.milestones || []).some(m => m.dueDate)) },
      { id: "invoiceMilestone", t: "Invoice a milestone", done: d => (d.invoices || []).some(i => i.projectId) },
    ],
  },
  {
    id: "organised", label: "Stay organised", sub: "Tasks, calendar, notes and reminders",
    steps: [
      { id: "task", t: "Add a task", done: d => (d.tasks || []).length > 0 },
      { id: "appt", t: "Put something in your calendar", done: d => (d.appts || []).length > 0 },
      { id: "note", t: "Write a note", done: d => (d.notes || []).length > 0 },
    ],
  },
  {
    id: "assistant", label: "Talk to KROFT", sub: "Ask anything, by text or voice",
    steps: [
      { id: "ask", t: "Ask KROFT something", done: d => (d.aiMessages || []).some(m => m.role === "user") || (d.chatHistory || []).length > 0 },
      { id: "remind", t: "Have KROFT remind you of something", done: d => (d.smartReminders || []).length > 0 },
      { id: "voice", t: "Try talking to KROFT", done: d => Number(d.voiceTurnsCount) > 0 },
    ],
  },
];

export const goalById = id => GOALS.find(g => g.id === id) || null;

// { goal, steps: [{ id, t, done }], doneCount, total, complete } for the chosen goal, or null.
export function startProgress(goalId, data) {
  const goal = goalById(goalId);
  if (!goal) return null;
  const steps = goal.steps.map(s => ({ id: s.id, t: s.t, done: !!s.done(data) }));
  const doneCount = steps.filter(s => s.done).length;
  return { goal, steps, doneCount, total: steps.length, complete: doneCount === steps.length };
}

// The first step not done yet (what "Start" should open), or null.
export const nextStep = progress => progress?.steps.find(s => !s.done) || null;
