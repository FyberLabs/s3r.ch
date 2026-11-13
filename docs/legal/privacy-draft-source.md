# Privacy and Terms source

Issue #400 and the user-supplied `legal-drafts-2026-11-13.zip` are the business
sources. The implementation adapts `s3r.ch-privacy.md`, `s3r.ch-terms.md` and the
s3r.ch-specific counsel changes. It preserves the supplied account-link schedule
(active account plus deletion within 90 days after closure, with exceptions),
correspondence (2 years), logs (at least one year), and browser-session limits.
The approved second request method is postal mail to the operator's Knoxville
address; verification, response timing and appeals apply to mail and email alike.

The October technical descriptions in the drafts are stale: they describe all
server data as unbacked local disk lost on restart and wallet addresses as the
only identity. Those claims are not copied into the published pages. Current
code includes durable storage, protected SEA sessions and private grant paths.
The policy distinguishes public-network copies, private grants, browser-held
material and provider storage, and discloses the implemented first-party Azure
operational telemetry. It does not promise an absent classifier or advertise
future opt-in ads as a current feature. No retention automation is claimed by
this page change.

The supplied dispute-resolution, arbitration opt-out, Tennessee venue and
liability clauses remain in the Terms. Counsel may correct the text as directed
in #400. No human approval gate is introduced.

Primary references consulted:
- https://cppa.ca.gov/faq
- https://law.lis.virginia.gov/vacode/title59.1/chapter53/section59.1-577/
- https://law.lis.virginia.gov/vacode/title59.1/chapter53/section59.1-578/

Route/component tests cover content and legal navigation. Real page/404 HTTP
checks run in the existing CI image job, not on developer hosts.
