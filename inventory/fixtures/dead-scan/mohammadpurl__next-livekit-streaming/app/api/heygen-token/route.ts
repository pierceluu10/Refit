// Excerpt of mohammadpurl/next-livekit-streaming, app/api/heygen-token/route.ts, seen in P5.
export async function POST() {
  const response = await fetch("https://api.heygen.com/v1/streaming.create_token", {
    method: "POST",
    headers: { "x-api-key": process.env.HEYGEN_API_KEY || "" },
  });
  return Response.json(await response.json());
}
