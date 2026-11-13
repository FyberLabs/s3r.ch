import type { Metadata } from "next";
import { PrivacyPreferences } from "@/components/PrivacyPreferences";
export const metadata: Metadata = { title: "Privacy Policy | s3r.ch" };
export default function PrivacyPage() {
  return <article className="mx-auto max-w-3xl space-y-5 px-6 py-12 text-sm leading-relaxed">
    <h1 className="text-3xl font-semibold">Privacy Policy</h1>
    <p>Effective date: November 13, 2026</p>
    <p>Fyber Labs TN LLC operates s3r.ch. This policy covers personal information we process through this website and its identity, feed, room and collaboration features. Our service is for adults 18 and older; no one under 18 may use it.</p>
    <h2 className="text-xl font-semibold">Categories, sources and purposes</h2>
    <ul className="list-disc space-y-2 pl-5">
      <li><strong>Identifiers and authentication:</strong> wallet addresses, public identity keys, sign-in messages and SIWE signatures, linked Hypermesh account information and credential-link records. We receive these from you, your wallet or your chosen identity provider to authenticate, recover and secure access.</li>
      <li><strong>Content and access choices:</strong> posts, room content, messages, files, profile information, verified claims (such as email or phone confirmation) and see-grants that you submit or choose to share. We use them to provide communication, collaboration, storage and access controls.</li>
      <li><strong>Public-network information:</strong> public identifiers, posts, links and timestamps from Farcaster, Bluesky/AT Protocol, Nostr, ActivityPub, RSS and Atom sources. We use them to assemble and refresh public feeds and preserve source attribution.</li>
      <li><strong>Technical and usage information:</strong> IP addresses, request and security metadata, errors, and first-party feature or experiment events when those features are enabled. We receive these from browsers and service infrastructure to deliver, secure and improve the service and diagnose failures.</li>
      <li><strong>Preferences and correspondence:</strong> local theme and reading preferences, and information you send in support or privacy requests. We use them to apply your choices and respond to you.</li>
    </ul>
    <p>We do not ask for your wallet seed phrase or private wallet key. Browser-held identity and recovery material may be stored locally in protected form. Public keys and wallet addresses are not secret; activity published on a public network may be visible outside s3r.ch.</p>
    <h2 className="text-xl font-semibold">Recipients and disclosures</h2>
    <p>Cloudflare processes network requests at our edge. Microsoft Azure and other infrastructure providers we engage process hosting, storage, security and operational data on our behalf. Hypermesh and Spanopticon services process identity, authorization and storage information needed by the features you use. First-party operational telemetry may be processed through Azure Application Insights.</p>
    <p>WalletConnect, Coinbase Smart Wallet, your wallet extension and your chosen identity provider can receive connection, account and network information when their services are used. Wallet and blockchain RPC providers may process requests from wallet connections. Their handling is governed by their own policies. Public-network providers process information you direct to them, and recipients you select can access content according to your sharing choices.</p>
    <p>If we have actual knowledge of apparent child sexual abuse material, we report it to the National Center for Missing &amp; Exploited Children (NCMEC) as required by law. We may disclose information in a life-threatening emergency where permitted by law or in response to valid legal process. We do not monitor all content and cannot guarantee detection of prohibited material.</p>
    <p>We may disclose information to meet legal obligations, respond to lawful process, protect rights or investigate abuse, and in a business transfer subject to applicable privacy protections. We limit disclosures to what the relevant purpose requires.</p>
    <h2 className="text-xl font-semibold">Sale, sharing and targeted advertising</h2>
    <p>We do not sell personal information or share it for cross-context behavioral advertising, as those terms are used in California law. We do not use personal information for targeted advertising or profiling that produces legal or similarly significant effects. Operational hosting and authentication disclosures described above are not advertising permissions.</p>
    <h2 className="text-xl font-semibold">Retention by category</h2>
    <p>We keep information only as needed for its stated purpose, legal obligations, security and dispute handling. Retention depends on the record category:</p>
    <ul className="list-disc space-y-2 pl-5">
      <li>Account identifiers and credential links: while needed to provide the account, recovery and security, and deleted within 90 days after account closure or deletion, except where legal obligations or necessary security records require longer retention.</li>
      <li>Authentication messages, signatures and replay records: until their authentication or replay-prevention purpose expires; wallet session cookies last up to 7 days, SEA proof sessions up to 5 minutes, and sign-in challenges last minutes. Necessary security investigation records follow the log schedule.</li>
      <li>Posts, room content and see-grants: while retained by your sharing or account choices; revocation and security records may remain where necessary to prevent old access from being restored.</li>
      <li>Public-feed caches: until refreshed, removed from the successfully fetched source window, or otherwise removed from our cache. Independent source networks keep their own records.</li>
      <li>Request logs, errors and operational events: for at least one year for security monitoring, incident investigation and audits, then deleted or archived under the applicable retention schedule.</li>
      <li>Local preferences and browser-held keys: until cleared or replaced in your browser; clearing them can affect access and recovery.</li>
      <li>Privacy and support correspondence: for 2 years, unless a legal obligation or active dispute requires longer retention.</li>
    </ul>
    <p>Deletion from our systems cannot delete independent public-network copies, blockchain history or content already saved by another recipient. We explain applicable exceptions when responding to a request.</p>
    <h2 className="text-xl font-semibold">California privacy rights</h2>
    <p>You may request to know or access personal information, delete it, correct inaccuracies, opt out of sale or sharing, and limit qualifying uses of sensitive personal information. We will not discriminate against you for exercising these rights. We do not use sensitive personal information to infer characteristics about you or for unrelated advertising.</p>
    <h2 className="text-xl font-semibold">Virginia privacy rights and appeals</h2>
    <p>You may request access, correction, deletion and a portable copy, and opt out of targeted advertising, sale and qualifying profiling. Where we process sensitive data subject to Virginia’s consent requirement, we obtain opt-in consent before that processing. You can withdraw consent by contacting us.</p>
    <p>To appeal a denied request, email <a className="underline" href="mailto:legal@s3r.ch?subject=Privacy%20appeal">legal@s3r.ch</a> with the subject “Privacy appeal.” We respond in writing within 60 days, explaining the decision. If the appeal is denied, you may contact the <a className="underline" href="https://www.oag.state.va.us/consumer-protection/">Virginia Attorney General</a>.</p>
    <h2 className="text-xl font-semibold">Request methods, verification and authorized agents</h2>
    <p>Email <a className="underline" href="mailto:legal@s3r.ch?subject=Privacy%20request">legal@s3r.ch</a> to exercise your rights, ask for an export or deletion, report a child’s use, or ask a privacy question. Describe the request and information needed to locate your account. Do not include private keys or recovery secrets.</p>
    <p>You can also send a written privacy request by postal mail to <strong>Fyber Labs TN LLC, 116 Agnes Rd, Ste 200, Knoxville, TN 37919</strong>. Mailed requests follow the same verification, response timing and Virginia appeal process as email. You may appeal by email or by writing to that postal address marked “Privacy appeal.”</p>
    <p>We use proportionate verification to prevent disclosure or deletion by an impostor. An authorized agent may submit a request with proof of your permission; we may also verify your identity where permitted. We acknowledge California requests to know, delete or correct within 10 business days and generally respond to verified rights requests within 45 calendar days. If a permitted extension is needed, we explain it within that initial period; an extension is limited to 45 additional days. Requests are ordinarily free; statutory exceptions may apply to excessive or unfounded requests.</p>
    <h2 className="text-xl font-semibold">Global Privacy Control, Do Not Track and browser storage</h2>
    <PrivacyPreferences />
    <p>We treat Global Privacy Control as an opt-out of sale and sharing. Those activities are off for everyone. Browser Do Not Track signals do not change our essential authentication, security or service processing; there is no agreed universal interpretation of that signal. We do not treat either signal as permission to start tracking.</p>
    <p>We use necessary session cookies and browser storage for sign-in, security and your preferences. Wallet and identity providers may use their own storage when you choose their services. Clearing storage or blocking necessary cookies can prevent sign-in or recovery. We do not add advertising pixels through this policy.</p>
    <h2 className="text-xl font-semibold">Changes and contact</h2>
    <p>We publish updates here with a new effective date and provide additional notice when required. We operate in the United States, and sharing with other participants or providers can transfer information internationally. Report security concerns to security@s3r.ch and bugs to bugs@s3r.ch. Contact Fyber Labs TN LLC at <a className="underline" href="mailto:legal@s3r.ch">legal@s3r.ch</a>. See also our <a className="underline" href="/terms">Terms of Use</a>.</p>
  </article>;
}
