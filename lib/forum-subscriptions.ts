import type { FeedGun } from "../components/GunPeerProvider";

type Receive = (data: unknown, key?: string) => void;
type Subscription = { off(): void };

/** Untrusted graph transport. Consumers still verify signatures and current Check decisions. */
export function createForumSubscriptions(gun: FeedGun, forumId: string) {
  let closed = false;
  const active = new Set<Subscription>();
  const forum = ["s3rch", "forums", forumId];

  function watch(path: string[], mapped: boolean, receive: Receive): Subscription {
    let stopped = closed;
    let source: { off?: () => void } | undefined;
    const subscription: Subscription = {
      off() {
        if (stopped) return;
        stopped = true;
        active.delete(subscription);
        source?.off?.();
      },
    };
    if (closed) return subscription;
    active.add(subscription);
    try {
      let node = gun;
      for (const segment of path) node = node.get(segment);
      const deliver: Receive = (data, key) => {
        if (!closed && !stopped) receive(data, key);
      };
      source = mapped ? node.map().on(deliver) : node.on(deliver);
      // A synchronous first notification can close the transport before on returns.
      if (stopped) source?.off?.();
      return subscription;
    } catch (error) {
      subscription.off();
      throw error;
    }
  }

  return {
    agents: (receive: Receive) => watch([...forum, "agents"], true, receive),
    template: (receive: Receive) => watch([...forum, "template"], false, receive),
    roles: (receive: Receive) => watch([...forum, "roles"], true, receive),
    roleMembers: (role: string, receive: Receive) => watch([...forum, "roles", role], true, receive),
    needs: (receive: Receive) => watch([...forum, "needs"], true, receive),
    alarm: (receive: Receive) => watch([...forum, "alarm"], false, receive),
    items: (receive: Receive) => watch(["s3rch", "items"], true, receive),
    itemRemoval: (id: string, receive: Receive) => watch(["s3rch", "items", id, "remove"], false, receive),
    needRemoval: (id: string, receive: Receive) => watch([...forum, "needs", id, "remove"], false, receive),
    offers: (need: string, receive: Receive) => watch([...forum, "needs", need, "offers"], true, receive),
    offerCancel: (need: string, offer: string, receive: Receive) => watch([...forum, "needs", need, "offers", offer, "cancel"], false, receive),
    offerRemoval: (need: string, offer: string, receive: Receive) => watch([...forum, "needs", need, "offers", offer, "remove"], false, receive),
    agentRemoval: (pub: string, receive: Receive) => watch([...forum, "agents", pub, "remove"], false, receive),
    agentAdmission: (pub: string, receive: Receive) => watch([...forum, "agents", pub, "admission"], false, receive),
    close() {
      if (closed) return;
      closed = true;
      for (const subscription of active) subscription.off();
    },
  };
}
