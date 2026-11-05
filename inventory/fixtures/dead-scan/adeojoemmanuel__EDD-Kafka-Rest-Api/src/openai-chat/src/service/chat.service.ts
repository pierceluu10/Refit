// Excerpt of adeojoemmanuel/EDD-Kafka-Rest-Api, src/openai-chat/src/service/chat.service.ts, seen in P5.
import OpenAI from "openai";
import { creatServiceCustomer, sendSingleMessage } from './../../../common/kafka/node.kafka.service';

const openai = new OpenAI();

export const generateText = async(prompt: string) => {
  const response = await openai.completions.create({
    model: "text-davinci-003",
    prompt: prompt,
    max_tokens: 100,
  });
  return response.choices[0].text;
}

export const createChatAction = creatServiceCustomer('chat-events', async (message: any) => {
  await sendSingleMessage(message);
});
