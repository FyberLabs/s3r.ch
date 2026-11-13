
The server-only `createAclDelegationSource` adapter reads the separately provisioned
ACL delegation endpoint for the existing agent session engine. It requires explicit
service configuration, audience and independently trusted witness policy; responses
cannot install trust or turn missing owner history into an empty genesis history.
It shares bounded HTTPS transport with statement reads and re-evaluates the current
owner histories for each request. It does not enable a public agent session route,
provision delegation scopes or replace the agent key-possession challenge and
object permission checks. Deployment activation remains separate.
