// Excerpt of mohammadpurl/next-livekit-streaming, app/components/AvatarChat.tsx, seen in P5.
import { useStreamingAvatarSession } from "./logic/useStreamingAvatarSession";
export default function AvatarChat() {
  const { startAvatar } = useStreamingAvatarSession();
  return <button onClick={() => startAvatar({})}>Start</button>;
}
