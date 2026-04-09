import { showToast } from "../utils/dom.js";
import { rpc } from "../utils/rpc.js";

const REALTIME_MODEL = "gpt-4o-realtime-preview-2024-12-17";

let pc: RTCPeerConnection | null = null;
let localAudio: MediaStream | null = null;
let remoteAudioEl: HTMLAudioElement | null = null;
let isConnecting = false;

function updateUI(state: "connected" | "disconnected" | "error") {
  const mic = document.getElementById("voice-mic");
  const status = document.getElementById("voice-status");
  const hint = document.getElementById("voice-hint");
  if (state === "connected") {
    mic?.classList.add("listening");
    mic?.classList.remove("speaking");
    if (status) {
      status.textContent = "Connected — speak freely";
      status.className = "voice-status listening";
    }
    if (hint) hint.textContent = "Tap to disconnect";
  } else if (state === "error") {
    mic?.classList.remove("listening", "speaking");
    if (status) {
      status.textContent = "Connection failed";
      status.className = "voice-status";
      (status as HTMLElement).style.color = "#ef4444";
    }
    if (hint) hint.textContent = "Tap to retry";
  } else {
    mic?.classList.remove("listening", "speaking");
    if (status) {
      status.textContent = "Powered by OpenAI Realtime API";
      status.className = "voice-status";
      (status as HTMLElement).style.color = "";
    }
    if (hint) hint.textContent = "Tap to connect · Speak freely once connected";
  }
}

export function isRealtimeConnected() {
  return !!pc && pc.connectionState === "connected";
}

export async function startRealtimeVoice() {
  if (isConnecting || isRealtimeConnected()) return;
  isConnecting = true;
  try {
    const sessionRes: any = await rpc.request.createRealtimeSession({});
    if (!sessionRes.success) {
      showToast("Realtime voice failed: " + (sessionRes.error || "Unknown error"));
      updateUI("error");
      throw new Error(sessionRes.error || "Realtime session creation failed");
    }

    const clientSecret = sessionRes.clientSecret as string;
    if (!clientSecret) {
      updateUI("error");
      throw new Error("No client secret returned");
    }

    pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });

    pc.onconnectionstatechange = () => {
      if (pc?.connectionState === "failed" || pc?.connectionState === "closed") {
        updateUI("disconnected");
        cleanup();
      }
    };

    localAudio = await navigator.mediaDevices.getUserMedia({ audio: true });
    localAudio.getTracks().forEach((track) => pc!.addTrack(track, localAudio!));

    remoteAudioEl = document.createElement("audio");
    remoteAudioEl.autoplay = true;
    document.body.appendChild(remoteAudioEl);
    pc.ontrack = (e) => {
      if (remoteAudioEl) remoteAudioEl.srcObject = e.streams[0];
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    const sdpResponse = await fetch(`https://api.openai.com/v1/realtime?model=${REALTIME_MODEL}`, {
      method: "POST",
      body: offer.sdp,
      headers: {
        Authorization: `Bearer ${clientSecret}`,
        "Content-Type": "application/sdp",
      },
    });

    if (!sdpResponse.ok) {
      const errText = await sdpResponse.text();
      updateUI("error");
      throw new Error(`Realtime SDP exchange failed: ${errText}`);
    }

    const answerSdp = await sdpResponse.text();
    await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
    updateUI("connected");
  } catch (e: any) {
    console.error("[Realtime Voice]", e);
    showToast("Realtime voice error: " + (e.message || String(e)));
    updateUI("error");
    cleanup();
  } finally {
    isConnecting = false;
  }
}

export function stopRealtimeVoice() {
  cleanup();
  updateUI("disconnected");
}

function cleanup() {
  if (pc) {
    try { pc.close(); } catch {}
    pc = null;
  }
  if (localAudio) {
    localAudio.getTracks().forEach((t) => t.stop());
    localAudio = null;
  }
  if (remoteAudioEl) {
    remoteAudioEl.remove();
    remoteAudioEl = null;
  }
}
