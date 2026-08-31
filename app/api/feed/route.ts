import { getFeed } from "@/lib/rss3-feed";

export const dynamic = "force-dynamic";

export async function GET() {
  const feed = await getFeed();
  const empty =
    Boolean(feed.error) && feed.popular.length === 0 && feed.novel.length === 0;
  return Response.json(feed, {
    status: empty ? 503 : 200,
    headers: {
      "Cache-Control": "public, s-maxage=60, stale-while-revalidate=30",
    },
  });
}
