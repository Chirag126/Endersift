/**
 * Create the agent's HCS audit topic (plan row 29, D-057), paid by the payer.
 *
 *   pnpm hcs:create-topic                dry run: shows what would be created, spends nothing
 *   pnpm hcs:create-topic -- --confirm   creates the topic (a few cents of testnet HBAR)
 *
 * The topic's submit key is the payer's key, so only the agent can post. It
 * has NO admin key: nobody can change or delete it, so the record is
 * permanent. Then add the printed HCS_TOPIC_ID to .env and restart the API.
 * Refuses to run on mainnet, or when HCS_TOPIC_ID is already set (one topic).
 */
import { loadEnv } from '../../packages/core/src/index.ts';
import {
  MirrorNodeClient,
  hashscanTopicUrl,
  hashscanTransactionUrl,
  type MirrorTopic,
} from '../../packages/hedera/src/index.ts';
import {
  createClient,
  createTopic,
  parsePrivateKey,
  definiteFailureStatus,
  publicKeyHex,
  TOPIC_CREATE_MAX_FEE_TINYBARS,
  type KeyType,
} from '../../packages/hedera/src/sdk.ts';
import {
  UsageError,
  handleScriptErrors,
  hasFlag,
  loadLocalEnvSource,
  writeEvidence,
} from '../lib/cli.ts';

handleScriptErrors();

const source = loadLocalEnvSource();
const env = loadEnv(['core', 'hedera', 'ens'], source);
const network = env.require('HEDERA_NETWORK') as 'testnet' | 'mainnet';
if (network !== 'testnet') throw new UsageError('the audit topic is created on testnet only');
const existing = env.get('HCS_TOPIC_ID');
if (existing !== undefined)
  throw new UsageError(`HCS_TOPIC_ID is already set (${existing}); one audit topic is enough`);

const payer = env.require('HEDERA_PAYER_ACCOUNT_ID');
const key = parsePrivateKey(
  env.require('HEDERA_PAYER_PRIVATE_KEY'),
  env.require('HEDERA_PAYER_KEY_TYPE') as KeyType,
);
const memo = `${env.require('ENS_PARENT_NAME')} agent audit: x402 settlements and task digests`;

console.log(`HCS audit topic on Hedera ${network}`);
console.log(`  memo        ${memo}`);
console.log(`  submit key  the payer's key (${payer}); only the agent can post`);
console.log('  admin key   none: the topic cannot be changed or deleted');
console.log(
  `  paid by     the payer account (about USD 0.01; at most ${Number(TOPIC_CREATE_MAX_FEE_TINYBARS) / 1e8} HBAR)`,
);
if (!hasFlag('--confirm')) {
  console.log('\ndry run: nothing was created. Re-run with -- --confirm to create it.');
  process.exit(0);
}

const client = createClient(network, payer, key);
let created: Awaited<ReturnType<typeof createTopic>>;
try {
  created = await createTopic(client, { memo, submitKey: key });
} catch (error) {
  client.close();
  const status = definiteFailureStatus(error);
  throw new UsageError(
    status === null
      ? `topic creation outcome unknown: ${error instanceof Error ? error.message : String(error)}. Check the payer's recent transactions on HashScan before retrying.`
      : `topic creation refused by Hedera (${status}); nothing was created. Fix the cause and run again.`,
  );
}
client.close();
console.log(`\ncreated topic ${created.topicId} (transaction ${created.transactionId})`);

// confirm on the Mirror Node: the topic exists with our memo and our submit key
const mirror = new MirrorNodeClient(env.require('HEDERA_MIRROR_NODE_URL'));
let topic: MirrorTopic | null = null;
for (let i = 0; i < 15 && topic === null; i++) {
  topic = await mirror.getTopic(created.topicId);
  if (topic === null) await new Promise((r) => setTimeout(r, 2_000));
}
const submitKeyMatches =
  topic?.submitKey !== null &&
  topic?.submitKey !== undefined &&
  topic.submitKey.key.toLowerCase().endsWith(publicKeyHex(key));
const verified = topic !== null && topic.memo === memo && !topic.deleted && submitKeyMatches;
console.log(
  verified
    ? 'Mirror Node: topic found, memo and submit key match.'
    : `Mirror Node: NOT confirmed (${topic === null ? 'topic not found yet' : 'memo or submit key differs'}).`,
);
const path = writeEvidence('hcs', verified ? 'hcs-topic' : 'hcs-topic-attempt', {
  kind: 'hcs-topic-create',
  verified,
  generatedAt: new Date().toISOString(),
  network,
  topicId: created.topicId,
  memo,
  submitKey: 'payer',
  payer,
  adminKey: null,
  transactionId: created.transactionId,
  hashscan: {
    topic: hashscanTopicUrl(network, created.topicId),
    transaction: hashscanTransactionUrl(network, created.transactionId),
  },
  mirror: topic,
});
console.log(`evidence: ${path}`);
console.log(
  `\nNext: add this line to .env, then restart the API:\nHCS_TOPIC_ID=${created.topicId}`,
);
