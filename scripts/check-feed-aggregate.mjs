import { aggregateActivities } from "../lib/rss3-feed.ts";

const fixture = [
  {
    id: "tx-repeat-1",
    network: "ethereum",
    tag: "transaction",
    type: "transfer",
    timestamp: 1_700_000_100,
    to: "0x1111111111111111111111111111111111111111",
    actions: [
      {
        tag: "transaction",
        type: "transfer",
        to: "0x1111111111111111111111111111111111111111",
        metadata: {
          address: "0x1111111111111111111111111111111111111111",
          symbol: "POP",
          value: "10",
        },
        related_urls: ["https://etherscan.io/tx/1"],
      },
    ],
  },
  {
    id: "tx-repeat-2",
    network: "ethereum",
    tag: "transaction",
    type: "transfer",
    timestamp: 1_700_000_200,
    to: "0x1111111111111111111111111111111111111111",
    actions: [
      {
        tag: "transaction",
        type: "transfer",
        to: "0x1111111111111111111111111111111111111111",
        metadata: {
          address: "0x1111111111111111111111111111111111111111",
          symbol: "POP",
          value: "5",
        },
        related_urls: ["https://etherscan.io/tx/2"],
      },
    ],
  },
  {
    id: "social-once",
    network: "farcaster",
    platform: "Farcaster",
    tag: "social",
    type: "post",
    timestamp: 1_700_000_300,
    actions: [
      {
        tag: "social",
        type: "post",
        metadata: {
          handle: "novelist",
          title: "hello",
          target_url: "https://example.com/p/1",
        },
        related_urls: ["https://example.com/p/1"],
      },
    ],
  },
];

const { popular, novel } = aggregateActivities(fixture);
if (popular.length !== 1 || popular[0].label !== "POP" || popular[0].count !== 2) {
  throw new Error(`popular failed: ${JSON.stringify(popular)}`);
}
if (novel.length !== 1 || novel[0].label !== "@novelist" || novel[0].novelty !== "first-seen") {
  throw new Error(`novel failed: ${JSON.stringify(novel)}`);
}
console.log("aggregate ok", { popular: popular[0].label, novel: novel[0].label });
