import OpenAI from "openai";

let openai: OpenAI | null = null;
try {
  const apiKey = process.env.OPENAI_API_KEY;
  if (apiKey) {
    openai = new OpenAI({ apiKey });
  }
} catch {
  // ignore
}

export async function createRealtimeSession() {
  if (!openai) {
    return { success: false, error: "OPENAI_API_KEY not configured" };
  }
  try {
    const session = await openai.beta.realtime.sessions.create({
      model: "gpt-4o-realtime-preview-2024-12-17",
      voice: "alloy",
    });
    return {
      success: true,
      clientSecret: session.client_secret?.value || "",
      expiresAt: session.client_secret?.expires_at || 0,
    };
  } catch (e: any) {
    return { success: false, error: e?.message || String(e) };
  }
}
