// Excerpt of manu14357/smartdoc, src/app/api/message/route.ts, seen in P5.
import axios from "axios";

export async function POST(request) {
  const { messages } = await request.json();
  const axiosResponse = await axios.post(
    "https://integrate.api.nvidia.com/v1/chat/completions",
    {
      model: "meta/llama-3.3-70b-instruct",
      messages,
      stream: true,
    },
  );
  return Response.json(axiosResponse.data);
}
