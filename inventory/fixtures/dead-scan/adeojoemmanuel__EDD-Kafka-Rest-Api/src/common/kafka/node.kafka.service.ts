// Excerpt of adeojoemmanuel/EDD-Kafka-Rest-Api, src/common/kafka/node.kafka.service.ts, seen in P5.
export const createServiceCustomer = (topic: string, handler: unknown) => ({ topic, handler });
export const sendSingleMessage = async (message: unknown) => message;
