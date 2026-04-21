import type { TelemetryEvent } from '@avs/abr';
import { Kafka, logLevel, type Producer } from 'kafkajs';

export interface Sink {
  readonly name: string;
  write(events: TelemetryEvent[]): Promise<void>;
  close(): Promise<void>;
}

/** Keeps events in memory (tests, e2e). Bounded so a long run cannot exhaust memory. */
export class MemorySink implements Sink {
  readonly name = 'memory';
  readonly events: TelemetryEvent[] = [];
  constructor(private readonly limit = 100_000) {}
  async write(events: TelemetryEvent[]): Promise<void> {
    this.events.push(...events);
    if (this.events.length > this.limit) this.events.splice(0, this.events.length - this.limit);
  }
  async close(): Promise<void> {}
}

export interface KafkaSinkOptions {
  brokers: string[];
  topic: string;
  partitions: number;
  clientId?: string;
}

/** Produces each event as JSON, keyed by session id so a session stays in one partition. */
export class KafkaSink implements Sink {
  readonly name = 'kafka';
  private constructor(
    private readonly producer: Producer,
    private readonly topic: string,
  ) {}

  static async connect(o: KafkaSinkOptions): Promise<KafkaSink> {
    const kafka = new Kafka({
      clientId: o.clientId ?? 'avs-collector',
      brokers: o.brokers,
      logLevel: logLevel.WARN,
      retry: { retries: 10, initialRetryTime: 300 },
    });
    const admin = kafka.admin();
    await admin.connect();
    const existing = await admin.listTopics();
    if (!existing.includes(o.topic)) {
      await admin.createTopics({
        topics: [{ topic: o.topic, numPartitions: o.partitions, replicationFactor: 1 }],
        waitForLeaders: true,
      });
    }
    await admin.disconnect();
    const producer = kafka.producer({ allowAutoTopicCreation: false });
    await producer.connect();
    return new KafkaSink(producer, o.topic);
  }

  async write(events: TelemetryEvent[]): Promise<void> {
    if (events.length === 0) return;
    await this.producer.send({
      topic: this.topic,
      acks: 1,
      messages: events.map((e) => ({ key: e.sid, value: JSON.stringify(e) })),
    });
  }

  async close(): Promise<void> {
    await this.producer.disconnect();
  }
}
