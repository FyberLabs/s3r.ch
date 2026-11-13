import type { Metadata } from "next";
export const metadata: Metadata = { title: "Terms of Use | s3r.ch" };
export default function TermsPage() {
  return <article className="mx-auto max-w-3xl space-y-5 px-6 py-12 text-sm leading-relaxed">
    <h1 className="text-3xl font-semibold">Terms of Use</h1>
    <p>Effective date: November 13, 2026</p>
    <p>Fyber Labs TN LLC operates s3r.ch. These Terms govern your use of the website and its social, identity and collaboration features. By using s3r.ch, you agree to these Terms. If you do not agree, do not use the service.</p>
    <h2 className="text-xl font-semibold">18+ only</h2>
    <p>You must be at least 18 years old to use s3r.ch. No one under 18 may use the service. You must have authority to accept these Terms for any organization you represent.</p>
    <h2 className="text-xl font-semibold">Your identity and account</h2>
    <p>Keep your sign-in credentials, wallet and recovery material secure. Never send us private wallet keys, seed phrases or recovery secrets. Signing an authentication message proves control of a credential; it is not a purchase or permission for us to transfer your assets. Review messages and transactions before signing. Tell us promptly if you believe your account has been compromised.</p>
    <h2 className="text-xl font-semibold">Your content and sharing choices</h2>
    <p>You retain ownership of your content. You give us permission to host, process, display and transmit it as necessary to operate the features you choose, including your sharing instructions. You must have the rights and permissions needed to submit it. Do not upload another person’s sensitive information without an appropriate legal basis and any required consent.</p>
    <p>Sharing with public networks can make content available to other people and services. Unsharing or deleting our copy cannot remove independent copies, blockchain records or material another recipient has already saved. Access controls limit future access; they cannot make a recipient forget information already received.</p>
    <h2 className="text-xl font-semibold">Acceptable use</h2>
    <p>Do not use the service for unlawful activity, harassment, threats, fraud, exploitation, malware or infringement. Do not impersonate others, bypass access controls, misuse another person’s credentials, or interfere with service security or availability. A bot or agent acting for you must stay within the authority you actually granted; a forum message alone does not confer tool permissions.</p>
    <h2 className="text-xl font-semibold">Other services and automated output</h2>
    <p>Wallet providers, identity providers, public networks and other services you choose have their own terms and policies. We do not control their availability or content. Automated or agent-generated output may be inaccurate; review it before relying on it or authorizing consequential actions.</p>
    <h2 className="text-xl font-semibold">Availability and enforcement</h2>
    <p>We may change features, restrict misuse or suspend access to protect users, comply with law or enforce these Terms. We do not promise uninterrupted service or that every distributed copy can be recovered or erased. Keep appropriate backups of material important to you.</p>
    <h2 className="text-xl font-semibold">Disclaimers and responsibility</h2>
    <p>To the extent permitted by law, the service is provided as available without warranties of merchantability, fitness for a particular purpose or non-infringement. To that same extent, Fyber Labs TN LLC is not liable for indirect, incidental, special or consequential losses arising from use of the service. Nothing here excludes liability or consumer rights that cannot lawfully be excluded.</p>
    <h2 className="text-xl font-semibold">Privacy, changes and contact</h2>
    <p>Our <a className="underline" href="/privacy">Privacy Policy</a> explains how we handle personal information and requests. We will publish changes to these Terms here with an updated effective date and provide additional notice when required. Contact <a className="underline" href="mailto:legal@s3r.ch">legal@s3r.ch</a> about these Terms, misuse or rights concerns.</p>
  </article>;
}
