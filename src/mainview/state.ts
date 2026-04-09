export interface BackendStatus {
  running: boolean;
  port: number;
  url: string;
}

export interface SessionSummary {
  id: string;
  key: string;
  display_name: string;
  updated_at: string;
  created_at: string;
  message_count: number;
}

export interface ChatMessage {
  role: string;
  content?: string;
  [key: string]: any;
}

export interface Attachment {
  name: string;
  path: string;
  previewUrl?: string;
}

export interface Snippet {
  title: string;
  content: string;
  isBuiltin?: boolean;
}

export const MODEL_CONTEXT_LIMITS: Record<string, number> = {
  "gpt-4": 8192,
  "gpt-4o": 128000,
  "gpt-4o-mini": 128000,
  "gpt-5": 256000,
  "gpt-5.4-mini": 256000,
  "claude-3-5-sonnet": 200000,
  "claude-3-7-sonnet": 200000,
  "claude-3-opus": 200000,
  "claude-4-sonnet": 200000,
  "claude-4-opus": 200000,
  "gemini-1.5-pro": 128000,
  "gemini-2.0-flash": 1000000,
  "gemini-2.5-pro": 1000000,
  "deepseek-chat": 64000,
  "deepseek-reasoner": 64000,
  "o1": 128000,
  "o3": 200000,
  "o3-mini": 200000,
  "kimi-k2.5": 256000,
  "kimi-k2": 256000,
  "qwen2.5": 128000,
  "qwen-max": 32000,
  "default": 128000,
};

export const SCROLL_PAUSE_THRESHOLD = 80;
export const MAX_INITIAL_MESSAGES = 100;

export const BUILTIN_SNIPPETS: Snippet[] = [
  { title: "Explain", content: "Explain the following in simple terms:", isBuiltin: true },
  { title: "Summarize", content: "Provide a concise summary:", isBuiltin: true },
  { title: "Refactor", content: "Refactor and improve the following code:", isBuiltin: true },
  { title: "Write tests", content: "Write comprehensive unit tests for:", isBuiltin: true },
  { title: "Translate to CN", content: "Translate the following into natural Chinese:", isBuiltin: true },
  { title: "Translate to EN", content: "Translate the following into natural English:", isBuiltin: true },
];

export const AppState = {
  backendUrl: "",
  activeStreamController: null as AbortController | null,
  conversation: [] as ChatMessage[],
  currentSessionId: "",
  attachments: [] as Attachment[],
  currentModelConfig: { model: "", provider: "" },
  backgroundErrors: new Map<string, string>(),
  workspacePath: "",
  previewHasChanges: false,
  activeApprovalCards: new Map<string, HTMLElement>(),
  activeReplyTo: null as { role: string; content: string } | null,
  draggedSessionId: null as string | null,
  userScrolledUp: false,
  activeMemorySection: "memory" as "memory" | "user",
  projects: [] as { id: string; name: string; color: string }[],
  activeProjectFilter: "",
  cachedWorkspaceEntries: [] as any[],
  systemThemeMq: null as MediaQueryList | null,
  searchMatches: [] as HTMLElement[],
  activeSearchIndex: -1,
  paletteActiveIndex: -1,
  onboardingResolved: false,
  installLogBuffer: "",
};
