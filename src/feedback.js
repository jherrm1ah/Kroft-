// In-app feedback: what someone tells us, and where they were in KROFT when they did. Sent to
// api/feedback.js (stored in user_feedback); if that can't be reached, it opens an email instead,
// so nothing anyone writes is lost. Used by the app and the server.

export const FEEDBACK_KINDS = [
  { id: "problem", label: "Something's wrong" },
  { id: "idea", label: "An idea" },
  { id: "praise", label: "I like this" },
];
const KIND_IDS = new Set(FEEDBACK_KINDS.map(k => k.id));

// Where someone is, in words a person reads ("Finance", "Workspace › Projects", "Invoices").
const NAMES = {
  "home/overview": "Home", "home/finance": "Finance", "home/around": "Around Me", wellness: "Wellness", nova: "Ask Kroft",
  invoices: "Invoices", bills: "Bills", plans: "Plans",
};
export function screenName({ tab, homeSection, workspaceSection, profileScreen, overlay }) {
  if (overlay) return NAMES[overlay] || overlay;
  if (tab === "home") return NAMES[`home/${homeSection}`] || `Home › ${homeSection}`;
  if (tab === "workspace") return workspaceSection ? `Workspace › ${workspaceSection[0].toUpperCase()}${workspaceSection.slice(1)}` : "Workspace";
  if (tab === "profile") return profileScreen ? `Profile › ${profileScreen}` : "Profile";
  return NAMES[tab] || String(tab || "");
}

// The feedback to send, or { error } when there's nothing to send.
export function makeFeedback({ kind, message, screen = "", client = "" }) {
  const text = String(message || "").trim();
  if (text.length < 2) return { error: "Write a few words first." };
  return {
    kind: KIND_IDS.has(kind) ? kind : "idea",
    message: text.slice(0, 2000),
    screen: String(screen || "").slice(0, 80),
    client: String(client || "").slice(0, 200),
  };
}

// If the server can't take it: the same feedback as an email.
export function feedbackMailto(f, to = "feedback@virttechnologies.com") {
  const label = FEEDBACK_KINDS.find(k => k.id === f.kind)?.label || "Feedback";
  const body = `${f.message}\n\n—\nScreen: ${f.screen || "unknown"}\nApp: ${f.client || "unknown"}`;
  return `mailto:${to}?subject=${encodeURIComponent(`KROFT feedback: ${label}`)}&body=${encodeURIComponent(body)}`;
}
