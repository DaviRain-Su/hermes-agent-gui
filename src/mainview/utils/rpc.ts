import { $ } from "./dom.js";

export function showLoginOverlay() {
  $("#login-overlay")?.classList.remove("hidden");
  const input = $("#login-password") as HTMLInputElement | null;
  input?.focus();
}

const RPC_ENDPOINT = "http://127.0.0.1:55000/rpc";
let rpcReqId = 0;

async function rpcRequest(method: string, params?: any): Promise<any> {
  const id = ++rpcReqId;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const token = localStorage.getItem("hermes-auth-token");
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(RPC_ENDPOINT, {
    method: "POST",
    headers,
    body: JSON.stringify({ type: "request", id, method, params: params ?? {} }),
  });
  if (res.status === 401) {
    localStorage.removeItem("hermes-auth-token");
    showLoginOverlay();
    throw new Error("Session expired. Please sign in again.");
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  const body = await res.json();
  if (body.error) {
    throw new Error(body.error);
  }
  return body.result;
}

type SendHandler = (payload: any) => void;
const sendHandlers: Partial<Record<string, SendHandler>> = {};

export function onRpcSend(event: string, handler: SendHandler) {
  sendHandlers[event] = handler;
}

function dispatchSend(event: string, payload: any) {
  sendHandlers[event]?.(payload);
}

export const rpc = {
  request: new Proxy({} as any, {
    get: (_target, prop) => {
      return (params: any) => rpcRequest(String(prop), params);
    },
  }),
  send: {
    backendStatus: (status: any) => dispatchSend("backendStatus", status),
    backendLog: (msg: any) => dispatchSend("backendLog", msg),
    installStatus: (status: any) => dispatchSend("installStatus", status),
    installLog: (msg: any) => dispatchSend("installLog", msg),
  },
};
