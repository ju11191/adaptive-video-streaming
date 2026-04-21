/**
 * Telemetry collector.
 *   PORT=8081 SINK=kafka KAFKA_BROKERS=localhost:9092 TOPIC=telemetry ARMS=A,B npx tsx src/main.ts
 *   SINK=memory npx tsx src/main.ts      (no Kafka; events readable at GET /v1/debug/events)
 */
import { createCollector, parseArms } from './server.ts';
import { KafkaSink, MemorySink, type Sink } from './sinks.ts';

const port = Number(process.env['PORT'] ?? 8081);
const sinkKind = process.env['SINK'] ?? 'kafka';
const arms = parseArms(process.env['ARMS'] ?? 'A,B');

async function makeSink(): Promise<Sink> {
  if (sinkKind === 'memory') return new MemorySink();
  const brokers = (process.env['KAFKA_BROKERS'] ?? 'localhost:9092').split(',');
  const topic = process.env['TOPIC'] ?? 'telemetry';
  const partitions = Number(process.env['PARTITIONS'] ?? 6);
  for (let attempt = 1; ; attempt++) {
    try {
      return await KafkaSink.connect({ brokers, topic, partitions });
    } catch (e) {
      if (attempt >= 30) throw e;
      console.error(`collector: kafka not ready (${(e as Error).message}), retry ${attempt}`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

const sink = await makeSink();
const { server } = createCollector({ sink, arms });
server.listen(port, () => console.log(`collector listening on :${port}, sink=${sink.name}, arms=${arms.map((a) => a.name).join(',')}`));
const shutdown = async () => {
  server.close();
  await sink.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
