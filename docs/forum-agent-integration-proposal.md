# Forum agent integration proposal

[Issue #661](https://github.com/FyberLabs/s3r.ch/issues/661) requires design approval before implementation. This proposal changes how squad forum work enters the existing Plane, Visor, Host and Conductor path.

## Proposed decisions

- Give remote agents a dedicated enrollment and credential audience. Reuse the enrolled phone ingress's private TLS listener, same-owner grant checks, exact-byte admission and cancellation model. Bind the grant to the enrolled client, execution host, bot, assignment and current Visor session. Require a provisioned private connection for each remote client. Cursor and ChatGPT integrations depend on their ability to use that connection and keep a scoped enrollment credential in an approved client-side secret store.
- Run the forum adapter in Visor. Keep the forum bot SEA signing key in the adapter's private custody. Plane remains the authority for task delivery and status. s3r.ch checks the forum ACL and the current Plane binding before admitting a signed statement.
- Use the Plane bot assignment and session generation to fence delivery and posting. Keep Spanopticon tenant and roster records as eligibility inputs. A roster change revokes eligibility immediately, even if the Plane assignment generation has yet to change.
- Limit the new posting path to Plane-delivered squad agent tasks. Preserve the existing room integration scope in #151 and #447. Any additional direct forum integration needs its own scoped contract.

## One agent turn

1. s3r.ch verifies current forum ACL, squad membership and the requested assignee. Submit an assignment intent keyed by tenant, forum and source task ID. Plane admits work through its existing owner authorization and records the bot and Visor session. Treat repeated intake as the same intent, and reject conflicting reuse of the task ID.
2. The running Visor outbound worker claims the exact task under current local consent. The claim is scoped to the bot, assignment, session and connection. Preserve claim deadlines, consent-epoch cancellation and the current handling of uncertain dispatch. Forum pause requests an authorized Plane bot pause. Forum UI reflects its confirmed state. Resuming Plane delivery still requires current Visor consent.
3. Local coding work uses the Host machine bridge and Conductor's protected `POST /v1/machine/prompt-submit` socket. The owner admits the SHA-256 of the exact serialized operation bytes. An enrolled remote agent submits via its dedicated Conductor network endpoint after Visor has claimed the task. Plane verifies the remote grant and the same delivered operation digest before consuming it. Both routes keep the existing authenticated AIuditor review. Plane makes consumption durable across retries and cancels work when any active authorization expires or changes.
4. Visor sends a signed task update through s3r.ch admission using its bound bot principal. Admission checks task delivery, the current Plane binding and pause state, along with the forum ACL and existing signed history fence. A retry uses the same delivery ID and update sequence so it can reconcile a lost acknowledgment without duplicating a post. Bind admission to the current authority through commit and fail closed if that fence cannot be held. Use the Task-update card and existing bounded update text. Result content requires an explicit forum-visible projection and current reader scope. Credentials, prompts and private artifacts stay outside the post.

## Implementation slices after approval

| Owner | Issue and PR scope | PR CI contract |
| --- | --- | --- |
| Plane | Extend #112/#154 task delivery with forum correlation, current binding and pause information. Add dedicated remote-agent enrollment, same-owner grants and operation consumption. Split task and grant work into separate PRs. | Reject cross-owner, stale-session, expired and undelivered operations. Replayed intake and operation requests cannot create a second task or dispatch. |
| Conductor | Add enrolled agent ingress after Plane defines the grant and delivery contract. Reuse the enrolled phone request handling where the authentication boundaries permit it. | Wrong credential audience, interface or digest fails before review. Revocation cancels reviewed routing. |
| s3r.ch | Restate #654 as forum task intake and #655 as Plane-backed pause. Split intake, pause and statement admission into independently reviewable PRs. | Deny missing ACL, wrong roster, stale binding, paused posting and unavailable Plane. Test duplicate updates and pause during admission. |
| Visor | Integrate the squad binding work in #660 with Plane delivery. Add the signing adapter in Visor after the admission contract is available. The adapter consumes delivery-bound status and explicit shareable results. | Consent loss, session replacement or a late result cannot publish. Lost acknowledgments leave one visible update. |
| s3r.ch clients | Adapt #656 to the Conductor client path. Keep #659's update schema, validation, 180-character limit, card and pause refusal. Remove its standalone agent update entry point when the adapter lands. | The supported client entry points use Conductor admission. The standalone agent update command cannot bypass Plane. |

Use one issue and PR per slice, reusing the existing issues where their scope matches. Keep [Infra #2414](https://github.com/FyberLabs/infra/pull/2414) held through design review. The nightly forum scenario remains a follow-up note.

## Existing contracts

- [Visor remote bot polling](https://github.com/hyperme-sh/visor/blob/HEAD/docs/remote-bots.md) and [queued coding work](https://github.com/hyperme-sh/visor/blob/HEAD/docs/coding-tasks.md)
- [Conductor machine prompt ingress](https://github.com/hyperme-sh/conductor/blob/HEAD/docs/machine-prompt-ingress.md) and [enrolled phone prompt ingress](https://github.com/hyperme-sh/conductor/blob/HEAD/docs/phone-prompt-ingress.md)
- [Current forum bot worker](forum-bot-worker.md)
