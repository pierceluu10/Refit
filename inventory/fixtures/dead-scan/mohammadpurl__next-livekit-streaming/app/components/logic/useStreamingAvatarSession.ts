// Excerpt of mohammadpurl/next-livekit-streaming, app/components/logic/useStreamingAvatarSession.ts, seen in P5.
import StreamingAvatar from "@heygen/streaming-avatar";
import { avatarHelper } from "../../lib/avatar-helper";

export function useStreamingAvatarSession() {
  const avatarRef = { current: new StreamingAvatar({ token: avatarHelper() }) };
  const startAvatar = async (config) => {
    await avatarRef.current.createStartAvatar(config);
    return avatarRef.current;
  };
  return { startAvatar };
}
