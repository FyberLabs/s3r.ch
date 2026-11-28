/** Direct recovery's witness/proof binding, separate from conflict evidence.
 * Owner-chain rotation verification ships in sociacl-ids 0.12.0; until then this
 * refuses all proof-binding work so local shims cannot mint authority.
 */
export async function verifyForumRotationProofBinding(_input: unknown, _now: number): Promise<null> {
  return null;
}