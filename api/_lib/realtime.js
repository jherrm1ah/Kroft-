// Session settings for Kroft's live voice conversations (api/realtime.js). Shapes follow the
// openai npm package's realtime types: RealtimeSessionCreateRequest, RealtimeAudioConfig,
// RealtimeFunctionTool, semantic_vad turn detection.

// Override with OPENAI_REALTIME_MODEL / OPENAI_REALTIME_VOICE in Vercel if needed.
export const DEFAULT_REALTIME_MODEL = "gpt-realtime";
export const DEFAULT_REALTIME_VOICE = "cedar";

// Conversations a day and minutes per conversation, by plan.
export const LIVE_LIMITS = {
  free: { perDay: 3, maxMinutes: 3 },
  paid: { perDay: 40, maxMinutes: 15 },
};

export const MAX_INSTRUCTION_CHARS = 24000;

// The one tool: everything Kroft can save or change goes through the same action objects typed
// chat uses (applyAiAction in Kroft.jsx), so live voice can't do anything chat can't.
export const KROFT_ACTION_TOOL = {
  type: "function",
  name: "kroft_action",
  description: "Save or change something in the person's Kroft account: add a task, expense, income, appointment, note, reminder, invoice, bill or quote, complete a task, or move an appointment. Use exactly the action types and fields listed under ACTIONS in your instructions. Call it only when they clearly ask to record or change something.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "object", description: 'One action object, e.g. {"type":"add_expense","label":"Fuel","amount":5000,"cat":"Transport"}.' },
    },
    required: ["action"],
  },
};

const LIVE_RULES = `

LIVE VOICE CONVERSATION
You are talking with the person out loud, in real time. Speak naturally and briefly, like a sharp, warm assistant on a phone call: one or two short sentences at a time, no lists, no markdown, no reading out symbols or JSON. Let them interrupt; if they do, stop and listen. Ignore the <action> block format described above: to save or change something, call the kroft_action function with the action object instead, then say in a few words what you did. Never call it for delete_* or send_email; for those, say they need to confirm it in the app.`;

export function liveInstructions(text) {
  const base = String(text || "You are Kroft, a helpful assistant.").slice(0, MAX_INSTRUCTION_CHARS);
  return base + LIVE_RULES;
}

export function liveSessionConfig({ instructions, model, voice } = {}) {
  return {
    type: "realtime",
    model: model || DEFAULT_REALTIME_MODEL,
    instructions: liveInstructions(instructions),
    output_modalities: ["audio"],
    audio: {
      input: {
        transcription: { model: "gpt-4o-mini-transcribe" },
        noise_reduction: { type: "near_field" },
        // Waits for the person to finish their thought (not just a pause) and lets them cut in.
        turn_detection: { type: "semantic_vad", eagerness: "auto", create_response: true, interrupt_response: true },
      },
      output: { voice: voice || DEFAULT_REALTIME_VOICE },
    },
    tools: [KROFT_ACTION_TOOL],
    tool_choice: "auto",
  };
}
